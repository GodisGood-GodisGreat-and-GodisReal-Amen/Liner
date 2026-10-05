#!/usr/bin/env node
// Liner — local server.
// Serves the UI, ingests songs (ffprobe metadata, cover extraction, exact PCM decode),
// and finishes renders: the browser streams encoded video (or raw frames) here, the
// server concatenates the songs' PCM with the gaps and muxes everything with ffmpeg.
// Zero dependencies. Requires ffmpeg + ffprobe on PATH.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Worker } from 'node:worker_threads';
import { initSprites, listSprites, getSprite, registerSprite, createSprite, addSource, buildSprite, deleteSprite, renameSprite, publicSprite, spriteDir } from './sprites.mjs';
import { ANALYSIS_VERSION, SPECTRUM_VERSION } from './analysis.mjs';
import { initBackgrounds, listBackgrounds, getBackground, ingestBackground, ingestBackgroundFromPath, restoreBackground, deleteBackground, backgroundDir, backgroundJobs } from './backgrounds.mjs';
import { MIDI_EXT, midiOffset, parseMidi, initMidi, renderMidi, drawPianoRoll, describeRenderer, midiCaps } from './midi.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, '.cache');
const SONGS = path.join(CACHE, 'songs');
const RENDERS = path.join(CACHE, 'renders');
const SPRITES = path.join(CACHE, 'sprites');
const LOGOS = path.join(CACHE, 'logos');
const BACKGROUNDS = path.join(CACHE, 'backgrounds');
const MIXES = path.join(ROOT, 'Mixes'); // saved copies of mixes, with their songs and media
const EXPORTS = path.join(ROOT, 'Exports');
const DOWNLOADS = path.join(ROOT, 'Downloads');
const PORT = Number(process.env.PORT) || 8865;
const APP_VERSION = '1.1.1'; // bumped with every release; public/app.js carries the same string and the page compares the two
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const SAMPLE_RATE = 48000;
const BYTES_PER_FRAME = 6; // stereo s24le

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- helpers
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function readJson(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('The request is too large.'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
// the file name an upload carries in its X-File-Name header (percent-encoded by the page)
function headerName(req, fallback) {
  try { return decodeURIComponent(req.headers['x-file-name'] || fallback); } catch { throw Object.assign(new Error('Bad file name header.'), { status: 400 }); }
}
// Only the page this server serves may change anything. The server listens on the loopback interface only, but a
// web page from any other site could still fire a cross-site POST at localhost; browsers mark those with an Origin
// and a Sec-Fetch-Site header, and such requests are refused. Tools like curl send neither and are let through.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
    return local && String(u.port || (u.protocol === 'https:' ? 443 : 80)) === String(PORT);
  } catch { return false; }
}
const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) { err.stderr = stderr; reject(err); } else resolve({ stdout, stderr });
    });
  });
}
const safeName = (s) => String(s || '').replace(/[\/\\:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
const fmtBytes = (n) => n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';

// ---------------------------------------------------------------- capabilities
const caps = { h264: null, hevc: null, aac: null, alac: null, ffmpeg: null, ytdlp: null, x264: false, midi: midiCaps };
async function detectCapabilities() {
  try {
    const { stdout: v } = await run(FFMPEG, ['-hide_banner', '-version']);
    caps.ffmpeg = (v.match(/ffmpeg version (\S+)/) || [])[1] || 'unknown';
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
    const has = (name) => new RegExp(`^\\s*[AVS][\\w.]{5}\\s+${name}\\s`, 'm').test(stdout);
    caps.h264 = has('h264_videotoolbox') ? 'h264_videotoolbox' : has('libx264') ? 'libx264' : null;
    caps.hevc = has('hevc_videotoolbox') ? 'hevc_videotoolbox' : has('libx265') ? 'libx265' : null;
    caps.x264 = has('libx264'); // preferred for background videos: exact keyframe spacing and no B-frames
    caps.aac = has('aac_at') ? 'aac_at' : has('aac') ? 'aac' : null;
    caps.alac = has('alac_at') ? 'alac_at' : has('alac') ? 'alac' : null;
  } catch (e) {
    caps.ffmpeg = null;
    log('ffmpeg not found:', e.message);
  }
  for (const bin of [process.env.YTDLP, 'yt-dlp', '/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', path.join(os.homedir(), '.local/bin/yt-dlp')].filter(Boolean)) {
    try { const { stdout } = await run(bin, ['--version']); caps.ytdlp = stdout.trim(); ytdlpBin = bin; break; } catch { /* try the next location */ }
  }
}

// ---------------------------------------------------------------- songs
const songs = new Map(); // id -> meta
const songDir = (id) => path.join(SONGS, id);
async function saveMeta(meta) { await fsp.writeFile(path.join(songDir(meta.id), 'meta.json'), JSON.stringify(meta, null, 1)); }
function publicMeta(m) {
  const { id, fileName, title, artist, album, duration, sampleRate, channels, codec, bits, cover, coverVersion, customCover, ready, error, exactDuration, samples, createdAt, size, coverMode, coverInfo } = m;
  const ownReady = m.ownVideoStatus === 'ready' && m.ownVideo && getBackground(m.ownVideo) && getBackground(m.ownVideo).ready;
  // a song made from a MIDI file says which synthesizer rendered it
  const midi = m.midi ? { status: m.midi.status, renderer: m.midi.renderer || null, soundfont: m.midi.soundfont || null, tracks: m.midi.tracks, notes: m.midi.notes, tempo: m.midi.tempo, about: m.midi.renderer ? describeRenderer(m.midi.renderer, m.midi.soundfont) : null } : null;
  return {
    id, fileName, title, artist, album, duration, sampleRate, channels, codec, bits, cover, coverVersion, customCover, ready, error, exactDuration, samples, createdAt, size, coverMode: coverMode || (cover ? 'embedded' : 'none'), coverInfo: coverInfo || null, midi,
    // the song's own video: the picture of the file it came from, or the video behind the link it was downloaded from, prepared on request
    hasVideo: !!m.hasVideo, videoSource: m.hasVideo ? 'file' : m.sourceUrl ? 'link' : null, ownVideo: ownReady ? m.ownVideo : null, ownVideoStatus: ownReady ? 'ready' : m.ownVideoStatus === 'preparing' ? 'preparing' : m.ownVideoStatus === 'error' ? 'error' : 'none', ownVideoError: m.ownVideoError || null,
  };
}
async function loadSongs() {
  const ids = await fsp.readdir(SONGS).catch(() => []);
  for (const id of ids) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(songDir(id), 'meta.json'), 'utf8'));
      songs.set(id, meta);
      if (!meta.ready && !meta.error) queueDecode(meta);
    } catch { /* ignore broken entries */ }
  }
  log(`${songs.size} song(s) in cache`);
  // songs from before videos were kept: find out once whether their file has a picture track
  for (const meta of songs.values()) {
    if (meta.hasVideo !== undefined || !meta.src) continue;
    try { meta.hasVideo = !!(await probeFile(path.join(songDir(meta.id), meta.src))).meta.hasVideo; } catch { meta.hasVideo = false; }
    if (!meta.ownVideoStatus) meta.ownVideoStatus = 'none';
    await saveMeta(meta).catch(() => {});
  }
}

function titleFromFileName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
  const m = base.match(/^\s*\d{1,3}\s*[.\-–)]?\s+(.*)$/);
  let t = (m ? m[1] : base).trim();
  let artist = '';
  const parts = t.split(/\s+[-–—]\s+/);
  if (parts.length >= 2) { artist = parts[0].trim(); t = parts.slice(1).join(' - ').trim(); }
  return { title: t || base, artist };
}

async function probeFile(src) {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', src]);
  const info = JSON.parse(stdout);
  const streams = info.streams || [];
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!audio) throw Object.assign(new Error('The file has no audio stream.'), { status: 415 });
  const tags = {};
  for (const t of [info.format && info.format.tags, audio.tags]) if (t) for (const [k, v] of Object.entries(t)) tags[k.toLowerCase()] = String(v).trim();
  const isPic = (s) => (s.disposition && s.disposition.attached_pic === 1) || ['mjpeg', 'png', 'bmp', 'gif', 'webp', 'tiff'].includes(s.codec_name);
  const pic = streams.find((s) => s.codec_type === 'video' && isPic(s));
  const movie = streams.find((s) => s.codec_type === 'video' && !isPic(s) && +s.nb_frames !== 1); // a real picture track, not cover art
  const duration = parseFloat(info.format && info.format.duration) || parseFloat(audio.duration) || 0;
  return {
    meta: {
      title: tags.title || '', artist: tags.artist || tags.album_artist || tags['album artist'] || '', album: tags.album || '',
      duration, sampleRate: +audio.sample_rate || 0, channels: +audio.channels || 0, codec: audio.codec_name || '',
      bits: +(audio.bits_per_raw_sample || audio.bits_per_sample) || 0, hasVideo: !!movie,
    },
    coverStream: pic ? pic.index : null,
  };
}

const COVER_VF = "scale='min(1400,iw)':'min(1400,ih)':force_original_aspect_ratio=decrease:flags=lanczos";
async function extractCover(src, streamIndex, out) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-map', `0:${streamIndex}`, '-frames:v', '1', '-vf', COVER_VF, '-f', 'image2', '-update', '1', '-c:v', 'png', out]);
}
async function convertImage(src, out) {
  await run(FFMPEG, ['-y', '-v', 'error', '-i', src, '-frames:v', '1', '-vf', COVER_VF, '-f', 'image2', '-update', '1', '-c:v', 'png', out]);
}
async function imageSize(file) {
  try { const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]); const [w, h] = stdout.trim().split(',').map(Number); return w && h ? { w, h } : null; }
  catch { return null; }
}
async function setCoverInfo(meta, dir, label, extra = {}) {
  const size = await imageSize(path.join(dir, 'cover-embedded.png')).catch(() => null);
  meta.coverInfo = { label, w: size ? size.w : 0, h: size ? size.h : 0, ...extra };
}

async function ingestUpload(req, fileName) {
  const tmp = path.join(CACHE, 'upload-' + crypto.randomBytes(4).toString('hex'));
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    return await ingestPath(tmp, fileName, { move: true });
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

// Registers an audio file as a song: probes its tags, extracts the cover and queues the exact decode.
// Uploads are moved into the cache; downloaded files are copied so the WAV stays in Downloads/.
async function ingestPath(srcPath, fileName, { move = false, title, artist, album, coverPath, sourceUrl = null, id = null } = {}) {
  id = id && /^[a-f0-9]{12}$/.test(id) && !songs.has(id) ? id : crypto.randomBytes(6).toString('hex');
  const dir = songDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const ext = (path.extname(fileName) || '.bin').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  const srcName = 'source' + ext;
  const src = path.join(dir, srcName);
  try {
    if (move) { try { await fsp.rename(srcPath, src); } catch { await fsp.copyFile(srcPath, src); } }
    else await fsp.copyFile(srcPath, src);
    const st = await fsp.stat(src);
    const meta = {
      id, fileName, src: srcName, size: st.size, title: '', artist: '', album: '', duration: 0, sampleRate: 0, channels: 0, codec: '', bits: 0,
      cover: false, coverVersion: 0, customCover: false, ready: false, error: null, exactDuration: null, samples: null, createdAt: Date.now(),
      hasVideo: false, sourceUrl, ownVideo: null, ownVideoStatus: 'none', ownVideoError: null,
    };
    // a MIDI file holds notes, not sound: it is rendered to audio in the decode queue (midi.mjs) and its notes become the cover
    const head = Buffer.alloc(4096);
    { const fh = await fsp.open(src, 'r'); try { await fh.read(head, 0, head.length, 0); } finally { await fh.close(); } }
    if (midiOffset(head) >= 0 || MIDI_EXT.test(ext)) {
      if (st.size > 16 * 1024 * 1024) throw Object.assign(new Error('The MIDI file is too large.'), { status: 413 });
      const parsed = parseMidi(await fsp.readFile(src));
      if (!parsed.noteCount || parsed.duration <= 0.05) throw Object.assign(new Error('The MIDI file has no notes.'), { status: 415 });
      meta.midi = { status: 'pending', tracks: parsed.trackCount, notes: parsed.noteCount, tempo: parsed.tempo, length: parsed.duration, copyright: parsed.copyright || '' };
      Object.assign(meta, { duration: parsed.duration, sampleRate: SAMPLE_RATE, channels: 2, codec: 'midi', bits: 24, title: title || parsed.title, artist: artist || '', album: album || '', coverMode: 'none', coverInfo: null });
      if (!meta.title) { const g = titleFromFileName(fileName); meta.title = g.title; if (!meta.artist) meta.artist = g.artist; }
      songs.set(id, meta);
      await saveMeta(meta);
      queueDecode(meta);
      return meta;
    }
    const probe = await probeFile(src);
    Object.assign(meta, probe.meta);
    if (title) meta.title = title;
    if (artist) meta.artist = artist;
    if (album) meta.album = album;
    if (!meta.title) { const g = titleFromFileName(fileName); meta.title = g.title; if (!meta.artist) meta.artist = g.artist; }
    const embedded = path.join(dir, 'cover-embedded.png');
    meta.coverMode = 'none'; meta.coverInfo = null;
    try {
      const fromLink = !!(coverPath && fs.existsSync(coverPath));
      if (fromLink) await convertImage(coverPath, embedded);
      else if (probe.coverStream != null) await extractCover(src, probe.coverStream, embedded);
      if (fs.existsSync(embedded)) {
        await fsp.copyFile(embedded, path.join(dir, 'cover.png'));
        meta.cover = true; meta.coverVersion = 1; meta.coverMode = fromLink ? 'link' : 'embedded';
        await setCoverInfo(meta, dir, fromLink ? 'Thumbnail from the link' : 'Embedded in the file');
      }
    } catch (e) { log('cover extraction failed for', fileName, (e.stderr || e.message).slice(0, 200)); }
    songs.set(id, meta);
    await saveMeta(meta);
    queueDecode(meta);
    return meta;
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    throw e;
  }
}

// Exact decode: one ffmpeg pass produces the s24le/48k PCM used for the final mix and a small AAC preview for the browser.
let decodeChain = Promise.resolve();
function queueDecode(meta) { decodeChain = decodeChain.then(() => decode(meta)).catch(() => {}); }
async function decode(meta) {
  if (!songs.has(meta.id)) return;
  const dir = songDir(meta.id);
  let src = path.join(dir, meta.src);
  const pcm = path.join(dir, 'pcm.raw');
  const prev = path.join(dir, 'preview.m4a');
  const aac = caps.aac || 'aac';
  try {
    if (meta.midi) { // render the notes first (once), and draw them as the cover unless one was chosen already
      const wav = path.join(dir, 'render.wav');
      if (meta.midi.status !== 'rendered' || !fs.existsSync(wav)) {
        const r = await renderMidi(src, wav);
        Object.assign(meta.midi, { status: 'rendered', renderer: r.renderer, soundfont: r.soundfont, seconds: r.seconds });
        log(`song ${meta.id}: MIDI rendered with ${describeRenderer(r.renderer, r.soundfont)} (${r.seconds.toFixed(1)} s)`);
        if (!meta.cover) {
          try {
            const parsed = parseMidi(await fsp.readFile(src)), embedded = path.join(dir, 'cover-embedded.png');
            const size = await drawPianoRoll(parsed, embedded);
            await fsp.copyFile(embedded, path.join(dir, 'cover.png'));
            Object.assign(meta, { cover: true, coverVersion: (meta.coverVersion || 0) + 1, coverMode: 'midi', coverInfo: { label: 'Piano roll of the notes', w: size.w, h: size.h } });
          } catch (e) { log('piano roll failed for', meta.fileName, e.message); }
        }
        if (songs.has(meta.id)) await saveMeta(meta);
      }
      src = wav;
    }
    await run(FFMPEG, ['-y', '-v', 'error', '-i', src,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 's24le', '-c:a', 'pcm_s24le', pcm,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', String(SAMPLE_RATE), '-c:a', aac, '-b:a', '160k', '-movflags', '+faststart', prev]);
    const st = await fsp.stat(pcm);
    meta.samples = Math.floor(st.size / BYTES_PER_FRAME);
    meta.exactDuration = meta.samples / SAMPLE_RATE;
    meta.duration = meta.exactDuration;
    meta.ready = true;
    meta.error = null;
  } catch (e) {
    meta.error = meta.midi && e.status ? e.message : 'Could not decode this file.';
    log('decode failed for', meta.fileName, String(e.stderr || e.message).slice(0, 300));
  }
  if (songs.has(meta.id)) await saveMeta(meta);
}

// ---------------------------------------------------------------- a song's own video
// The picture of the file a song was imported from (kept in its folder), or the video behind the link it was
// downloaded from (fetched now, up to 1080p), turned into a background-store entry so the song can show it.
const ownVideoJobs = new Map();
function prepareOwnVideo(meta) {
  const existing = meta.ownVideoStatus === 'ready' && meta.ownVideo && getBackground(meta.ownVideo);
  if (existing && existing.ready) return;
  if (ownVideoJobs.has(meta.id)) return;
  const dir = songDir(meta.id);
  meta.ownVideoStatus = 'preparing'; meta.ownVideoError = null;
  let tmpDir = null;
  const job = (async () => {
    let src, keep;
    if (meta.hasVideo) { src = path.join(dir, meta.src); keep = true; }
    else if (meta.sourceUrl) {
      if (!ytdlpBin) throw Object.assign(new Error('yt-dlp is not installed.'), { status: 501 });
      if (/soundcloud\.com|bandcamp\.com/i.test(meta.sourceUrl)) throw Object.assign(new Error('This link is sound only; there is no video to fetch.'), { status: 415 });
      tmpDir = path.join(dir, 'video-download');
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(tmpDir, { recursive: true });
      await run(ytdlpBin, ['--no-playlist', '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mp4', '-o', path.join(tmpDir, 'video.%(ext)s'), '--quiet', '--no-warnings', '--no-mtime', '--', meta.sourceUrl]);
      const f = (await fsp.readdir(tmpDir)).find((n) => n.startsWith('video.'));
      if (!f) throw Object.assign(new Error('The link gave no video.'), { status: 415 });
      src = path.join(tmpDir, f); keep = false;
    } else throw Object.assign(new Error('This song has no video of its own.'), { status: 409 });
    const bg = await ingestBackgroundFromPath(src, meta.title || meta.fileName, { keepSource: keep });
    await backgroundJobs.get(bg.id);
    if (bg.error) { // nothing usable came of it: drop the failed entry and say what happened in the song's own words
      deleteBackground(bg.id).catch(() => {});
      throw Object.assign(new Error(/no picture/i.test(bg.error) ? (keep ? 'The imported file has no picture track, only sound.' : 'The link gave sound only; there is no video to use.') : bg.error), { status: 415 });
    }
    if (meta.ownVideo && meta.ownVideo !== bg.id) deleteBackground(meta.ownVideo).catch(() => {});
    meta.ownVideo = bg.id; meta.ownVideoStatus = 'ready';
    if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    log(`song ${meta.id}: own video ready (${bg.id})`);
  })().catch((e) => {
    if (tmpDir) fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    meta.ownVideoStatus = 'error';
    meta.ownVideoError = e.status ? e.message : 'The video could not be prepared.';
    log(`song ${meta.id}: own video failed — ${String(e.stderr ? String(e.stderr).trim().split('\n').pop() : e.message || e).slice(0, 200)}`);
  }).finally(async () => { ownVideoJobs.delete(meta.id); if (songs.has(meta.id)) await saveMeta(meta).catch(() => {}); });
  ownVideoJobs.set(meta.id, job);
  saveMeta(meta).catch(() => {});
}

// ---------------------------------------------------------------- saved mixes (a safeguard beside the automatic saves)
// A saved mix is a folder: mix.json (the mix exactly as the page keeps it) next to copies of everything it uses —
// each song's original file and cover, the dancers' sprite atlases, the logo, the background videos. Loading one
// puts the media back into the caches under the same ids, so the saved mix is valid as it is.
const MIX_FORMAT = 'liner-mix';
async function dirBytes(dir) {
  let n = 0;
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) { const f = path.join(dir, e.name); n += e.isDirectory() ? await dirBytes(f) : (await fsp.stat(f).catch(() => ({ size: 0 }))).size; }
  return n;
}
async function listSavedMixes() {
  const out = [];
  for (const name of await fsp.readdir(MIXES).catch(() => [])) {
    const dir = path.join(MIXES, name);
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, 'mix.json'), 'utf8'));
      if (m.format !== MIX_FORMAT) continue;
      out.push({ name, path: dir, title: m.title || '', savedAt: m.savedAt || 0, songs: (m.state && m.state.songs || []).length, bytes: await dirBytes(dir) });
    } catch { /* not a saved mix */ }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}
// Opens an exported file with the system's player, or shows it in the file manager (Finder, Explorer, or the
// folder on a Linux desktop). A failure is only logged: the file is on disk either way.
function openInSystem(file, reveal) {
  const done = (err) => { if (err && err.code === 'ENOENT') log('could not open', file, err.message); };
  if (process.platform === 'darwin') execFile('open', reveal ? ['-R', file] : [file], done);
  else if (process.platform === 'win32') execFile('explorer.exe', [reveal ? `/select,${file}` : file], done);
  else execFile('xdg-open', [reveal ? path.dirname(file) : file], done);
}
// the Mac's own folder chooser; null when the person cancels (other systems have no chooser yet)
function chooseFolder(prompt) {
  if (process.platform !== 'darwin') return Promise.reject(Object.assign(new Error('Choosing a folder is only available on macOS for now. Use Liner’s own Mixes folder instead.'), { status: 501 }));
  return new Promise((resolve) => {
    execFile('osascript', ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`], { timeout: 10 * 60 * 1000 }, (err, stdout) => {
      if (err) return resolve(null);
      const p = String(stdout).trim();
      resolve(p ? p.replace(/\/$/, '') : null);
    });
  });
}
const stampName = (title) => `${safeName(title) || 'Untitled mix'} — ${new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', '.')}`;
async function saveMix(body) {
  const st = body && body.state && typeof body.state === 'object' ? body.state : null;
  if (!st || !Array.isArray(st.songs)) throw Object.assign(new Error('There is no mix to save.'), { status: 400 });
  const title = String(body.title || st.title || 'Untitled mix').slice(0, 120);
  let base = MIXES;
  if (body.where === 'ask') { base = await chooseFolder('Save the mix in…'); if (!base) return { cancelled: true }; }
  await fsp.mkdir(base, { recursive: true });
  const dir = path.join(base, stampName(title));
  await fsp.mkdir(dir, { recursive: true });
  const warnings = [], media = { songs: [], sprites: [], logos: [], backgrounds: [] };
  const copy = async (from, to) => { await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.copyFile(from, to); };
  for (const s of st.songs) {
    const m = songs.get(String(s.id || ''));
    if (!m) { warnings.push(`“${s.title || 'A song'}” is no longer in the cache; it was saved by name only.`); continue; }
    const file = `songs/${m.id}${path.extname(m.src || '') || '.bin'}`;
    try { await copy(path.join(songDir(m.id), m.src), path.join(dir, file)); } catch { warnings.push(`The file of “${m.title || s.title}” could not be copied.`); continue; }
    const entry = { id: m.id, file, meta: { fileName: m.fileName, title: m.title, artist: m.artist, album: m.album, sourceUrl: m.sourceUrl || null, coverMode: m.coverMode || null, customCover: !!m.customCover, coverInfo: m.coverInfo || null } };
    if (m.cover) { try { await copy(path.join(songDir(m.id), 'cover.png'), path.join(dir, `covers/${m.id}.png`)); entry.cover = `covers/${m.id}.png`; } catch { /* no cover copied */ } }
    media.songs.push(entry);
  }
  for (const d of st.dancers || []) {
    const sp = d && getSprite(d.spriteId);
    if (!sp) { warnings.push('A dancer’s sprite is no longer in the cache.'); continue; }
    try { await fsp.cp(spriteDir(sp.id), path.join(dir, 'sprites', sp.id), { recursive: true, filter: (f) => !/[\/\\]src([\/\\]|$)/.test(f) }); media.sprites.push({ id: sp.id, dir: `sprites/${sp.id}` }); } catch { warnings.push(`The dancer “${sp.name}” could not be copied.`); }
  }
  if (st.logo && st.logo.id) {
    try { await copy(path.join(LOGOS, `${st.logo.id}.png`), path.join(dir, `logos/${st.logo.id}.png`)); await copy(path.join(LOGOS, `${st.logo.id}.json`), path.join(dir, `logos/${st.logo.id}.json`)).catch(() => {}); media.logos.push({ id: st.logo.id, file: `logos/${st.logo.id}.png` }); }
    catch { warnings.push('The logo is no longer in the cache.'); }
  }
  const bgIds = new Set();
  if (st.look && st.look.style === 'video' && st.look.videoId) bgIds.add(st.look.videoId);
  for (const s of st.songs) { if (s.videoId) bgIds.add(s.videoId); const m = songs.get(String(s.id || '')); if (m && m.ownVideo) bgIds.add(m.ownVideo); }
  for (const id of bgIds) {
    const b = getBackground(id);
    if (!b || !b.ready) { warnings.push('A video is no longer in the cache.'); continue; }
    try { await copy(path.join(backgroundDir(id), 'video.mp4'), path.join(dir, `backgrounds/${id}/video.mp4`)); await copy(path.join(backgroundDir(id), 'meta.json'), path.join(dir, `backgrounds/${id}/meta.json`)); media.backgrounds.push({ id, dir: `backgrounds/${id}` }); }
    catch { warnings.push('A video could not be copied.'); }
  }
  // which song owns which prepared video, so a load can give it back
  media.ownVideos = st.songs.map((s) => { const m = songs.get(String(s.id || '')); return m && m.ownVideo && bgIds.has(m.ownVideo) ? { song: m.id, video: m.ownVideo } : null; }).filter(Boolean);
  const doc = { format: MIX_FORMAT, version: 1, app: APP_VERSION, savedAt: Date.now(), title, state: st, media };
  await fsp.writeFile(path.join(dir, 'mix.json'), JSON.stringify(doc, null, 1));
  const bytes = await dirBytes(dir);
  log(`mix saved: ${dir} (${fmtBytes(bytes)}${warnings.length ? `, ${warnings.length} warning(s)` : ''})`);
  return { path: dir, bytes, sizeText: fmtBytes(bytes), warnings, name: path.basename(dir) };
}
async function loadMix(body) {
  let dir = String(body && body.path || '');
  if (body && body.where === 'ask') { dir = await chooseFolder('Choose a saved mix folder'); if (!dir) return { cancelled: true }; }
  if (!dir) throw Object.assign(new Error('Which mix?'), { status: 400 });
  if (/mix\.json$/i.test(dir)) dir = path.dirname(dir);
  let doc;
  try { doc = JSON.parse(await fsp.readFile(path.join(dir, 'mix.json'), 'utf8')); } catch { throw Object.assign(new Error('That folder holds no saved mix (no mix.json).'), { status: 415 }); }
  if (doc.format !== MIX_FORMAT || !doc.state) throw Object.assign(new Error('That is not a Liner mix.'), { status: 415 });
  const warnings = [], media = doc.media || {};
  for (const e of media.songs || []) {
    if (songs.has(e.id)) continue; // still in the cache: nothing to do
    const file = path.join(dir, e.file);
    if (!fs.existsSync(file)) { warnings.push(`The file of “${e.meta && e.meta.title || 'a song'}” is missing from the saved mix.`); continue; }
    try {
      const meta = await ingestPath(file, e.meta && e.meta.fileName || path.basename(file), { id: e.id, title: e.meta && e.meta.title, artist: e.meta && e.meta.artist, album: e.meta && e.meta.album, sourceUrl: e.meta && e.meta.sourceUrl || null, coverPath: e.cover ? path.join(dir, e.cover) : null });
      if (e.cover && e.meta && (e.meta.coverMode === 'custom' || e.meta.customCover)) { meta.coverMode = 'custom'; meta.customCover = true; meta.coverInfo = e.meta.coverInfo || meta.coverInfo; await saveMeta(meta); }
      if (meta.id !== e.id) warnings.push(`“${meta.title}” came back under a new id.`);
    } catch (err) { warnings.push(`“${e.meta && e.meta.title || 'A song'}” could not be brought back: ${err.message}`); }
  }
  for (const e of media.sprites || []) {
    if (getSprite(e.id)) continue;
    try { await fsp.cp(path.join(dir, e.dir), spriteDir(e.id), { recursive: true }); await registerSprite(e.id); } catch (err) { warnings.push(`A dancer could not be brought back: ${err.message}`); }
  }
  for (const e of media.logos || []) {
    try { await fsp.mkdir(LOGOS, { recursive: true }); if (!fs.existsSync(path.join(LOGOS, `${e.id}.png`))) { await fsp.copyFile(path.join(dir, e.file), path.join(LOGOS, `${e.id}.png`)); await fsp.copyFile(path.join(dir, `logos/${e.id}.json`), path.join(LOGOS, `${e.id}.json`)).catch(() => {}); } }
    catch { warnings.push('The logo could not be brought back.'); }
  }
  for (const e of media.backgrounds || []) {
    try { await restoreBackground(e.id, path.join(dir, e.dir)); } catch (err) { warnings.push(`A video could not be brought back: ${err.message}`); }
  }
  for (const o of media.ownVideos || []) { const m = songs.get(o.song); const b = getBackground(o.video); if (m && b && b.ready && m.ownVideo !== o.video) { m.ownVideo = o.video; m.ownVideoStatus = 'ready'; m.ownVideoError = null; await saveMeta(m).catch(() => {}); } }
  log(`mix loaded: ${dir}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  return { title: doc.title || doc.state.title || '', state: doc.state, warnings, savedAt: doc.savedAt || 0 };
}

// Candidates the art finder downloaded are kept for a while so a search comes back instantly, then let go: the
// chosen one has long been copied into its song's folder.
async function pruneArtCache(maxAgeDays = 14, maxBytes = 400e6) {
  const names = await fsp.readdir(ART_DIR).catch(() => []);
  if (!names.length) return;
  const files = [];
  for (const n of names) { try { const st = await fsp.stat(path.join(ART_DIR, n)); files.push({ n, size: st.size, mtime: st.mtimeMs }); } catch { /* gone */ } }
  files.sort((a, b) => b.mtime - a.mtime);
  const cutoff = Date.now() - maxAgeDays * 86400e3;
  let kept = 0, removed = 0, freed = 0;
  for (const f of files) {
    if (f.mtime >= cutoff && kept + f.size <= maxBytes) { kept += f.size; continue; }
    await fsp.rm(path.join(ART_DIR, f.n), { force: true }).catch(() => {}); removed++; freed += f.size;
  }
  if (removed) log(`art cache: let go of ${removed} old candidate file(s), ${fmtBytes(freed)}`);
}

// ---------------------------------------------------------------- cover art finder (Apple Music, Deezer, MusicBrainz + Cover Art Archive; no API keys)
const ART_DIR = path.join(CACHE, 'art');
const UA = `Liner/${APP_VERSION} (+https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Liner; local desktop app, cover art lookup)`;
const artCandidates = new Map(); // id -> candidate
const artSearches = new Map();   // query key -> { at, result }
const normText = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[([](feat|ft)\.?[^)\]]*[)\]]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
function bigrams(s) { const t = ` ${s} `; const m = new Map(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; }
function similarity(a, b) { // Dice coefficient on character bigrams, 0..1
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const [g, n] of A) { na += n; if (B.has(g)) inter += Math.min(n, B.get(g)); }
  for (const n of B.values()) nb += n;
  return (2 * inter) / (na + nb);
}
const stripNoise = (t) => cleanTitle(t).replace(/\b(\d{4} )?remaster(ed)?\b|\bmono\b|\bstereo\b/gi, ' ').replace(/\s{2,}/g, ' ').trim();
async function getJSON(url, timeout = 8000) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function searchApple(q) {
  const out = [], seen = new Set();
  const runs = [{ entity: 'song', term: q.term }];
  if (q.album) runs.push({ entity: 'album', term: [q.a, q.album].filter(Boolean).join(' ') });
  for (const r of runs) {
    try {
      const j = await getJSON(`https://itunes.apple.com/search?term=${encodeURIComponent(r.term)}&media=music&entity=${r.entity}&limit=12`);
      for (const x of j.results || []) {
        if (!x.artworkUrl100) continue;
        const url = x.artworkUrl100.replace(/\/\d+x\d+bb\.(jpg|png)$/i, '/3000x3000bb.$1'); // Apple serves up to the source size, no upscaling
        if (seen.has(url)) continue; seen.add(url);
        out.push({ source: 'apple', label: 'Apple Music', short: 'Apple', title: x.trackName || x.collectionName || '', artist: x.artistName || '', album: x.collectionName || '', year: String(x.releaseDate || '').slice(0, 4), url, preview: x.artworkUrl100.replace(/\/\d+x\d+bb\./, '/300x300bb.') });
      }
    } catch { /* source unavailable or nothing found */ }
  }
  return out;
}
async function searchDeezer(q) {
  const out = [], seen = new Set();
  try {
    const j = await getJSON(`https://api.deezer.com/search?q=${encodeURIComponent(q.term)}&limit=12`);
    for (const x of j.data || []) {
      const xl = x.album && x.album.cover_xl;
      if (!xl) continue;
      const url = xl.replace(/\/1000x1000-/, '/1800x1800-'); // Deezer also caps at the source size
      if (seen.has(url)) continue; seen.add(url);
      out.push({ source: 'deezer', label: 'Deezer', short: 'Deezer', title: x.title || '', artist: x.artist ? x.artist.name : '', album: x.album.title || '', year: '', url, preview: x.album.cover_medium || xl });
    }
  } catch { /* ignore */ }
  return out;
}
async function searchMusicBrainz(q) {
  const out = [];
  const lucene = [q.t ? `recording:"${q.t.replace(/"/g, '')}"` : '', q.a ? `artist:"${q.a.replace(/"/g, '')}"` : ''].filter(Boolean).join(' AND ');
  if (!lucene) return out;
  try {
    const j = await getJSON(`https://musicbrainz.org/ws/2/recording?query=${encodeURIComponent(lucene)}&fmt=json&limit=6`, 9000);
    const groups = new Map();
    for (const rec of j.recordings || []) {
      const artist = (rec['artist-credit'] || []).map((c) => c.name || (c.artist && c.artist.name) || '').join(' ');
      for (const rel of rec.releases || []) {
        const rg = rel['release-group'];
        const key = rg ? `release-group/${rg.id}` : `release/${rel.id}`;
        if (groups.has(key)) continue;
        groups.set(key, { key, title: rel.title || (rg && rg.title) || '', artist, recTitle: rec.title || '', date: rel.date || '' });
        if (groups.size >= 5) break;
      }
      if (groups.size >= 5) break;
    }
    await Promise.all([...groups.values()].map(async (g) => {
      try {
        const head = await fetch(`https://coverartarchive.org/${g.key}/front`, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
        if (!head.ok) return;
        out.push({ source: 'musicbrainz', label: 'Cover Art Archive', short: 'MusicBrainz', title: g.recTitle, artist: g.artist, album: g.title, year: g.date.slice(0, 4), url: `https://coverartarchive.org/${g.key}/front`, preview: `https://coverartarchive.org/${g.key}/front-250` });
      } catch { /* no art for this release */ }
    }));
  } catch { /* ignore */ }
  return out;
}
const contains = (hay, needle) => { hay = normText(hay); needle = normText(needle); return !!needle && needle.length >= 3 && ` ${hay} `.includes(` ${needle} `); };
function scoreMatch(q, c) {
  const st = contains(c.title, q.t) ? Math.max(0.92, similarity(q.t, c.title)) : similarity(q.t, c.title);
  const sa = q.a ? (contains(c.artist, q.a) ? 1 : Math.max(similarity(q.a, c.artist), similarity(q.a, c.title))) : 0;
  const sal = q.album ? Math.max(similarity(q.album, c.album), similarity(q.album, c.title)) : 0;
  let s;
  if (q.a && q.album) s = 0.45 * st + 0.35 * sa + 0.2 * sal;
  else if (q.a) s = 0.6 * st + 0.4 * sa;
  else if (q.album) s = 0.7 * st + 0.3 * sal;
  else s = st;
  if (!q.a) s = Math.max(s, similarity(q.t, `${c.artist} ${c.title}`), similarity(q.t, `${c.artist} ${c.album}`));
  return s;
}
async function fetchCandidateImage(c) {
  const id = crypto.createHash('sha1').update(c.url).digest('hex').slice(0, 16);
  const png = path.join(ART_DIR, `${id}.png`), infoFile = path.join(ART_DIR, `${id}.json`);
  if (!fs.existsSync(png) || !fs.existsSync(infoFile)) {
    const orig = path.join(ART_DIR, `${id}.orig`);
    const r = await fetch(c.url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (+r.headers.get('content-length') > 25e6) throw new Error('too large');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 25e6 || buf.length < 1000) throw new Error('unusable image');
    await fsp.writeFile(orig, buf);
    try {
      const size = await imageSize(orig);
      if (!size) throw new Error('not an image');
      await convertImage(orig, png);
      await fsp.writeFile(infoFile, JSON.stringify({ w: size.w, h: size.h, bytes: buf.length }));
    } finally { await fsp.rm(orig, { force: true }).catch(() => {}); }
  }
  const info = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
  Object.assign(c, { id, width: info.w, height: info.h, bytes: info.bytes, local: `/api/art/${id}` });
  artCandidates.set(id, c);
  return c;
}
const publicCandidate = (c) => ({ id: c.id, source: c.source, label: c.label, short: c.short || c.label, title: c.title, artist: c.artist, album: c.album, year: c.year, width: c.width, height: c.height, bytes: c.bytes, score: +c.score.toFixed(3), match: +c.match.toFixed(3), local: c.local, preview: c.preview });
async function findCoverArt({ title, artist, album }) {
  const q = { t: stripNoise(title), a: cleanUploader(artist), album: na(album) };
  q.term = [q.a, q.t].filter(Boolean).join(' ');
  if (!q.term) return { query: '', candidates: [] };
  const key = JSON.stringify([q.t, q.a, q.album]);
  const cached = artSearches.get(key);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.result;
  await fsp.mkdir(ART_DIR, { recursive: true });
  const [apple, deezer, mb] = await Promise.all([searchApple(q), searchDeezer(q), searchMusicBrainz(q)]);
  let cands = [...apple, ...deezer, ...mb];
  for (const list of [apple, deezer, mb]) list.forEach((c, i) => { c.rank = i; });
  for (const c of cands) c.match = Math.min(1, scoreMatch(q, c) + 0.03 * Math.max(0, 1 - c.rank / 8)); // stores list popular releases first: a small tiebreak
  cands.sort((a, b) => b.match - a.match);
  cands = cands.filter((c) => c.match >= 0.25).slice(0, 10);
  const fetched = [];
  await Promise.all(cands.map(async (c) => { try { fetched.push(await fetchCandidateImage(c)); } catch (e) { log('art fetch failed', c.source, (e.message || '').slice(0, 80)); } }));
  // the same album from several sources: keep the sharpest copy
  const byAlbum = new Map();
  for (const c of fetched) {
    const k = `${normText(c.artist).split(' ').slice(0, 2).join(' ')}|${normText(c.album || c.title)}`; // same album across stores, ignoring featured-artist suffixes
    const dim = Math.min(c.width, c.height);
    c.score = c.match * (0.8 + 0.2 * Math.min(1, dim / 1400)) - (dim < 450 ? 0.12 : 0);
    const prev = byAlbum.get(k);
    if (!prev || Math.min(prev.width, prev.height) < dim || (Math.min(prev.width, prev.height) === dim && prev.score < c.score)) byAlbum.set(k, c);
  }
  const result = { query: q.term, candidates: [...byAlbum.values()].sort((a, b) => b.score - a.score).map(publicCandidate) };
  artSearches.set(key, { at: Date.now(), result });
  return result;
}
async function applyCandidateCover(song, c) {
  const dir = songDir(song.id);
  await fsp.copyFile(path.join(ART_DIR, `${c.id}.png`), path.join(dir, 'cover.png'));
  song.cover = true; song.customCover = true; song.coverMode = 'found'; song.coverVersion = (song.coverVersion || 0) + 1;
  song.coverInfo = { label: c.label, w: c.width, h: c.height, candidate: c.id, album: c.album, artist: c.artist };
  await saveMeta(song);
}

// ---------------------------------------------------------------- links (YouTube / SoundCloud through yt-dlp)
let ytdlpBin = null;
const jobs = new Map(); // id -> download job
const jobQueue = [];
const activeJobs = new Set();
const JOBS_FILE = path.join(CACHE, 'downloads.json');
const ACTIVE_STATES = new Set(['queued', 'downloading', 'converting']);
function publicJob(j) {
  const { id, url, title, artist, album, duration, thumbnail, status, progress, eta, file, thumb, error, songId, size, sampleRate, createdAt } = j;
  return { id, url, title, artist, album, duration, thumbnail, status, progress, eta, file, thumb: !!thumb, error, songId, size, sampleRate, createdAt };
}
let saveJobsTimer;
function saveJobs() {
  clearTimeout(saveJobsTimer);
  saveJobsTimer = setTimeout(() => fsp.writeFile(JOBS_FILE, JSON.stringify([...jobs.values()].map((j) => ({ ...publicJob(j), thumb: j.thumb, ytid: j.ytid })), null, 1)).catch(() => {}), 200);
}
async function loadJobs() {
  try {
    for (const j of JSON.parse(await fsp.readFile(JOBS_FILE, 'utf8'))) {
      if (ACTIVE_STATES.has(j.status)) { j.status = 'error'; j.error = 'Interrupted when Liner was closed.'; }
      if ((j.status === 'ready' || j.status === 'added') && !(j.file && fs.existsSync(j.file))) { j.status = 'error'; j.error = 'The file is no longer in the Downloads folder.'; }
      jobs.set(j.id, j);
    }
  } catch { /* nothing downloaded yet */ }
  // songs added from links before the link was kept with the song: remember where they came from, so their video can be fetched
  for (const j of jobs.values()) {
    const s = j.songId && j.url ? songs.get(j.songId) : null;
    if (s && !s.sourceUrl) { s.sourceUrl = j.url; await saveMeta(s).catch(() => {}); }
  }
}
const na = (v) => (v == null || v === 'NA' || v === 'None' ? '' : String(v).trim());
const cleanUploader = (s) => na(s).replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
const cleanTitle = (t) => na(t).replace(/\s*[([][^)\]]*\b(official|lyric|lyrics|audio|video|visuali[sz]er|hd|hq|4k|free download)\b[^)\]]*[)\]]/gi, ' ').replace(/\s{2,}/g, ' ').trim();
function splitArtist(title) {
  const parts = String(title).split(/\s+[-–—]\s+/);
  return parts.length >= 2 ? { artist: parts[0].trim(), title: parts.slice(1).join(' - ').trim() } : { artist: '', title };
}
function ytError(stderr, fallback) {
  const lines = String(stderr || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const err = [...lines].reverse().find((l) => /^ERROR/i.test(l)) || lines[lines.length - 1] || '';
  return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]+:\s*)?/i, '').slice(0, 240) || fallback;
}
function pickThumb(e) {
  if (e.thumbnail) return e.thumbnail;
  const t = Array.isArray(e.thumbnails) ? e.thumbnails.filter((x) => x && x.url) : [];
  return t.length ? t[t.length - 1].url : null;
}
function describeEntry(e) {
  const track = na(e.track), artistTag = na(e.artist);
  let title = track || na(e.title), artist = artistTag || cleanUploader(e.uploader || e.channel || e.creator);
  if (!artistTag && !track) { const s = splitArtist(title); if (s.artist) { artist = s.artist; title = s.title; } }
  return { title: cleanTitle(title) || title, artist, album: na(e.album), duration: +e.duration || 0, thumbnail: pickThumb(e) };
}
async function resolveLinks(urls) {
  if (!ytdlpBin) throw Object.assign(new Error('yt-dlp is not installed.'), { status: 501 });
  const items = [], errors = [];
  for (const url of urls) {
    try {
      const { stdout } = await run(ytdlpBin, ['-J', '--flat-playlist', '--no-warnings', '--', url], { timeout: 120000 });
      const info = JSON.parse(stdout);
      const add = (e) => items.push({ url: e.webpage_url || e.url || url, ...describeEntry(e), playlist: info._type === 'playlist' ? na(info.title) : '' });
      if (info._type === 'playlist' && Array.isArray(info.entries)) { for (const e of info.entries) if (e) add(e); }
      else add(info);
    } catch (e) { errors.push({ url, error: ytError(e.stderr, e.killed ? 'Timed out.' : e.message) }); }
  }
  return { items, errors };
}
function createJob(item) {
  const id = crypto.randomBytes(5).toString('hex');
  const j = {
    id, url: String(item.url), title: na(item.title), artist: na(item.artist), album: na(item.album), duration: +item.duration || 0, thumbnail: item.thumbnail || null,
    status: 'queued', progress: 0, eta: '', file: null, thumb: null, error: null, songId: null, size: 0, sampleRate: 0, createdAt: Date.now(), ytid: null, proc: null,
  };
  jobs.set(id, j); jobQueue.push(j); saveJobs(); pumpJobs();
  return j;
}
function pumpJobs() {
  while (activeJobs.size < 2 && jobQueue.length) { const j = jobQueue.shift(); if (j.status === 'queued') runJob(j); }
}
function runJob(j) {
  activeJobs.add(j);
  j.status = 'downloading'; j.progress = 0; j.eta = '';
  const args = ['--no-playlist', '-f', 'bestaudio/best', '-x', '--audio-format', 'wav', '--audio-quality', '0',
    '--postprocessor-args', 'ExtractAudio+ffmpeg_o:-c:a pcm_s24le', // decode to 24-bit so nothing is truncated on the way to WAV
    '--write-thumbnail', '--convert-thumbnails', 'png', '-o', path.join(DOWNLOADS, '%(title).110B [%(id)s].%(ext)s'),
    '--newline', '--progress', '--quiet', '--no-warnings', '--no-simulate', '--no-mtime',
    '--print', 'before_dl:META\t%(id)s\t%(title)s\t%(track)s\t%(artist)s\t%(uploader)s\t%(album)s\t%(duration)s\t%(thumbnail)s',
    '--print', 'after_move:FILE\t%(filepath)s',
    '--progress-template', 'download:PROG\t%(progress._percent_str)s\t%(progress._eta_str)s',
    '--', j.url];
  const proc = spawn(ytdlpBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  j.proc = proc;
  let buf = '', err = '';
  proc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r/g, '').trim(); buf = buf.slice(i + 1); if (line) jobLine(j, line); }
  });
  proc.stderr.on('data', (d) => { err += d; });
  proc.on('error', (e) => { err += '\n' + e.message; });
  proc.on('close', async (code) => {
    activeJobs.delete(j); j.proc = null;
    if (j.status !== 'cancelled') {
      if (code === 0) await finalizeJob(j, err);
      else { j.status = 'error'; j.error = ytError(err, `yt-dlp exited with code ${code}`); log(`download ${j.id}: failed — ${j.error}`); }
    }
    saveJobs(); pumpJobs();
  });
  log(`download ${j.id}: ${j.url}`);
}
function jobLine(j, line) {
  const f = line.split(/\t|\\t/); // yt-dlp echoes a real tab; be tolerant of a literal backslash-t too
  if (f[0] === 'META') {
    j.ytid = na(f[1]) || j.ytid;
    const d = describeEntry({ title: f[2], track: f[3], artist: f[4], uploader: f[5], album: f[6], duration: f[7], thumbnail: na(f[8]) || null });
    j.title = d.title || j.title; j.artist = d.artist || j.artist; j.album = d.album || j.album;
    if (d.duration) j.duration = d.duration; if (d.thumbnail) j.thumbnail = d.thumbnail;
  } else if (f[0] === 'PROG') {
    const p = parseFloat(f[1]);
    if (!Number.isNaN(p)) j.progress = Math.min(1, p / 100);
    j.eta = /^\d/.test(na(f[2])) ? na(f[2]) : '';
    if (j.progress >= 0.999) j.status = 'converting';
  } else if (f[0] === 'FILE') { j.file = f.slice(1).join('\t'); j.status = 'converting'; }
}
async function finalizeJob(j, stderr) {
  let file = j.file;
  if (!file || !/\.wav$/i.test(file) || !fs.existsSync(file)) {
    const base = file ? file.replace(/\.[^./]+$/, '') : null;
    if (base && fs.existsSync(base + '.wav')) file = base + '.wav';
    else if (j.ytid) { const hit = (await fsp.readdir(DOWNLOADS).catch(() => [])).find((n) => n.includes(`[${j.ytid}]`) && /\.wav$/i.test(n)); if (hit) file = path.join(DOWNLOADS, hit); }
  }
  if (!file || !fs.existsSync(file)) { j.status = 'error'; j.error = ytError(stderr, 'The download finished but no WAV file was produced.'); return; }
  j.file = file;
  const base = file.replace(/\.wav$/i, '');
  for (const ext of ['.png', '.jpg', '.webp']) if (fs.existsSync(base + ext)) { j.thumb = base + ext; break; }
  try { // RIFF INFO tags so the saved WAV stays labelled outside Liner as well
    const tmp = base + '.tagged.wav';
    await run(FFMPEG, ['-y', '-v', 'error', '-i', file, '-map', '0:a:0', '-c', 'copy', '-metadata', `title=${j.title}`, '-metadata', `artist=${j.artist}`, ...(j.album ? ['-metadata', `album=${j.album}`] : []), '-rf64', 'auto', tmp]);
    await fsp.rename(tmp, file);
  } catch { await fsp.rm(base + '.tagged.wav', { force: true }).catch(() => {}); }
  try { const p = await probeFile(file); j.sampleRate = p.meta.sampleRate; if (!j.duration) j.duration = p.meta.duration; } catch { /* keep what we know */ }
  try { j.size = (await fsp.stat(file)).size; } catch { /* ignore */ }
  j.status = 'ready'; j.progress = 1; j.eta = '';
  log(`download ${j.id}: ready → ${path.basename(file)}`);
}
async function removeJobFiles(j) {
  const names = new Set();
  if (j.file) names.add(j.file);
  if (j.thumb) names.add(j.thumb);
  const shared = j.ytid && [...jobs.values()].some((o) => o !== j && o.ytid === j.ytid && (o.status === 'ready' || o.status === 'added'));
  if (j.ytid && !shared) { try { for (const n of await fsp.readdir(DOWNLOADS)) if (n.includes(`[${j.ytid}]`)) names.add(path.join(DOWNLOADS, n)); } catch { /* ignore */ } }
  for (const f of names) await fsp.rm(f, { force: true }).catch(() => {});
}
async function cancelJob(j) {
  const idx = jobQueue.indexOf(j);
  if (idx >= 0) jobQueue.splice(idx, 1);
  j.status = 'cancelled';
  if (j.proc) { try { j.proc.kill('SIGKILL'); } catch { /* already gone */ } await new Promise((r) => setTimeout(r, 300)); }
  await removeJobFiles(j);
  jobs.delete(j.id);
  saveJobs();
}

// ---------------------------------------------------------------- renders
const renders = new Map(); // rid -> render
const silence = (frames) => Buffer.alloc(Math.max(0, frames) * BYTES_PER_FRAME);
// Bass processing for the final mix. "boost" is a plain low shelf (loud songs can clip). "smart" lifts the low band
// through a Linkwitz-Riley crossover, compresses that band so big bass hits don't run away, sums it back and runs a
// look-ahead limiter: the same lift, never clipping.
function bassFilter({ mode, gain } = {}) {
  const g = clampInt(gain, 0, 15);
  if (!g || mode === 'off' || !mode) return '';
  // float from the first filter on: the s24 input would otherwise be processed as 32-bit integers and clip inside the shelf
  if (mode === 'boost') return `aformat=sample_fmts=fltp,bass=g=${g}:f=${BASS_SHELF_HZ}:w=0.5`;
  if (mode === 'smart2') return `aformat=sample_fmts=fltp,bass=g=${g}:f=${BASS2_SHELF_HZ}:w=0.6,alimiter=limit=0.95:attack=2:release=80:level=false`;
  return `aformat=sample_fmts=fltp,acrossover=split=${BASS_SPLIT_HZ}:order=4th[lo][hi];[lo]volume=${g}dB,acompressor=threshold=0.5:ratio=2:attack=10:release=200:knee=6:detection=peak:makeup=1[loc];[loc][hi]amix=inputs=2:normalize=0,alimiter=limit=0.95:attack=5:release=60:level=false`;
}
const BASS_SHELF_HZ = 200, BASS_SPLIT_HZ = 150, BASS2_SHELF_HZ = 160;
const BASS2_TARGET_DB = 0.5; // the loudest peaks may sit ~1 dB above the limiter's ceiling: it then shaves just those, instead of the whole song being turned down further
// Smart boost 2: how loud does the song peak once the shelf is applied? Measured in float, so values above 0 dB are real.
async function measureBoostedPeak(meta, gain) {
  const key = `v2:${BASS2_SHELF_HZ}:${gain}`; // v2: measured in float
  meta.boostPeaks = meta.boostPeaks || {};
  if (typeof meta.boostPeaks[key] === 'number') return meta.boostPeaks[key];
  const pcm = path.join(songDir(meta.id), 'pcm.raw');
  const { stderr } = await run(FFMPEG, ['-v', 'info', '-f', 's24le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', pcm,
    '-af', `aformat=sample_fmts=fltp,bass=g=${gain}:f=${BASS2_SHELF_HZ}:w=0.6,astats=measure_overall=Peak_level:measure_perchannel=none`, '-f', 'null', '-']);
  const m = String(stderr).match(/Peak level dB:\s*(-?[\d.]+|-inf)/);
  const peak = m && m[1] !== '-inf' ? parseFloat(m[1]) : -100;
  meta.boostPeaks[key] = peak;
  await saveMeta(meta);
  return peak;
}
const headroomGain = (peakDb) => Math.min(0, BASS2_TARGET_DB - peakDb); // dB to turn the song down so the lift fits
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number.isFinite(v) ? v : lo)));
const PCM_CHUNK = BYTES_PER_FRAME * 174762; // ~1 MiB, always a whole number of frames so per-sample work stays aligned
// equal-power fades on s24le stereo frames; `frame` is the chunk's first frame within the trimmed region
function applyFades(buf, frame, total, fadeIn, fadeOut, gain = 1) {
  const frames = buf.length / BYTES_PER_FRAME;
  for (let f = 0; f < frames; f++) {
    const g0 = frame + f;
    let g = gain;
    if (fadeIn && g0 < fadeIn) g *= Math.sin((g0 / fadeIn) * Math.PI / 2);
    if (fadeOut && g0 >= total - fadeOut) g *= Math.sin(((total - g0) / fadeOut) * Math.PI / 2);
    if (g >= 1) continue;
    for (let ch = 0; ch < 2; ch++) {
      const o = f * BYTES_PER_FRAME + ch * 3;
      let v = buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16);
      if (v & 0x800000) v -= 0x1000000;
      v = Math.round(v * g);
      buf[o] = v & 0xff; buf[o + 1] = (v >> 8) & 0xff; buf[o + 2] = (v >> 16) & 0xff;
    }
  }
  return buf;
}
// peak envelope of a song's decoded PCM for the trimmer, cached next to it
async function waveformOf(meta, buckets = 1200) {
  const dir = songDir(meta.id);
  const cacheFile = path.join(dir, `waveform-${buckets}.json`);
  try { return JSON.parse(await fsp.readFile(cacheFile, 'utf8')); } catch { /* compute */ }
  const pcm = path.join(dir, 'pcm.raw');
  const frames = meta.samples || 0;
  const peaks = new Float32Array(buckets);
  const per = Math.max(1, frames / buckets);
  let frame = 0;
  for await (const chunk of fs.createReadStream(pcm, { highWaterMark: PCM_CHUNK * 4 })) {
    const n = chunk.length / BYTES_PER_FRAME;
    for (let f = 0; f < n; f++) {
      const b = Math.min(buckets - 1, Math.floor((frame + f) / per));
      const o = f * BYTES_PER_FRAME;
      for (let ch = 0; ch < 2; ch++) {
        let v = chunk[o + ch * 3] | (chunk[o + ch * 3 + 1] << 8) | (chunk[o + ch * 3 + 2] << 16);
        if (v & 0x800000) v -= 0x1000000;
        const a = Math.abs(v) / 8388608;
        if (a > peaks[b]) peaks[b] = a;
      }
    }
    frame += n;
  }
  const out = { buckets, duration: frames / SAMPLE_RATE, peaks: Array.from(peaks, (v) => Math.round(v * 1000) / 1000) };
  fsp.writeFile(cacheFile, JSON.stringify(out)).catch(() => {});
  return out;
}

// Liveliness analysis for the dancers' auto mode (analysis.mjs), one song at a time in a worker thread, cached in meta.json.
let analysisChain = Promise.resolve();
const analysisPending = new Map();
function analysisOf(meta) {
  if (meta.analysis && meta.analysis.v === ANALYSIS_VERSION) return Promise.resolve(meta.analysis);
  if (analysisPending.has(meta.id)) return analysisPending.get(meta.id);
  const p = analysisChain.then(() => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const w = new Worker(new URL('./analysis.mjs', import.meta.url), { workerData: { pcm: path.join(songDir(meta.id), 'pcm.raw'), samples: meta.samples } });
    w.once('message', (msg) => { if (msg.ok) { log(`analysis ${meta.id}: ${msg.result.label} ${msg.result.score} · ${msg.result.bpm} BPM (${Date.now() - t0} ms)`); resolve(msg.result); } else reject(new Error(msg.error)); });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`analysis worker exited with ${code}`)); });
  })).then(async (r) => { meta.analysis = r; if (songs.has(meta.id)) await saveMeta(meta); return r; });
  analysisChain = p.catch(() => {});
  analysisPending.set(meta.id, p);
  p.finally(() => analysisPending.delete(meta.id)).catch(() => {});
  return p;
}

// Band levels over time for the frequency visualizer (analysis.mjs `spectrum`), computed once per song in the same
// worker queue and kept as a small binary file next to the song: 16-byte header ("LSPC", version, bands, rate, frames)
// followed by one byte per band per frame.
const spectrumPending = new Map();
function spectrumOf(meta) {
  const file = path.join(songDir(meta.id), `spectrum-v${SPECTRUM_VERSION}.bin`);
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (spectrumPending.has(meta.id)) return spectrumPending.get(meta.id);
  const p = analysisChain.then(() => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const w = new Worker(new URL('./analysis.mjs', import.meta.url), { workerData: { task: 'spectrum', pcm: path.join(songDir(meta.id), 'pcm.raw'), samples: meta.samples } });
    w.once('message', (msg) => {
      if (!msg.ok) return reject(new Error(msg.error));
      const r = msg.result, head = Buffer.alloc(16);
      head.write('LSPC', 0, 'ascii'); head.writeUInt8(r.v, 4); head.writeUInt8(r.bands, 5); head.writeUInt16LE(r.rate, 6); head.writeUInt32LE(r.frames, 8);
      fsp.writeFile(file, Buffer.concat([head, Buffer.from(msg.data.buffer, msg.data.byteOffset, msg.data.byteLength)]))
        .then(() => { log(`spectrum ${meta.id}: ${r.frames} frames, top ${r.top} dB (${Date.now() - t0} ms)`); resolve(file); }, reject);
    });
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`spectrum worker exited with ${code}`)); });
  }));
  analysisChain = p.catch(() => {});
  spectrumPending.set(meta.id, p);
  p.finally(() => spectrumPending.delete(meta.id)).catch(() => {});
  return p;
}

// ---------------------------------------------------------------- logos (a watermark image for the video)
async function listLogos() {
  const out = [];
  for (const n of await fsp.readdir(LOGOS).catch(() => [])) if (n.endsWith('.json')) { try { out.push(JSON.parse(await fsp.readFile(path.join(LOGOS, n), 'utf8'))); } catch { /* skip */ } }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
async function ingestLogo(req, fileName) {
  await fsp.mkdir(LOGOS, { recursive: true });
  const id = crypto.randomBytes(6).toString('hex');
  const tmp = path.join(LOGOS, `upload-${id}`), png = path.join(LOGOS, `${id}.png`);
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await run(FFMPEG, ['-y', '-v', 'error', '-i', tmp, '-frames:v', '1', '-vf', "scale='min(1024,iw)':'min(1024,ih)':force_original_aspect_ratio=decrease:flags=lanczos", '-f', 'image2', '-update', '1', '-pix_fmt', 'rgba', '-c:v', 'png', png]);
    const size = await imageSize(png);
    const meta = { id, name: String(fileName).replace(/\.[^.]+$/, '').slice(0, 80) || 'Logo', w: size ? size.w : 0, h: size ? size.h : 0, createdAt: Date.now() };
    await fsp.writeFile(path.join(LOGOS, `${id}.json`), JSON.stringify(meta));
    return meta;
  } catch (e) {
    await fsp.rm(png, { force: true }).catch(() => {});
    throw Object.assign(new Error('That image could not be read.'), { status: 415 });
  } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

function videoEncoderArgs(codec, bitrate) {
  const enc = codec === 'hevc' ? caps.hevc : caps.h264;
  if (!enc) throw Object.assign(new Error(`No ${codec.toUpperCase()} encoder available in ffmpeg.`), { status: 400 });
  const args = ['-c:v', enc, '-b:v', String(bitrate)];
  if (enc.endsWith('_videotoolbox')) args.push('-profile:v', codec === 'hevc' ? 'main' : 'high', '-allow_sw', '1', '-realtime', '0');
  else args.push('-preset', 'medium', '-maxrate', String(Math.round(bitrate * 1.5)), '-bufsize', String(bitrate * 2));
  return args;
}

async function startRender(p) {
  if (!caps.ffmpeg) throw Object.assign(new Error('ffmpeg is not available on this machine.'), { status: 500 });
  const entries = (Array.isArray(p.songs) ? p.songs : []).map((x) => (typeof x === 'string' ? { id: x } : x || {}));
  if (!entries.length) throw Object.assign(new Error('Add at least one song.'), { status: 400 });
  const list = entries.map((e) => songs.get(String(e.id || '')));
  if (list.some((s) => !s)) throw Object.assign(new Error('A song is missing from the cache. Re-add it.'), { status: 409 });
  if (list.some((s) => !s.ready)) throw Object.assign(new Error('Some songs are still being prepared.'), { status: 409 });
  // trims are sample-exact: [startFrame, endFrame) of the decoded PCM, with optional fades at cut points
  const parts = list.map((s, k) => {
    const e = entries[k];
    const startFrame = clampInt(Math.round((+e.start || 0) * SAMPLE_RATE), 0, s.samples);
    const endFrame = e.end == null ? s.samples : clampInt(Math.round(+e.end * SAMPLE_RATE), startFrame, s.samples);
    if (endFrame - startFrame < SAMPLE_RATE / 10) throw Object.assign(new Error(`“${s.title}” is trimmed to nothing.`), { status: 400 });
    const fadeFrames = clampInt(Math.round((+e.fade || 0) * SAMPLE_RATE), 0, Math.floor((endFrame - startFrame) / 2));
    return { song: s, startFrame, endFrame, fadeIn: startFrame > 0 ? fadeFrames : 0, fadeOut: endFrame < s.samples ? fadeFrames : 0, userGain: Math.min(6, Math.max(-12, +e.gainDb || 0)) };
  });
  // crossfade: each song starts this long before the previous one ends (at most half of either), the gap is skipped
  const crossfade = Math.min(8, Math.max(0, +p.crossfade || 0));
  const overlaps = parts.map((q, k) => (k === 0 || !(crossfade > 0) ? 0 : Math.min(Math.round(crossfade * SAMPLE_RATE), Math.floor((parts[k - 1].endFrame - parts[k - 1].startFrame) / 2), Math.floor((q.endFrame - q.startFrame) / 2))));
  const width = Math.round(+p.width), height = Math.round(+p.height), fps = Math.round(+p.fps);
  if (!(width >= 160 && height >= 90 && width <= 8192 && height <= 8192 && fps >= 1 && fps <= 120)) throw Object.assign(new Error('Invalid output size or frame rate.'), { status: 400 });
  const codec = p.codec === 'hevc' ? 'hevc' : 'h264';
  const mode = p.mode === 'raw' ? 'raw' : 'stream';
  const rid = crypto.randomBytes(5).toString('hex');
  const dir = path.join(RENDERS, rid);
  await fsp.mkdir(dir, { recursive: true });
  const r = {
    rid, dir, mode, codec, width, height, fps, bitrate: clampInt(Math.round(+p.bitrate) || 12e6, 200e3, 400e6),
    audio: p.audio === 'alac' ? 'alac' : 'aac', audioBitrate: clampInt(Math.round(+p.audioBitrate) || 320, 64, 512),
    fileName: safeName(p.fileName) || 'Liner mix', title: String(p.title || '').slice(0, 200),
    songs: list, parts, lead: Math.max(0, +p.lead || 0), gap: Math.max(0, +p.gap || 0), tail: Math.max(0, +p.tail || 0), frames: Math.round(+p.frames) || 0, crossfade, overlaps,
    bass: { mode: ['boost', 'smart', 'smart2'].includes(p.bass && p.bass.mode) ? p.bass.mode : 'off', gain: clampInt(+(p.bass && p.bass.gain) || 0, 0, 15) },
    status: { phase: 'rendering', progress: 0 }, proc: null, stream: null, createdAt: Date.now(),
  };
  if (r.bass.mode === 'smart2' && r.bass.gain > 0) {
    for (const q of parts) q.gainDb = headroomGain(await measureBoostedPeak(q.song, r.bass.gain));
    log(`render ${rid}: smart boost 2 headroom ` + parts.map((q) => `${q.song.title.slice(0, 18)} ${q.gainDb.toFixed(1)} dB`).join(', '));
  }
  r.partCount = mode === 'raw' ? 1 : clampInt(+p.parts || 1, 1, 4); // the page may encode the video in a few consecutive parts at once
  r.streams = [];
  if (mode === 'raw') {
    r.videoPath = path.join(dir, 'video.mp4');
    const args = ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', '-an',
      '-vf', 'scale=in_range=pc:out_color_matrix=bt709:out_range=tv:flags=accurate_rnd,format=yuv420p',
      ...videoEncoderArgs(codec, r.bitrate), '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-tag:v', codec === 'hevc' ? 'hvc1' : 'avc1', r.videoPath];
    const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => { r.encoderExit = code; r.encoderError = err.trim(); if (code !== 0 && !r.cancelled) log(`render ${rid}: encoder exited with ${code}: ${r.encoderError.slice(0, 300)}`); });
    proc.stdin.on('error', () => {});
    r.proc = proc;
  } else {
    r.videoPath = path.join(dir, codec === 'hevc' ? 'video.hevc' : 'video.h264');
  }
  renders.set(rid, r);
  startAudio(r); // the soundtrack does not depend on the frames: encode it now, while they render
  log(`render ${rid}: ${width}x${height}@${fps} ${codec} ${mode} · ${list.length} songs`);
  return r;
}

// A render whose page went away (tab closed mid-export) would otherwise hold an ffmpeg process and disk forever.
setInterval(() => {
  const now = Date.now();
  for (const r of renders.values()) {
    if (r.status.phase === 'rendering' && now - (r.lastActivity || r.createdAt) > 15 * 60 * 1000) { log(`render ${r.rid}: abandoned, cleaning up`); cancelRender(r); }
    else if ((r.status.phase === 'done' || r.status.phase === 'error') && now - (r.finishedAt || r.createdAt) > 2 * 60 * 1000) renders.delete(r.rid); // the page has long read the result
  }
}, 60 * 1000).unref();

function partPath(r, part) { return path.join(r.dir, `video.part${part}.${r.codec === 'hevc' ? 'hevc' : 'h264'}`); }
function appendChunk(r, req, part = 0) {
  r.lastActivity = Date.now();
  return new Promise((resolve, reject) => {
    if (r.mode !== 'raw' && !r.streams[part]) r.streams[part] = fs.createWriteStream(partPath(r, part));
    const dest = r.mode === 'raw' ? r.proc.stdin : r.streams[part];
    if (!dest || dest.destroyed || dest.writableEnded) return reject(Object.assign(new Error('Render is not accepting data.'), { status: 409 }));
    req.on('error', reject);
    req.on('end', resolve);
    req.pipe(dest, { end: false });
  });
}

async function probeOutput(file) {
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'stream=codec_type,duration,nb_frames:format=duration', '-of', 'json', file]);
    const j = JSON.parse(stdout);
    const v = (j.streams || []).find((s) => s.codec_type === 'video');
    return { duration: parseFloat(j.format && j.format.duration) || 0, videoDuration: parseFloat(v && v.duration) || 0, frames: +(v && v.nb_frames) || 0 };
  } catch { return null; }
}
async function uniqueExportPath(name) {
  let candidate = path.join(EXPORTS, `${name}.mp4`);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(EXPORTS, `${name} ${i}.mp4`);
  return candidate;
}

async function finishRender(r) {
  r.status = { phase: 'finalizing', progress: 0 };
  try {
    if (r.mode === 'raw') {
      await new Promise((resolve) => { if (r.encoderExit != null) return resolve(); r.proc.on('close', resolve); r.proc.stdin.end(); });
      if (r.encoderExit !== 0) throw new Error('Video encoder failed: ' + (r.encoderError || 'unknown error').slice(0, 400));
    } else {
      const parts = [];
      for (let i = 0; i < r.streams.length; i++) if (r.streams[i]) parts.push(i);
      if (!parts.length) throw new Error('The browser sent no video data.');
      await Promise.all(parts.map((i) => new Promise((resolve, reject) => r.streams[i].end((e) => (e ? reject(e) : resolve())))));
      // every part is an elementary stream that starts with an Annex B start code; anything else would only fail deep inside ffmpeg
      for (const i of parts) {
        const head = Buffer.alloc(8);
        const fd = await fsp.open(partPath(r, i), 'r');
        const { bytesRead } = await fd.read(head, 0, 8, 0).finally(() => fd.close());
        const ok = bytesRead >= 4 && head[0] === 0 && head[1] === 0 && (head[2] === 1 || (head[2] === 0 && head[3] === 1));
        if (!ok) throw new Error(bytesRead === 0 ? 'The browser sent no video data.' : 'The browser\u2019s encoder produced a stream without start codes, which Liner could not read. Reload the page and try again, or switch to H.264.');
      }
      // the parts were encoded side by side; back to back they are one stream (each part begins with a keyframe and its
      // parameter sets), so ffmpeg reads them in a row through its concat protocol instead of a copy being written first
      if (parts.length === 1) await fsp.rename(partPath(r, parts[0]), r.videoPath);
      else r.videoInput = 'concat:' + parts.map((i) => path.basename(partPath(r, i))).join('|');
    }
    r.status = { phase: 'audio', progress: 0 };
    const out = await uniqueExportPath(r.fileName);
    r.outPath = out;
    const audioReady = r.audioJob ? await r.audioJob.done : false;
    await mux(r, out, audioReady && fs.existsSync(r.audioJob.file) ? r.audioJob.file : null);
    const st = await fsp.stat(out);
    const probe = await probeOutput(out);
    let warning = null;
    if (probe && r.frames && Math.abs(probe.frames - r.frames) > 1) warning = `The file has ${probe.frames} frames but ${r.frames} were rendered.`;
    else if (probe && Math.abs(probe.videoDuration - probe.duration) > 0.5) warning = `Video (${probe.videoDuration.toFixed(2)} s) and audio (${probe.duration.toFixed(2)} s) lengths differ.`;
    r.status = { phase: 'done', progress: 1, file: out, size: st.size, sizeText: fmtBytes(st.size), probe, warning };
    log(`render ${r.rid}: done → ${out} (${fmtBytes(st.size)}${probe ? `, ${probe.frames} frames, ${probe.duration.toFixed(2)} s` : ''})${warning ? ' — ' + warning : ''}`);
  } catch (e) {
    r.status = { phase: 'error', progress: 0, error: e.message };
    log(`render ${r.rid}: failed —`, e.message);
    if (r.outPath) { const st = await fsp.stat(r.outPath).catch(() => null); if (st && st.size === 0) await fsp.rm(r.outPath, { force: true }).catch(() => {}); } // no empty leftovers
  } finally {
    r.finishedAt = Date.now();
    await fsp.rm(r.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Feeds the mix's PCM to an ffmpeg stdin: lead silence, each song's trimmed range with its fades and gains, the gaps
// (or, with a crossfade, the end of each song held back and blended equal-power into the start of the next), tail.
async function feedPcm(r, proc) {
  const write = (buf) => new Promise((res) => { if (proc.stdin.destroyed) return res(); if (!proc.stdin.write(buf)) proc.stdin.once('drain', res); else res(); });
  const xf = r.crossfade > 0;
  let tail = null; // the previous song's last frames, waiting to blend into this one's first
  try {
    await write(silence(Math.round(r.lead * SAMPLE_RATE)));
    for (let i = 0; i < r.songs.length; i++) {
      if (r.cancelled || proc.stdin.destroyed) break;
      const q = r.parts[i];
      const src = fs.createReadStream(path.join(songDir(q.song.id), 'pcm.raw'), { start: q.startFrame * BYTES_PER_FRAME, end: q.endFrame * BYTES_PER_FRAME - 1, highWaterMark: PCM_CHUNK });
      let frame = 0;
      const total = q.endFrame - q.startFrame;
      const lin = Math.pow(10, ((q.gainDb || 0) + (q.userGain || 0)) / 20);
      const holdFrames = xf && i < r.songs.length - 1 ? r.overlaps[i + 1] : 0; // kept back for the blend into the next song
      const headTotal = tail ? tail.length / BYTES_PER_FRAME : 0;
      let headLeft = headTotal, headPos = 0, pending = Buffer.alloc(0);
      for await (let chunk of src) {
        if (proc.stdin.destroyed) break;
        const frames = chunk.length / BYTES_PER_FRAME;
        if (Math.abs(lin - 1) > 1e-6 || (q.fadeIn && frame < q.fadeIn) || (q.fadeOut && frame + frames > total - q.fadeOut)) chunk = applyFades(Buffer.from(chunk), frame, total, q.fadeIn, q.fadeOut, lin);
        frame += frames;
        if (headLeft > 0) { // this song's start under the previous song's end
          const n = Math.min(headLeft, frames);
          await write(blendTail(tail, headPos, chunk.subarray(0, n * BYTES_PER_FRAME), headTotal));
          headPos += n; headLeft -= n;
          chunk = chunk.subarray(n * BYTES_PER_FRAME);
          if (!chunk.length) continue;
        }
        if (holdFrames) {
          pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
          const keep = holdFrames * BYTES_PER_FRAME;
          if (pending.length > keep) { await write(pending.subarray(0, pending.length - keep)); pending = pending.subarray(pending.length - keep); }
        } else await write(chunk);
      }
      tail = holdFrames ? pending : null;
      if (!xf && i < r.songs.length - 1) await write(silence(Math.round(r.gap * SAMPLE_RATE)));
    }
    if (tail && tail.length) await write(tail); // nothing followed (stopped early): let the held-back end out as it is
    await write(silence(Math.round(r.tail * SAMPLE_RATE)));
  } catch (e) { log('pcm feed error', e.message); }
  proc.stdin.end();
}
// equal-power blend of the previous song's held-back frames (from frame `pos` of `total`) with the next song's first frames
function blendTail(tail, pos, head, total) {
  const frames = head.length / BYTES_PER_FRAME, out = Buffer.alloc(head.length);
  for (let f = 0; f < frames; f++) {
    const u = (pos + f) / Math.max(1, total), ga = Math.cos((u * Math.PI) / 2), gb = Math.sin((u * Math.PI) / 2);
    for (let ch = 0; ch < 2; ch++) {
      const o = f * BYTES_PER_FRAME + ch * 3, oa = (pos + f) * BYTES_PER_FRAME + ch * 3;
      let a = tail[oa] | (tail[oa + 1] << 8) | (tail[oa + 2] << 16); if (a & 0x800000) a -= 0x1000000;
      let b = head[o] | (head[o + 1] << 8) | (head[o + 2] << 16); if (b & 0x800000) b -= 0x1000000;
      let v = Math.round(a * ga + b * gb);
      if (v > 8388607) v = 8388607; else if (v < -8388608) v = -8388608;
      out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; out[o + 2] = (v >> 16) & 0xff;
    }
  }
  return out;
}
const audioCodecArgs = (r) => (r.audio === 'alac' ? ['-c:a', caps.alac || 'alac'] : ['-c:a', caps.aac || 'aac', '-b:a', `${r.audioBitrate}k`]);
// The soundtrack is encoded as soon as the render starts, in parallel with the frames; the final mux then only copies it.
function startAudio(r) {
  const file = path.join(r.dir, 'audio.m4a');
  const bassChain = bassFilter(r.bass);
  const args = ['-y', '-v', 'error', '-nostats', '-f', 's24le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', 'pipe:0', ...(bassChain ? ['-filter:a', bassChain] : []), ...audioCodecArgs(r), '-movflags', '+faststart', file];
  const proc = spawn(FFMPEG, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  proc.stdin.on('error', () => {});
  const done = new Promise((resolve) => { proc.on('error', () => resolve(false)); proc.on('close', (code) => { if (code !== 0 && !r.cancelled) log(`render ${r.rid}: early audio encode failed (${code}): ${err.trim().slice(0, 200)}; the mux will encode it instead`); resolve(code === 0); }); });
  r.audioJob = { proc, file, done };
  feedPcm(r, proc);
}
function mux(r, out, audioFile = null) {
  return new Promise((resolve, reject) => {
    const between = r.crossfade > 0 ? -(r.overlaps || []).reduce((a, b) => a + b, 0) : Math.round(r.gap * SAMPLE_RATE) * (r.songs.length - 1);
    const totalFrames = r.parts.reduce((a, q) => a + (q.endFrame - q.startFrame), 0) + Math.round((r.lead + r.tail) * SAMPLE_RATE) + between;
    const totalSec = totalFrames / SAMPLE_RATE;
    const videoIn = r.mode === 'raw' ? ['-i', r.videoPath] : ['-framerate', String(r.fps), '-f', r.codec, '-i', r.videoInput || r.videoPath];
    const audioArgs = audioFile ? ['-c:a', 'copy'] : audioCodecArgs(r);
    const colour = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];
    // The browser's elementary stream carries no timestamps: stamp every frame at exactly 1/fps (90 kHz track clock)
    // and tag the bitstream as BT.709. The raw path already comes out of ffmpeg with proper timing.
    const TB = 90000, step = Math.round(TB / r.fps);
    const bsf = r.mode === 'raw' ? [] : ['-bsf:v', `setts=time_base=1/${TB}:pts=N*${step}:dts=N*${step}:duration=${step},${r.codec}_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0`];
    const bassChain = audioFile ? '' : bassFilter(r.bass);
    const audioIn = audioFile ? ['-i', audioFile] : ['-f', 's24le', '-ar', String(SAMPLE_RATE), '-ac', '2', '-i', 'pipe:0'];
    const args = ['-y', '-v', 'error', '-nostats', '-progress', 'pipe:1', ...videoIn, ...audioIn,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', ...bsf, ...(bassChain ? ['-filter:a', bassChain] : []), ...audioArgs, ...colour,
      '-video_track_timescale', String(TB),
      '-tag:v', r.codec === 'hevc' ? 'hvc1' : 'avc1', '-movflags', '+faststart',
      '-metadata', `title=${r.title || r.fileName}`, '-metadata', 'encoder=Liner', out];
    const proc = spawn(FFMPEG, args, { stdio: [audioFile ? 'ignore' : 'pipe', 'pipe', 'pipe'], cwd: r.dir }); // the concat input names its parts relative to the render folder
    r.proc = proc;
    let err = '';
    proc.stderr.on('data', (d) => { err += d; });
    proc.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_us=(\d+)/g);
      if (m) { const us = +m[m.length - 1].slice(12); r.status.progress = Math.min(1, us / 1e6 / totalSec); }
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (r.cancelled) return reject(new Error('Cancelled.'));
      if (code === 0) resolve(); else reject(new Error('Muxing failed: ' + (err.trim() || `ffmpeg exit ${code}`).slice(0, 400)));
    });
    if (!audioFile) { proc.stdin.on('error', () => {}); feedPcm(r, proc); }
  });
}

async function cancelRender(r) {
  r.cancelled = true;
  r.status = { phase: 'cancelled', progress: 0 };
  try { if (r.proc) r.proc.kill('SIGKILL'); } catch {}
  try { if (r.audioJob && r.audioJob.proc) r.audioJob.proc.kill('SIGKILL'); } catch {}
  for (const st of r.streams || []) { try { if (st) st.destroy(); } catch {} }
  await fsp.rm(r.dir, { recursive: true, force: true }).catch(() => {});
  renders.delete(r.rid);
}

// ---------------------------------------------------------------- file serving
async function sendFile(req, res, file, type, { ranges = false, cache = 'no-cache' } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { res.writeHead(404); return res.end('Not found'); }
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': ranges ? 'bytes' : 'none', 'Last-Modified': st.mtime.toUTCString() };
  const range = ranges && req.headers.range && req.headers.range.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    let start = range[1] === '' ? Math.max(0, st.size - (+range[2] || 0)) : +range[1];
    let end = range[2] === '' || range[1] === '' ? st.size - 1 : Math.min(+range[2], st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------- router
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = (re) => p.match(re);
  let g;

  if (p.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return json(res, 403, { error: 'Requests from other origins are refused.' });
    if (p === '/api/health') return json(res, 200, { ok: !!caps.ffmpeg, caps, version: APP_VERSION, pid: process.pid, platform: process.platform, busy: [...renders.values()].some((r) => r.status.phase === 'rendering' || r.status.phase === 'finalizing' || r.status.phase === 'audio') || activeJobs.size > 0 || analysisPending.size > 0 || spectrumPending.size > 0 || backgroundJobs.size > 0 || ownVideoJobs.size > 0, exportsDir: EXPORTS, downloadsDir: DOWNLOADS, mixesDir: MIXES });

    if (p === '/api/songs' && req.method === 'GET') return json(res, 200, [...songs.values()].map(publicMeta));
    if (p === '/api/songs' && req.method === 'POST') {
      const name = headerName(req, 'audio');
      const meta = await ingestUpload(req, name);
      return json(res, 200, publicMeta(meta));
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)$/))) {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (req.method === 'GET') return json(res, 200, publicMeta(s));
      if (req.method === 'DELETE') { songs.delete(s.id); if (s.ownVideo) deleteBackground(s.ownVideo).catch(() => {}); await fsp.rm(songDir(s.id), { recursive: true, force: true }); return json(res, 200, { ok: true }); }
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/video$/)) && req.method === 'POST') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (!s.hasVideo && !s.sourceUrl) return json(res, 409, { error: 'This song has no video of its own.' });
      prepareOwnVideo(s);
      return json(res, 200, publicMeta(s));
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/cover$/))) {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      const dir = songDir(s.id);
      if (req.method === 'GET') return sendFile(req, res, path.join(dir, 'cover.png'), 'image/png', { cache: 'private, max-age=31536000, immutable' });
      if (req.method === 'POST') {
        const tmp = path.join(dir, 'upload-' + crypto.randomBytes(3).toString('hex'));
        try {
          await pipeline(req, fs.createWriteStream(tmp));
          await convertImage(tmp, path.join(dir, 'cover.png'));
          s.cover = true; s.customCover = true; s.coverVersion = (s.coverVersion || 0) + 1; s.coverMode = 'custom';
          const size = await imageSize(path.join(dir, 'cover.png'));
          s.coverInfo = { label: 'Your image', w: size ? size.w : 0, h: size ? size.h : 0 };
          await saveMeta(s);
          return json(res, 200, publicMeta(s));
        } catch (e) {
          return json(res, 415, { error: 'That image could not be read.' });
        } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
      }
      if (req.method === 'DELETE') {
        const emb = path.join(dir, 'cover-embedded.png');
        if (fs.existsSync(emb)) { await fsp.copyFile(emb, path.join(dir, 'cover.png')); s.cover = true; s.coverMode = s.midi ? 'midi' : s.coverMode === 'link' || (s.coverInfo && /link/i.test(s.coverInfo.label)) ? 'link' : 'embedded'; await setCoverInfo(s, dir, s.coverMode === 'midi' ? 'Piano roll of the notes' : s.coverMode === 'link' ? 'Thumbnail from the link' : 'Embedded in the file'); }
        else { await fsp.rm(path.join(dir, 'cover.png'), { force: true }); s.cover = false; s.coverMode = 'none'; s.coverInfo = null; }
        s.customCover = false; s.coverVersion = (s.coverVersion || 0) + 1;
        await saveMeta(s);
        return json(res, 200, publicMeta(s));
      }
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/cover\/(use|none)$/)) && req.method === 'POST') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (g[2] === 'none') {
        await fsp.rm(path.join(songDir(s.id), 'cover.png'), { force: true });
        s.cover = false; s.customCover = false; s.coverMode = 'none'; s.coverInfo = null; s.coverVersion = (s.coverVersion || 0) + 1;
        await saveMeta(s);
        return json(res, 200, publicMeta(s));
      }
      const { candidate } = await readJson(req);
      const c = artCandidates.get(String(candidate || ''));
      if (!c || !fs.existsSync(path.join(ART_DIR, `${c.id}.png`))) return json(res, 404, { error: 'That artwork is no longer available. Search again.' });
      await applyCandidateCover(s, c);
      return json(res, 200, publicMeta(s));
    }
    if (p === '/api/art/search' && req.method === 'POST') {
      const body = await readJson(req);
      return json(res, 200, await findCoverArt({ title: String(body.title || ''), artist: String(body.artist || ''), album: String(body.album || '') }));
    }
    if ((g = m(/^\/api\/art\/([a-f0-9]{16})$/)) && req.method === 'GET') return sendFile(req, res, path.join(ART_DIR, `${g[1]}.png`), 'image/png', { cache: 'private, max-age=86400' });
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/headroom$/)) && req.method === 'GET') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (!s.ready) return json(res, 409, { error: 'This song is still being prepared.' });
      const gain = clampInt(+url.searchParams.get('gain') || 0, 0, 15);
      const peakDb = await measureBoostedPeak(s, gain);
      return json(res, 200, { gain, peakDb, gainDb: headroomGain(peakDb) });
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/waveform$/)) && req.method === 'GET') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (!s.ready) return json(res, 409, { error: 'This song is still being prepared.' });
      return json(res, 200, await waveformOf(s));
    }
    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/preview\.m4a$/))) {
      const s = songs.get(g[1]);
      if (!s) { res.writeHead(404); return res.end(); }
      return sendFile(req, res, path.join(songDir(s.id), 'preview.m4a'), 'audio/mp4', { ranges: true });
    }

    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/analysis$/)) && req.method === 'GET') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (!s.ready) return json(res, 409, { error: 'This song is still being prepared.' });
      return json(res, 200, await analysisOf(s));
    }

    if ((g = m(/^\/api\/songs\/([a-f0-9]+)\/spectrum$/)) && req.method === 'GET') {
      const s = songs.get(g[1]);
      if (!s) return json(res, 404, { error: 'Unknown song' });
      if (!s.ready) return json(res, 409, { error: 'This song is still being prepared.' });
      return sendFile(req, res, await spectrumOf(s), 'application/octet-stream', { cache: 'private, max-age=31536000, immutable' });
    }

    if (p === '/api/logos' && req.method === 'GET') return json(res, 200, await listLogos());
    if (p === '/api/logos' && req.method === 'POST') { const name = headerName(req, 'logo'); return json(res, 200, await ingestLogo(req, name)); }
    if ((g = m(/^\/api\/logos\/([a-f0-9]+)(\.png)?$/))) {
      const file = path.join(LOGOS, `${g[1]}.png`);
      if (g[2] && req.method === 'GET') return sendFile(req, res, file, 'image/png', { cache: 'private, max-age=31536000, immutable' });
      if (!g[2] && req.method === 'DELETE') { await fsp.rm(file, { force: true }); await fsp.rm(path.join(LOGOS, `${g[1]}.json`), { force: true }); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/sprites' && req.method === 'GET') return json(res, 200, listSprites());
    if (p === '/api/sprites' && req.method === 'POST') { const { name } = await readJson(req); return json(res, 200, publicSprite(await createSprite(name))); }
    if ((g = m(/^\/api\/sprites\/([a-f0-9]+)(?:\/(source|build|atlas\.png|thumb\.png))?$/))) {
      const sp = getSprite(g[1]);
      if (!sp) return json(res, 404, { error: 'Unknown dancer' });
      const action = g[2];
      if (!action && req.method === 'GET') return json(res, 200, publicSprite(sp));
      if (!action && req.method === 'PATCH') { const { name } = await readJson(req); return json(res, 200, publicSprite(await renameSprite(sp, name))); }
      if (!action && req.method === 'DELETE') { await deleteSprite(sp.id); return json(res, 200, { ok: true }); }
      if (action === 'source' && req.method === 'POST') { const name = headerName(req, 'frame'); return json(res, 200, publicSprite(await addSource(sp, req, name))); }
      if (action === 'build' && req.method === 'POST') { const body = await readJson(req); return json(res, 200, publicSprite(await buildSprite(sp, body))); }
      if (action === 'atlas.png' && req.method === 'GET') return sendFile(req, res, path.join(spriteDir(sp.id), 'atlas.png'), 'image/png', { cache: 'private, max-age=31536000, immutable' });
      if (action === 'thumb.png' && req.method === 'GET') return sendFile(req, res, path.join(spriteDir(sp.id), 'thumb.png'), 'image/png', { cache: 'private, max-age=3600' });
    }

    if (p === '/api/backgrounds' && req.method === 'GET') return json(res, 200, listBackgrounds());
    if (p === '/api/backgrounds' && req.method === 'POST') { const name = headerName(req, 'video'); return json(res, 200, await ingestBackground(req, name)); }
    if ((g = m(/^\/api\/backgrounds\/([a-f0-9]+)(?:\/(video\.mp4|stream\.h264|poster\.jpg))?$/))) {
      const b = getBackground(g[1]);
      if (!b) return json(res, 404, { error: 'Unknown video' });
      const action = g[2];
      if (!action && req.method === 'GET') return json(res, 200, b);
      if (!action && req.method === 'DELETE') { await deleteBackground(b.id); return json(res, 200, { ok: true }); }
      if (!b.ready) return json(res, 409, { error: b.error || 'That video is still being prepared.' });
      const immutable = 'private, max-age=31536000, immutable';
      if (action === 'video.mp4' && req.method === 'GET') return sendFile(req, res, path.join(backgroundDir(b.id), 'video.mp4'), 'video/mp4', { ranges: true, cache: immutable });
      if (action === 'stream.h264' && req.method === 'GET') return sendFile(req, res, path.join(backgroundDir(b.id), 'stream.h264'), 'application/octet-stream', { ranges: true, cache: immutable });
      if (action === 'poster.jpg' && req.method === 'GET') return sendFile(req, res, path.join(backgroundDir(b.id), 'poster.jpg'), 'image/jpeg', { cache: immutable });
    }

    if (p === '/api/links' && req.method === 'GET') return json(res, 200, [...jobs.values()].map(publicJob).sort((a, b) => a.createdAt - b.createdAt));
    if (p === '/api/links/resolve' && req.method === 'POST') {
      const { urls } = await readJson(req);
      const clean = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 50);
      if (!clean.length) return json(res, 400, { error: 'Paste a link that starts with http:// or https://.' });
      return json(res, 200, await resolveLinks(clean));
    }
    if (p === '/api/links/download' && req.method === 'POST') {
      if (!ytdlpBin) return json(res, 501, { error: 'yt-dlp is not installed.' });
      const { items } = await readJson(req);
      const list = (Array.isArray(items) ? items : []).filter((i) => i && /^https?:\/\//i.test(String(i.url))).slice(0, 200);
      return json(res, 200, list.map((i) => publicJob(createJob(i))));
    }
    if ((g = m(/^\/api\/links\/([a-f0-9]+)(?:\/(add|cancel|thumb))?$/))) {
      const j = jobs.get(g[1]);
      if (!j) return json(res, 404, { error: 'Unknown download' });
      const action = g[2];
      if (action === 'thumb' && req.method === 'GET') { if (!j.thumb) { res.writeHead(404); return res.end(); } return sendFile(req, res, j.thumb, 'image/png', { cache: 'private, max-age=3600' }); }
      if (action === 'add' && req.method === 'POST') {
        if (!(j.status === 'ready' || j.status === 'added') || !j.file || !fs.existsSync(j.file)) return json(res, 409, { error: 'This download is not ready yet.' });
        const meta = await ingestPath(j.file, path.basename(j.file), { title: j.title, artist: j.artist, album: j.album, coverPath: j.thumb, sourceUrl: j.url });
        j.status = 'added'; j.songId = meta.id; saveJobs();
        return json(res, 200, { song: publicMeta(meta), job: publicJob(j) });
      }
      if ((action === 'cancel' && req.method === 'POST') || (!action && req.method === 'DELETE')) { await cancelJob(j); return json(res, 200, { ok: true }); }
    }

    if (p === '/api/render/start' && req.method === 'POST') {
      const r = await startRender(await readJson(req));
      return json(res, 200, { rid: r.rid });
    }
    if ((g = m(/^\/api\/render\/([a-f0-9]+)\/(chunk|finish|status|cancel)$/))) {
      const r = renders.get(g[1]);
      if (!r) return json(res, 404, { error: 'Unknown render' });
      const action = g[2];
      if (action === 'status') return json(res, 200, r.status);
      if (action === 'chunk' && req.method === 'POST') {
        const refuse = r.status.phase !== 'rendering' ? 'Render is not accepting frames.'
          : r.mode === 'raw' && r.encoderExit != null ? 'Video encoder stopped: ' + (r.encoderError || '').slice(0, 300) : null;
        if (refuse) { // drain the body first so the browser gets the answer instead of a connection reset
          await new Promise((resolve) => { req.on('end', resolve); req.on('error', resolve); req.resume(); });
          return json(res, r.encoderExit != null ? 500 : 409, { error: refuse });
        }
        await appendChunk(r, req, clampInt(+url.searchParams.get('part') || 0, 0, 3));
        return json(res, 200, { ok: true });
      }
      if (action === 'finish' && req.method === 'POST') {
        if (r.status.phase !== 'rendering') return json(res, 409, { error: 'Render already finishing.' });
        finishRender(r);
        return json(res, 200, { ok: true });
      }
      if (action === 'cancel' && req.method === 'POST') { await cancelRender(r); return json(res, 200, { ok: true }); }
    }
    if (p === '/api/mixes' && req.method === 'GET') return json(res, 200, await listSavedMixes());
    if (p === '/api/mixes/save' && req.method === 'POST') { const body = await readJson(req); return json(res, 200, await saveMix(body)); }
    if (p === '/api/mixes/load' && req.method === 'POST') { const body = await readJson(req); return json(res, 200, await loadMix(body)); }
    if ((p === '/api/reveal' || p === '/api/open') && req.method === 'POST') { // only files inside Exports/
      const { file } = await readJson(req);
      const abs = typeof file === 'string' ? path.resolve(file) : '';
      const rel = abs ? path.relative(EXPORTS, abs) : '';
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(abs)) return json(res, 400, { error: 'Bad path' });
      openInSystem(abs, p === '/api/reveal');
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'Not found' });
  }

  // static
  // the page, its scripts and its stylesheet carry the version in their URLs (added here on the way out), so a new
  // version is never served from a browser's stale copy; the files themselves stay plain
  if (p === '/' || p === '/index.html' || /^\/[\w-]+\.js$/.test(p)) {
    const f = path.join(PUBLIC, p === '/' ? 'index.html' : p.slice(1));
    let text;
    try { text = await fsp.readFile(f, 'utf8'); } catch { res.writeHead(404); return res.end(); }
    text = text
      .replace(/((?:src|href)=")([\w-]+\.(?:js|css))"/g, `$1$2?v=${APP_VERSION}"`)
      .replace(/(from\s+['"]\.\/[\w-]+\.js)(['"])/g, `$1?v=${APP_VERSION}$2`);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(text);
  }
  const file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : safeDecode(p)));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return sendFile(req, res, file, type);
}

// ---------------------------------------------------------------- supervisor
// `node server.mjs` runs a small supervisor that starts the real server as a child process and starts it again
// whenever one of its modules (server.mjs, analysis.mjs, sprites.mjs, backgrounds.mjs, midi.mjs) changes on disk (once no export, download or analysis is in flight),
// so an update never needs a manual restart. Ctrl-C stops both. LINER_NO_SUPERVISOR=1 runs the server directly.
const isSupervisor = !process.env.LINER_CHILD && !process.env.LINER_NO_SUPERVISOR;
function supervise() {
  const SELF = ['server.mjs', 'sprites.mjs', 'analysis.mjs', 'backgrounds.mjs', 'midi.mjs'].map((f) => path.join(ROOT, f));
  let child = null, wantRestart = false, lastStart = 0, backoff = 1000, stopping = false, timer = null;
  const start = () => {
    lastStart = Date.now();
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, LINER_CHILD: '1' } });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      if (wantRestart) { wantRestart = false; backoff = 1000; start(); return; }
      backoff = Date.now() - lastStart < 3000 ? Math.min(10000, backoff * 2) : 1000; // a crash loop (a half-saved edit, say) backs off
      log(`server stopped (${signal || `exit ${code}`}); starting it again in ${backoff / 1000} s`);
      setTimeout(start, backoff);
    });
  };
  const restartWhenIdle = async () => {
    try {
      const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) })).json();
      if (h.busy) { log('code changed; restarting once the current export or download has finished'); timer = setTimeout(restartWhenIdle, 3000); return; }
    } catch { /* not answering: restart anyway */ }
    for (const f of SELF) { try { await run(process.execPath, ['--check', f]); } catch { log(`code changed, but ${path.basename(f)} does not parse yet; waiting for the next save`); return; } }
    log('code changed → restarting the server');
    wantRestart = true;
    if (child) child.kill('SIGTERM'); else start();
  };
  // the folder is watched (one event-driven watcher, no polling); a change to one of the modules, judged by its
  // modification time so that unrelated files in the folder never cause a restart, schedules the restart
  const mtimes = new Map(SELF.map((f) => { try { return [f, fs.statSync(f).mtimeMs]; } catch { return [f, 0]; } }));
  const changed = () => { let any = false; for (const f of SELF) { let m = 0; try { m = fs.statSync(f).mtimeMs; } catch { /* mid-save */ } if (m && m !== mtimes.get(f)) { mtimes.set(f, m); any = true; } } return any; };
  let probe = null;
  const onEvent = () => { clearTimeout(probe); probe = setTimeout(() => { if (changed()) { clearTimeout(timer); timer = setTimeout(restartWhenIdle, 600); } }, 200); };
  try { fs.watch(ROOT, { persistent: true }, onEvent); }
  catch { for (const f of SELF) fs.watchFile(f, { interval: 1000 }, onEvent); } // a file system without change events
  const stop = () => { if (stopping) return; stopping = true; if (child) child.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  start();
}

// ---------------------------------------------------------------- boot
if (isSupervisor) supervise();
else {
  await Promise.all([fsp.mkdir(SONGS, { recursive: true }), fsp.mkdir(EXPORTS, { recursive: true }), fsp.mkdir(DOWNLOADS, { recursive: true })]);
  await fsp.rm(RENDERS, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(RENDERS, { recursive: true });
  pruneArtCache().catch(() => {});
  await detectCapabilities();
  await loadSongs();
  await loadJobs();
  await initSprites({ dir: SPRITES, run, ffmpeg: FFMPEG, ffprobe: FFPROBE, log });
  await initBackgrounds({ dir: BACKGROUNDS, run, ffmpeg: FFMPEG, ffprobe: FFPROBE, log, encoder: caps.x264 ? 'libx264' : caps.h264 });
  await initMidi({ root: ROOT, cacheDir: CACHE, run, ffmpeg: FFMPEG, log });

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      const status = e.status || 500;
      if (status >= 500) log('error', req.method, req.url, e.stderr ? String(e.stderr).slice(0, 300) : e.message);
      if (!res.headersSent) json(res, status, { error: e.status ? e.message : (e.stderr ? 'ffmpeg: ' + String(e.stderr).trim().split('\n').pop().slice(0, 200) : e.message) });
      else res.end();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60000;
  server.timeout = 0;
  process.on('SIGTERM', () => { log('stopping (restart)'); process.exit(0); });
  server.listen(PORT, '127.0.0.1', () => {
    log(`Liner ${APP_VERSION} · http://localhost:${PORT}  (ffmpeg ${caps.ffmpeg || 'missing'}; video ${caps.h264 || '-'} / ${caps.hevc || '-'}; audio ${caps.aac || '-'} / ${caps.alac || '-'})`);
    log(`Exports → ${EXPORTS}`);
    log(`Downloads → ${DOWNLOADS} (yt-dlp ${caps.ytdlp || 'missing'})`);
  });
}
