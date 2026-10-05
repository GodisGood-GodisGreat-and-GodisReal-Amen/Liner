// Liner — MIDI files as songs. A .mid file holds notes, not sound, so it is rendered to audio on import with the
// best synthesizer at hand: FluidSynth with a SoundFont when both are installed, the General MIDI synthesizer
// built into macOS (through tools/midi-render.swift, compiled on first use), or Liner's own synthesizer below,
// which needs nothing at all. The notes also become the song's cover: a piano roll.
//
// The built-in synthesizer runs in a worker thread (this file is its entry too, see the bottom): wavetable voices
// with bright/dark crossfades for every General MIDI program, procedural drums, a small reverb, written as a
// 24-bit WAV peak-normalised to -1 dBFS.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const MAX_FILE = 16 * 1024 * 1024;
const MAX_SECONDS = 60 * 60;
const err = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------------------------------------------------------------- the file
// where the MThd header starts, or -1 (a RIFF-wrapped .rmi carries it a few bytes in)
export function midiOffset(buf) {
  const n = Math.min(buf.length - 4, 4096);
  for (let i = 0; i <= n; i++) if (buf[i] === 0x4d && buf[i + 1] === 0x54 && buf[i + 2] === 0x68 && buf[i + 3] === 0x64) return i;
  return -1;
}
export const MIDI_EXT = /\.(mid|midi|kar|rmi|smf)$/i;

function text(data) {
  let s = data.toString('utf8');
  if (s.includes('\ufffd')) s = data.toString('latin1');
  return s.replace(/[\x00-\x1f]+/g, ' ').trim();
}
const GENERIC_NAME = /^(untitled|track\s*\d*|melody|piano|drums?|bass|lead|pad|strings|guitar|vocals?|chords?|seq(uence)?\s*\d*|midi\s*\d*|tempo( track)?|master|conductor)$/i;

// Reads a Standard MIDI File into a flat, time-stamped event list, the notes with their lengths, and what the
// file says about itself (a name, a copyright). Tempo changes are honoured; SMPTE time divisions too.
export function parseMidi(buf) {
  const at = midiOffset(buf);
  if (at < 0) throw err('This is not a MIDI file.', 415);
  let p = at + 4;
  const headerLen = buf.readUInt32BE(p); p += 4;
  const format = buf.readUInt16BE(p); const ntrks = buf.readUInt16BE(p + 2); const division = buf.readUInt16BE(p + 4);
  p = at + 8 + headerLen;
  const smpte = (division & 0x8000) !== 0;
  const fps = smpte ? 256 - (division >> 8) : 0, tpf = division & 0xff, ppq = smpte ? 0 : (division || 96);
  const tracks = [], tempos = [], texts = [], copyrights = [];
  let seqName = '', timeSig = null;
  const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < buf.length); return v; };
  for (let k = 0; k < ntrks && p + 8 <= buf.length; k++) {
    const id = buf.toString('latin1', p, p + 4), len = buf.readUInt32BE(p + 4); p += 8;
    const end = Math.min(buf.length, p + len);
    if (id !== 'MTrk') { p = end; continue; }
    const events = []; let tick = 0, status = 0, name = '';
    while (p < end) {
      tick += vlq();
      if (p >= end) break;
      let s = buf[p];
      if (s < 0x80) { if (!status) { p++; continue; } s = status; } else { p++; if (s < 0xf0) status = s; }
      if (s === 0xff) {
        const type = buf[p++], l = vlq(), data = buf.subarray(p, p + l); p += l;
        if (type === 0x51 && l >= 3) tempos.push({ tick, us: (data[0] << 16) | (data[1] << 8) | data[2] });
        else if (type === 0x03) { const t = text(data); if (!name) name = t; if (k === 0 && !seqName) seqName = t; }
        else if (type === 0x01) texts.push(text(data));
        else if (type === 0x02) copyrights.push(text(data));
        else if (type === 0x58 && l >= 2 && !timeSig) timeSig = { n: data[0], d: 2 ** data[1] };
        else if (type === 0x2f) p = end;
        continue;
      }
      if (s === 0xf0 || s === 0xf7) { const l = vlq(); p += l; continue; }
      const hi = s & 0xf0, ch = s & 0x0f;
      if (hi === 0xc0 || hi === 0xd0) { const a = buf[p++]; events.push({ tick, ch, type: hi === 0xc0 ? 'prog' : 'press', a, b: 0 }); continue; }
      const a = buf[p++] & 0x7f, b = buf[p++] & 0x7f;
      if (hi === 0x90) events.push({ tick, ch, type: b ? 'on' : 'off', a, b });
      else if (hi === 0x80) events.push({ tick, ch, type: 'off', a, b });
      else if (hi === 0xb0) events.push({ tick, ch, type: 'cc', a, b });
      else if (hi === 0xe0) events.push({ tick, ch, type: 'bend', a: ((b << 7) | a) - 8192, b: 0 });
    }
    tracks.push({ name, events });
    p = end;
  }
  // the tempo map, as seconds at each change
  tempos.sort((x, y) => x.tick - y.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
  const segs = [];
  for (let i = 0, secs = 0; i < tempos.length; i++) {
    if (i > 0) secs += (tempos[i].tick - tempos[i - 1].tick) * tempos[i - 1].us / 1e6 / ppq;
    if (segs.length && segs[segs.length - 1].tick === tempos[i].tick) segs[segs.length - 1].us = tempos[i].us; else segs.push({ tick: tempos[i].tick, secs, us: tempos[i].us });
  }
  const toSec = smpte ? (tick) => tick / (fps * tpf) : (tick) => {
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].tick <= tick) lo = m; else hi = m - 1; }
    const s = segs[lo];
    return s.secs + (tick - s.tick) * s.us / 1e6 / ppq;
  };
  const rank = { off: 0, cc: 1, prog: 1, bend: 1, press: 1, on: 2 }; // at one tick: releases, then settings, then new notes
  const events = [];
  tracks.forEach((tr, ti) => { for (const e of tr.events) events.push({ ...e, t: toSec(e.tick), tr: ti }); });
  events.sort((x, y) => x.tick - y.tick || rank[x.type] - rank[y.type] || x.tr - y.tr);
  // the notes themselves
  const open = new Map(), notes = [], channels = new Set(), programs = new Array(16).fill(-1);
  for (const e of events) {
    const key = e.ch * 128 + e.a;
    if (e.type === 'on') { const prev = open.get(key); if (prev) { prev.t1 = e.t; notes.push(prev); } open.set(key, { t0: e.t, t1: null, ch: e.ch, note: e.a, vel: e.b }); channels.add(e.ch); }
    else if (e.type === 'off') { const v = open.get(key); if (v) { v.t1 = e.t; notes.push(v); open.delete(key); } }
    else if (e.type === 'prog' && programs[e.ch] < 0) programs[e.ch] = e.a;
  }
  const lastT = events.length ? events[events.length - 1].t : 0;
  for (const v of open.values()) { v.t1 = Math.max(v.t0 + 0.1, lastT); notes.push(v); }
  notes.sort((x, y) => x.t0 - y.t0);
  const duration = Math.min(MAX_SECONDS, notes.reduce((m, n) => Math.max(m, n.t1), 0));
  // a title: the sequence name when it is a real one, else a karaoke "@T" line, else nothing (the file name will do)
  let title = seqName && !GENERIC_NAME.test(seqName) && seqName.length >= 2 ? seqName : '';
  if (!title) { const kar = texts.find((t) => /^@T/.test(t)); if (kar) title = kar.slice(2).trim(); }
  if (/\.(mid|midi|kar)$/i.test(title)) title = title.replace(/\.(mid|midi|kar)$/i, '');
  return {
    format, ppq, smpte, trackCount: tracks.length, trackNames: tracks.map((t) => t.name).filter(Boolean),
    events, notes, noteCount: notes.length, duration, title: title.slice(0, 120), copyright: (copyrights[0] || '').slice(0, 200),
    channels: [...channels].sort((a, b) => a - b), programs, tempo: Math.round(60e6 / segs[0].us * 10) / 10, timeSig: timeSig || { n: 4, d: 4 },
  };
}

// ---------------------------------------------------------------- renderers
let cfg = null; // { root, cacheDir, run, ffmpeg, log }
export const midiCaps = { renderer: 'builtin', fluidsynth: null, soundfont: null, coreaudio: false, choice: null };

const SOUNDFONT_DIRS = () => [
  path.join(cfg.root, 'soundfonts'),
  '/usr/share/sounds/sf2', '/usr/share/soundfonts', '/usr/local/share/soundfonts', '/usr/local/share/sounds/sf2',
  '/opt/homebrew/share/soundfonts', '/opt/homebrew/share/sounds/sf2', path.join(os.homedir(), '.local/share/soundfonts'),
  path.join(os.homedir(), 'Library/Audio/Sounds/Banks'), path.join(os.homedir(), 'soundfonts'), 'C:\\soundfonts', 'C:\\SoundFonts',
];
async function findSoundfont() {
  const env = process.env.LINER_SOUNDFONT;
  if (env) return fs.existsSync(env) ? env : null;
  const found = [];
  for (const dir of SOUNDFONT_DIRS()) {
    const names = await fsp.readdir(dir).catch(() => []);
    for (const n of names) if (/\.sf[23]$/i.test(n)) found.push(path.join(dir, n));
  }
  if (!found.length) return null;
  const score = (f) => (/FluidR3/i.test(f) ? 3 : /GeneralUser/i.test(f) ? 2 : /default|gm/i.test(f) ? 1 : 0);
  return found.sort((a, b) => score(b) - score(a) || a.localeCompare(b))[0];
}
export async function initMidi(options) {
  cfg = options;
  await fsp.mkdir(cfg.cacheDir, { recursive: true });
  for (const bin of [process.env.FLUIDSYNTH, 'fluidsynth', '/opt/homebrew/bin/fluidsynth', '/usr/local/bin/fluidsynth'].filter(Boolean)) {
    try { const { stdout } = await cfg.run(bin, ['--version']); midiCaps.fluidsynth = { bin, version: (stdout.match(/version\s+([\d.]+)/i) || [])[1] || 'unknown' }; break; } catch { /* next */ }
  }
  midiCaps.soundfont = midiCaps.fluidsynth ? await findSoundfont() : null;
  if (process.platform === 'darwin') { try { await cfg.run('xcode-select', ['-p']); midiCaps.coreaudio = true; } catch { midiCaps.coreaudio = false; } }
  const choice = (process.env.LINER_MIDI || '').toLowerCase();
  midiCaps.choice = ['fluidsynth', 'coreaudio', 'builtin'].includes(choice) ? choice : null;
  midiCaps.renderer = preferredRenderers()[0];
  cfg.log(`midi → ${describeRenderer(midiCaps.renderer, midiCaps.soundfont)}${midiCaps.fluidsynth && !midiCaps.soundfont ? ' (fluidsynth is installed but no SoundFont was found)' : ''}`);
}
function preferredRenderers() {
  const order = [];
  if (midiCaps.fluidsynth && midiCaps.soundfont) order.push('fluidsynth');
  if (midiCaps.coreaudio) order.push('coreaudio');
  order.push('builtin');
  if (midiCaps.choice && order.includes(midiCaps.choice)) return [midiCaps.choice, ...order.filter((r) => r !== midiCaps.choice)];
  return order;
}
export function describeRenderer(renderer, soundfont) {
  if (renderer === 'fluidsynth') return `FluidSynth with ${soundfont ? path.basename(soundfont) : 'a SoundFont'}`;
  if (renderer === 'coreaudio') return 'the General MIDI synthesizer built into macOS';
  return "Liner's built-in synthesizer";
}

// Renders a MIDI file to a 48 kHz 24-bit WAV, trying the renderers in order of quality; a renderer that fails is
// logged and the next one takes over. Returns what was used and how long the music is.
export async function renderMidi(src, out, { parsed } = {}) {
  let lastError = null;
  for (const renderer of preferredRenderers()) {
    try {
      const seconds = renderer === 'fluidsynth' ? await renderFluidsynth(src, out) : renderer === 'coreaudio' ? await renderCoreAudio(src, out) : await renderBuiltin(src, out);
      return { renderer, soundfont: renderer === 'fluidsynth' ? path.basename(midiCaps.soundfont) : null, seconds };
    } catch (e) {
      lastError = e;
      if (e.status === 415) throw e; // the file itself is the problem; no renderer will do better
      cfg.log(`midi: ${renderer} failed (${String(e.message).split('\n')[0].slice(0, 160)})${renderer !== 'builtin' ? '; trying the next renderer' : ''}`);
      if (renderer === 'coreaudio') midiCaps.coreaudio = false;
    }
  }
  throw lastError || err('The MIDI file could not be rendered.');
}

async function renderFluidsynth(src, out) {
  const raw = out + '.raw.wav';
  try {
    await cfg.run(midiCaps.fluidsynth.bin, ['-niq', '-r', String(SR), '-g', '0.7', '-T', 'wav', '-O', 's24', '-F', raw, midiCaps.soundfont, src], { timeout: 10 * 60 * 1000 });
    const { stderr } = await cfg.run(cfg.ffmpeg, ['-hide_banner', '-i', raw, '-af', 'volumedetect', '-f', 'null', '-']);
    const peak = parseFloat((stderr.match(/max_volume:\s*(-?[\d.]+) dB/) || [])[1]);
    if (!Number.isFinite(peak) || peak < -80) throw err('The MIDI file played silence.', 415);
    await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', raw, '-af', `volume=${(-1 - peak).toFixed(2)}dB`, '-c:a', 'pcm_s24le', out]);
    const st = await fsp.stat(out);
    return Math.max(0, (st.size - 44) / 6 / SR);
  } finally { await fsp.rm(raw, { force: true }).catch(() => {}); }
}

// the Swift helper, compiled once per source version into the cache
let coreAudioBin = null;
async function ensureCoreAudioTool() {
  if (coreAudioBin) return coreAudioBin;
  const source = path.join(cfg.root, 'tools', 'midi-render.swift');
  const code = await fsp.readFile(source);
  const bin = path.join(cfg.cacheDir, 'tools', `midi-render-${crypto.createHash('sha1').update(code).digest('hex').slice(0, 10)}`);
  if (!fs.existsSync(bin)) {
    await fsp.mkdir(path.dirname(bin), { recursive: true });
    cfg.log('midi: compiling the macOS renderer (once)…');
    try { await cfg.run('swiftc', ['-O', '-o', bin, source], { timeout: 5 * 60 * 1000 }); }
    catch (e) { throw new Error('swiftc failed: ' + String(e.stderr || e.message).split('\n').find((l) => /error/.test(l)) || e.message); }
  }
  coreAudioBin = bin;
  return bin;
}
async function renderCoreAudio(src, out) {
  const bin = await ensureCoreAudioTool();
  try {
    const { stdout } = await cfg.run(bin, [src, out, String(SR)], { timeout: 10 * 60 * 1000 });
    return parseFloat(stdout) || 0;
  } catch (e) {
    const msg = String(e.stderr || e.message).trim();
    if (/no notes|played silence|could not read/.test(msg)) throw err(/no notes|silence/.test(msg) ? 'The MIDI file has no notes.' : 'The MIDI file could not be read.', 415);
    throw new Error(msg.split('\n').pop());
  }
}

function renderBuiltin(src, out) {
  return new Promise((resolve, reject) => {
    const w = new Worker(fileURLToPath(import.meta.url), { workerData: { linerMidiSynth: true, src, out } });
    w.once('message', (m) => (m.error ? reject(Object.assign(new Error(m.error), { status: m.status })) : resolve(m.seconds)));
    w.once('error', reject);
    w.once('exit', (code) => { if (code) reject(new Error(`synthesizer exited with code ${code}`)); });
  });
}

// ---------------------------------------------------------------- the cover: a piano roll
const COVER = 1400;
export async function drawPianoRoll(parsed, out) {
  const W = COVER, H = COVER, px = new Uint8ClampedArray(W * H * 3);
  const M = 96, AW = W - 2 * M, AH = H - 2 * M;
  // background: a deep blue-violet gradient with a soft light from the top left
  for (let y = 0; y < H; y++) {
    const fy = y / H;
    for (let x = 0; x < W; x++) {
      const fx = x / W, glow = Math.max(0, 1 - Math.hypot(fx - 0.2, fy - 0.15) * 1.3) * 0.12;
      const o = (y * W + x) * 3;
      px[o] = 16 + 12 * fy + 40 * glow; px[o + 1] = 17 + 8 * fy + 36 * glow; px[o + 2] = 30 + 24 * fy + 48 * glow;
    }
  }
  const blend = (x, y, r, g, b, a) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const o = (y * W + x) * 3; px[o] += (r - px[o]) * a; px[o + 1] += (g - px[o + 1]) * a; px[o + 2] += (b - px[o + 2]) * a; };
  const rect = (x0, y0, w, h, r, g, b, a) => { const x1 = Math.min(W, Math.round(x0 + w)), y1 = Math.min(H, Math.round(y0 + h)); for (let y = Math.max(0, Math.round(y0)); y < y1; y++) for (let x = Math.max(0, Math.round(x0)); x < x1; x++) blend(x, y, r, g, b, a); };
  const hsl = (h, s, l) => { const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)); return [255 * f(0), 255 * f(8), 255 * f(4)]; };
  const melodic = parsed.notes.filter((n) => n.ch !== 9), drums = parsed.notes.filter((n) => n.ch === 9);
  const dur = Math.max(1, parsed.duration);
  let lo = 127, hi = 0;
  for (const n of melodic) { lo = Math.min(lo, n.note); hi = Math.max(hi, n.note); }
  if (!melodic.length) { lo = 48; hi = 84; }
  const span = Math.max(36, hi - lo + 1); const mid = (lo + hi) / 2; lo = Math.round(mid - span / 2); hi = lo + span - 1;
  const rowH = AH / span, drumH = drums.length ? Math.min(60, rowH * 4) : 0, rollH = AH - drumH - (drums.length ? 18 : 0);
  const rowHm = rollH / span;
  // faint octave lines and bar lines
  for (let n = lo; n <= hi; n++) if (n % 12 === 0) rect(M, M + (hi - n) * rowHm, AW, 1, 255, 255, 255, 0.07);
  const barLen = parsed.timeSig.n * (4 / parsed.timeSig.d) * 60 / Math.max(20, parsed.tempo);
  for (let t = barLen; t < dur; t += barLen) rect(M + t / dur * AW, M, 1, AH, 255, 255, 255, 0.05);
  const tone = (ch) => { const [r, g, b] = hsl((ch * 137.508 + 210) % 360, 0.62, 0.62); return [r, g, b]; };
  for (const n of melodic) {
    const [r, g, b] = tone(n.ch), a = 0.55 + 0.45 * (n.vel / 127);
    const x = M + n.t0 / dur * AW, w = Math.max(3, (n.t1 - n.t0) / dur * AW - 1), y = M + (hi - n.note) * rowHm, h = Math.max(3, rowHm - 1.5);
    rect(x, y, w, h, r, g, b, a);
    rect(x, y, w, Math.min(1.5, h / 3), 255, 255, 255, 0.18 * a); // a highlight along the top edge
  }
  if (drums.length) {
    const y0 = M + rollH + 18;
    rect(M, y0 - 9, AW, 1, 255, 255, 255, 0.08);
    for (const n of drums) { const a = 0.35 + 0.5 * (n.vel / 127); const x = M + n.t0 / dur * AW; rect(x, y0 + (n.note % 7) / 7 * (drumH - 4), 3, 4, 214, 220, 236, a); }
  }
  // a thin frame and a title bar colour cue at the bottom
  rect(M - 1, M - 1, AW + 2, 1, 255, 255, 255, 0.1); rect(M - 1, M + AH, AW + 2, 1, 255, 255, 255, 0.1);
  await new Promise((resolve, reject) => {
    const p = spawn(cfg.ffmpeg, ['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${W}x${H}`, '-i', '-', '-frames:v', '1', '-c:v', 'png', out]);
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('exit', (code) => (code ? reject(new Error('ffmpeg: ' + stderr.trim().slice(-200))) : resolve()));
    p.stdin.on('error', () => {});
    p.stdin.end(Buffer.from(px.buffer));
  });
  return { w: W, h: H };
}

// ================================================================ the built-in synthesizer
// Wavetable voices: every General MIDI program is a pair of spectra (bright and dark) that the voice crossfades
// between over time (a piano darkens as it decays, brass brightens as it speaks), an ADSR envelope, optional
// vibrato and unison detuning. Drums are procedural (swept sines, shaped noise). A small Schroeder reverb sits
// on a send bus. Everything is mixed in 64-frame blocks between MIDI events.
const TL = 2048;
const LEVELS = [64, 32, 16, 8, 4, 2, 1];
const tableCache = new Map();
const mk = ({ roll, max = 32, even = 1, odd = 1, boost = {} }) => ({ max, amp: (h) => ((h % 2 ? odd : even) / h ** roll) + (boost[h] || 0) });
const partials = (map) => ({ max: Math.max(...Object.keys(map).map(Number)), amp: (h) => map[h] || 0 });
const SPECTRA = {
  sine: partials({ 1: 1 }),
  piano: mk({ roll: 1.15, max: 24, boost: { 1: 0.2, 2: 0.1 } }), pianoDark: mk({ roll: 2.4, max: 6 }),
  epiano: partials({ 1: 1, 2: 0.3, 3: 0.08, 4: 0.25, 5: 0.05, 6: 0.03 }), epianoDark: partials({ 1: 1, 2: 0.08 }),
  harpsi: mk({ roll: 0.75, max: 40 }), harpsiDark: mk({ roll: 1.6, max: 10 }),
  bell: partials({ 1: 1, 3: 0.25, 4: 0.4, 6: 0.12, 8: 0.05 }), bellDark: partials({ 1: 1, 4: 0.12 }),
  organ: partials({ 1: 1, 2: 0.8, 3: 0.45, 4: 0.55, 6: 0.3, 8: 0.25 }),
  nylon: mk({ roll: 1.3, max: 18 }), steel: mk({ roll: 1.0, max: 28 }), gtrDark: mk({ roll: 2.2, max: 6 }),
  dist: mk({ roll: 1.0, max: 40, even: 0.45 }), distDark: mk({ roll: 1.5, max: 16, even: 0.45 }),
  bassA: mk({ roll: 1.5, max: 12 }), bassF: mk({ roll: 1.2, max: 16 }), bassDark: mk({ roll: 2.5, max: 4 }),
  saw: mk({ roll: 1, max: 48 }), sawDark: mk({ roll: 1.6, max: 16 }), sawSoft: mk({ roll: 1.3, max: 32 }),
  square: mk({ roll: 1, max: 48, even: 0 }), squareDark: mk({ roll: 1.4, max: 16, even: 0 }),
  choir: mk({ roll: 1.7, max: 24, boost: { 2: 0.5, 3: 0.4 } }), choirDark: mk({ roll: 2.2, max: 8 }),
  brass: mk({ roll: 0.9, max: 48 }), brassDark: mk({ roll: 1.8, max: 12 }),
  sax: mk({ roll: 1.0, max: 32, even: 0.7 }), oboe: mk({ roll: 0.8, max: 32, even: 0.4 }), clar: mk({ roll: 1.1, max: 32, even: 0.12 }), reedDark: mk({ roll: 1.8, max: 8 }),
  flute: partials({ 1: 1, 2: 0.15, 3: 0.05 }),
  metallic: partials({ 1: 1, 5: 0.5, 7: 0.3, 9: 0.2 }),
  fifths: partials({ 1: 1, 2: 0.3, 3: 0.8, 4: 0.2, 6: 0.3 }),
};
function table(name, level) {
  const key = name + ':' + level;
  let t = tableCache.get(key);
  if (t) return t;
  const spec = SPECTRA[name]; t = new Float32Array(TL + 1);
  const maxH = Math.min(level, spec.max);
  for (let h = 1; h <= maxH; h++) { const a = spec.amp(h); if (!a) continue; for (let i = 0; i < TL; i++) t[i] += a * Math.sin(2 * Math.PI * h * i / TL); }
  let peak = 0; for (let i = 0; i < TL; i++) peak = Math.max(peak, Math.abs(t[i]));
  if (peak > 0) for (let i = 0; i < TL; i++) t[i] /= peak;
  t[TL] = t[0];
  tableCache.set(key, t);
  return t;
}
// a preset: spec/dark, a(ttack) d(ecay) s(ustain) r(elease) in seconds/level, pd = pitch-dependent decay base (a
// decaying instrument), bd = seconds for the bright→dark crossfade, ba = seconds for dark→bright, vib [rate, depth
// in semitones, delay], uni [voices, cents], gain, send (reverb), breath (noise at the attack)
const P = (o) => ({ spec: 'saw', dark: 'sawDark', a: 0.01, d: 0.1, s: 1, r: 0.1, pd: 0, bd: 0, ba: 0, vib: null, uni: null, gain: 1, send: 0.35, breath: 0, ...o });
const decayer = (spec, dark, pd, bd, extra = {}) => P({ spec, dark, a: 0.003, s: 0, r: 0.15, pd, bd, ...extra });
const sustainer = (spec, dark, a, extra = {}) => P({ spec, dark, a, d: 0.15, s: 0.85, r: 0.15, ...extra });
const PRESETS = new Array(128);
const set = (from, to, preset) => { for (let i = from; i <= to; i++) PRESETS[i] = preset; };
set(0, 3, decayer('piano', 'pianoDark', 3.5, 1.2, { gain: 1.0, send: 0.4 }));
set(4, 5, decayer('epiano', 'epianoDark', 3.0, 0.8));
set(6, 6, decayer('harpsi', 'harpsiDark', 1.2, 0.4, { r: 0.06 }));
set(7, 7, decayer('steel', 'gtrDark', 1.0, 0.3, { r: 0.06 }));
set(8, 9, decayer('bell', 'bellDark', 1.4, 0.6, { r: 0.3, send: 0.6 }));
set(10, 10, decayer('bell', 'bellDark', 1.6, 0.8, { r: 0.3, send: 0.6 }));
set(11, 11, decayer('bell', 'bellDark', 2.5, 1.0, { r: 0.3, vib: [5, 0.05, 0], send: 0.5 }));
set(12, 12, decayer('bell', 'bellDark', 0.5, 0.2, { r: 0.1 }));
set(13, 13, decayer('bell', 'bellDark', 0.35, 0.15, { r: 0.08 }));
set(14, 14, decayer('bell', 'bellDark', 4.0, 2.0, { r: 0.5, send: 0.7 }));
set(15, 15, decayer('harpsi', 'harpsiDark', 1.8, 0.6));
set(16, 18, P({ spec: 'organ', dark: 'organ', a: 0.006, d: 0.01, s: 1, r: 0.04, vib: [6, 0.04, 0], send: 0.3 }));
set(19, 19, P({ spec: 'organ', dark: 'organ', a: 0.04, d: 0.01, s: 1, r: 0.35, send: 0.6 }));
set(20, 20, P({ spec: 'organ', dark: 'organ', a: 0.02, d: 0.01, s: 1, r: 0.15, send: 0.4 }));
set(21, 23, sustainer('sax', 'reedDark', 0.03, { vib: [5.5, 0.06, 0.3], r: 0.08 }));
set(24, 24, decayer('nylon', 'gtrDark', 2.2, 0.5, { r: 0.1 }));
set(25, 25, decayer('steel', 'gtrDark', 2.5, 0.6, { r: 0.1 }));
set(26, 26, decayer('nylon', 'gtrDark', 1.8, 0.5, { r: 0.1 }));
set(27, 27, decayer('steel', 'gtrDark', 2.0, 0.8, { r: 0.1 }));
set(28, 28, decayer('steel', 'gtrDark', 0.3, 0.1, { r: 0.05 }));
set(29, 30, P({ spec: 'dist', dark: 'distDark', a: 0.004, d: 0.3, s: 0.7, r: 0.1, gain: 0.8 }));
set(31, 31, decayer('sine', 'sine', 1.5, 0));
set(32, 32, decayer('bassA', 'bassDark', 1.8, 0.4, { r: 0.1, gain: 1.1 }));
set(33, 33, decayer('bassF', 'bassDark', 1.6, 0.5, { r: 0.1, gain: 1.1 }));
set(34, 34, decayer('steel', 'bassDark', 1.4, 0.4, { r: 0.1, gain: 1.1 }));
set(35, 35, decayer('bassA', 'bassDark', 2.0, 0.8, { r: 0.12, vib: [5, 0.05, 0.2], gain: 1.1 }));
set(36, 37, decayer('steel', 'bassDark', 1.0, 0.25, { r: 0.08, gain: 1.1 }));
set(38, 39, P({ spec: 'saw', dark: 'sawDark', a: 0.003, d: 0.25, s: 0.5, r: 0.08, bd: 0.35, uni: [2, 5], gain: 1.1 }));
const strings = sustainer('saw', 'sawDark', 0.09, { d: 0.3, r: 0.3, vib: [5.5, 0.08, 0.35], uni: [2, 4], ba: 0.08, send: 0.5 });
set(40, 44, strings);
set(45, 45, decayer('nylon', 'gtrDark', 0.5, 0.2));
set(46, 46, decayer('nylon', 'gtrDark', 2.5, 0.8, { send: 0.6 }));
set(47, 47, decayer('sine', 'sine', 0.9, 0, { gain: 1.2, send: 0.5 }));
const ensemble = sustainer('saw', 'sawDark', 0.25, { d: 0.5, r: 0.5, vib: [5, 0.07, 0.5], uni: [3, 7], ba: 0.2, send: 0.6, gain: 0.9 });
set(48, 48, ensemble); set(50, 51, ensemble);
set(49, 49, { ...ensemble, a: 0.6, r: 0.9 });
set(52, 54, sustainer('choir', 'choirDark', 0.2, { d: 0.4, s: 0.9, r: 0.4, vib: [5, 0.08, 0.4], uni: [2, 6], send: 0.6 }));
set(55, 55, decayer('brass', 'brassDark', 0.5, 0.3, { gain: 1.1 }));
const brass = sustainer('brass', 'brassDark', 0.045, { d: 0.2, s: 0.8, r: 0.12, ba: 0.08, vib: [5, 0.05, 0.5], send: 0.4 });
set(56, 60, brass);
set(61, 61, { ...brass, a: 0.07, uni: [2, 6], gain: 0.9 });
set(62, 63, sustainer('saw', 'sawDark', 0.03, { ba: 0.05, uni: [2, 8], gain: 0.9 }));
set(64, 67, sustainer('sax', 'reedDark', 0.04, { ba: 0.05, vib: [5.5, 0.08, 0.3], r: 0.1 }));
set(68, 68, sustainer('oboe', 'reedDark', 0.03, { vib: [5.5, 0.06, 0.3], r: 0.08 }));
set(69, 70, sustainer('oboe', 'reedDark', 0.04, { vib: [5, 0.05, 0.3], r: 0.1 }));
set(71, 71, sustainer('clar', 'reedDark', 0.035, { vib: [5, 0.04, 0.4], r: 0.08 }));
set(72, 79, sustainer('flute', 'flute', 0.05, { s: 0.9, r: 0.1, vib: [5, 0.07, 0.3], breath: 0.25, send: 0.5 }));
set(80, 80, P({ spec: 'square', dark: 'squareDark', a: 0.004, d: 0.1, s: 0.9, r: 0.05, send: 0.25 }));
set(81, 81, P({ spec: 'saw', dark: 'saw', a: 0.004, d: 0.1, s: 0.9, r: 0.05, uni: [2, 7], send: 0.25 }));
set(82, 82, sustainer('flute', 'flute', 0.02, { breath: 0.15 }));
set(83, 83, P({ spec: 'square', dark: 'squareDark', a: 0.004, d: 0.1, s: 0.9, r: 0.05, breath: 0.3 }));
set(84, 84, P({ spec: 'dist', dark: 'distDark', a: 0.004, d: 0.2, s: 0.8, r: 0.08 }));
set(85, 85, sustainer('choir', 'choirDark', 0.05, { vib: [5.5, 0.08, 0.2], uni: [2, 5] }));
set(86, 86, P({ spec: 'fifths', dark: 'fifths', a: 0.005, d: 0.1, s: 0.9, r: 0.08, uni: [2, 6] }));
set(87, 87, P({ spec: 'saw', dark: 'sawDark', a: 0.004, d: 0.2, s: 0.8, r: 0.06, uni: [2, 5], bd: 0.5 }));
const pad = sustainer('sawSoft', 'sawDark', 0.5, { d: 0.6, r: 0.9, uni: [3, 9], vib: [4.5, 0.04, 0.8], ba: 0.6, send: 0.7, gain: 0.8 });
set(88, 88, { ...pad, spec: 'bell', dark: 'bellDark', a: 0.2 });
set(89, 90, pad); set(92, 92, pad); set(94, 94, pad);
set(91, 91, { ...pad, spec: 'choir', dark: 'choirDark' });
set(93, 93, { ...pad, spec: 'metallic', dark: 'metallic' });
set(95, 95, { ...pad, ba: 2.0 });
set(96, 103, { ...pad, spec: 'metallic', dark: 'sine', gain: 0.6 });
set(104, 104, decayer('harpsi', 'harpsiDark', 2.0, 0.9, { send: 0.5 }));
set(105, 105, decayer('harpsi', 'harpsiDark', 0.9, 0.3));
set(106, 106, decayer('steel', 'gtrDark', 1.0, 0.3));
set(107, 107, decayer('nylon', 'gtrDark', 1.8, 0.6));
set(108, 108, decayer('bell', 'bellDark', 1.2, 0.4));
set(109, 109, sustainer('oboe', 'reedDark', 0.05, { r: 0.1 }));
set(110, 110, strings);
set(111, 111, sustainer('oboe', 'reedDark', 0.03, { vib: [6, 0.08, 0.2] }));
set(112, 112, decayer('bell', 'bellDark', 2.0, 0.8, { send: 0.6 }));
set(113, 113, decayer('bell', 'bellDark', 0.4, 0.15));
set(114, 114, decayer('bell', 'bellDark', 1.2, 0.5, { send: 0.5 }));
set(115, 115, decayer('sine', 'sine', 0.08, 0));
set(116, 116, decayer('sine', 'sine', 0.6, 0, { gain: 1.2 }));
set(117, 118, decayer('sine', 'sine', 0.4, 0));
set(119, 119, decayer('metallic', 'sine', 1.0, 0.5, { gain: 0.4 }));
set(120, 127, decayer('metallic', 'sine', 0.5, 0.2, { gain: 0.15 }));

// drums: tone [f0, f1, sweep s, decay s, amp], tone2 [f, decay, amp], noise [decay s, highpass 0..1, amp, lowpass Hz], click amp, bursts
const D = (o) => ({ tone: null, tone2: null, noise: null, click: 0, bursts: 1, send: 0.3, ...o });
const DRUMS = {};
const drum = (notes, p) => { for (const n of notes) DRUMS[n] = D(p); };
drum([35, 36], { tone: [170, 48, 0.045, 0.3, 1.0], click: 0.5, send: 0.1 });
drum([37], { tone: [900, 700, 0.01, 0.025, 0.5], noise: [0.015, 0.5, 0.5, 6000] });
drum([38, 40], { tone: [220, 180, 0.02, 0.09, 0.6], tone2: [330, 0.07, 0.3], noise: [0.14, 0.45, 0.7, 7000], send: 0.5 });
drum([39], { noise: [0.11, 0.6, 0.7, 6000], bursts: 3, send: 0.5 });
drum([41, 43], { tone: [160, 85, 0.06, 0.32, 1.0], noise: [0.03, 0.2, 0.2, 3000], send: 0.45 });
drum([45, 47], { tone: [220, 120, 0.05, 0.28, 0.9], noise: [0.03, 0.2, 0.2, 3000], send: 0.45 });
drum([48, 50], { tone: [300, 170, 0.04, 0.24, 0.9], noise: [0.03, 0.2, 0.2, 3000], send: 0.45 });
drum([42], { noise: [0.04, 0.85, 0.35, 11000], send: 0.15 });
drum([44], { noise: [0.06, 0.85, 0.3, 10000], send: 0.15 });
drum([46], { noise: [0.3, 0.8, 0.35, 10000], send: 0.2 });
drum([49, 57], { noise: [0.9, 0.7, 0.45, 9000], send: 0.3 });
drum([55], { noise: [0.35, 0.75, 0.4, 9000], send: 0.3 });
drum([52], { noise: [0.8, 0.6, 0.45, 7000], send: 0.3 });
drum([51, 59], { noise: [0.5, 0.75, 0.25, 9000], tone: [3000, 3000, 0, 0.4, 0.15], tone2: [4300, 0.3, 0.1], send: 0.3 });
drum([53], { tone: [2800, 2800, 0, 0.5, 0.4], tone2: [4100, 0.4, 0.3], noise: [0.15, 0.8, 0.12, 9000] });
drum([54], { noise: [0.12, 0.8, 0.35, 10000], bursts: 2 });
drum([56], { tone: [560, 560, 0, 0.2, 0.5], tone2: [845, 0.2, 0.4], send: 0.2 });
drum([58], { noise: [0.3, 0.5, 0.3, 5000] });
drum([60], { tone: [400, 360, 0.02, 0.12, 0.8] }); drum([61], { tone: [320, 290, 0.02, 0.14, 0.8] });
drum([62, 63, 64], { tone: [250, 210, 0.03, 0.2, 0.9] });
drum([65, 66], { tone: [350, 300, 0.03, 0.25, 0.8], noise: [0.05, 0.5, 0.3, 5000] });
drum([67], { tone: [1000, 1000, 0, 0.25, 0.5] }); drum([68], { tone: [750, 750, 0, 0.25, 0.5] });
drum([69], { noise: [0.07, 0.8, 0.3, 9000] }); drum([70], { noise: [0.05, 0.85, 0.35, 9000] });
drum([71], { tone: [2300, 2300, 0, 0.3, 0.4] }); drum([72], { tone: [2300, 2300, 0, 0.6, 0.4] });
drum([73, 74], { noise: [0.15, 0.5, 0.25, 5000] });
drum([75], { tone: [2500, 2500, 0, 0.03, 0.6] });
drum([76], { tone: [900, 900, 0, 0.05, 0.6] }); drum([77], { tone: [650, 650, 0, 0.05, 0.6] });
drum([78, 79], { tone: [500, 300, 0.1, 0.3, 0.4] });
drum([80], { tone: [3200, 3200, 0, 0.08, 0.4], tone2: [5100, 0.08, 0.2] }); drum([81], { tone: [3200, 3200, 0, 0.9, 0.4], tone2: [5100, 0.9, 0.2], send: 0.5 });
drum([82], { noise: [0.06, 0.8, 0.3, 9000] });
const DRUM_DEFAULT = D({ noise: [0.08, 0.5, 0.3, 6000] });

const BLOCK = 64;
const noteFreq = (n) => 440 * 2 ** ((n - 69) / 12);
const coef = (seconds) => Math.exp(-1 / (Math.max(0.001, seconds) * SR));

function synthesize(parsed, writeFrames) {
  const chans = [];
  for (let c = 0; c < 16; c++) chans.push({ prog: 0, vol: 100 / 127, expr: 1, pan: 0.5, sustain: false, send: 40 / 127, bend: 0, bendRange: 2, mod: 0, rpn: -1, gain: 100 / 127 });
  let voices = [];
  const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), RV = new Float32Array(BLOCK);
  // reverb: three combs and two allpasses per side on a mono send
  const combL = [1687, 1601, 2053].map((n) => ({ buf: new Float32Array(n), i: 0, lp: 0 })), combR = [1709, 1649, 2111].map((n) => ({ buf: new Float32Array(n), i: 0, lp: 0 }));
  const apL = [556, 441].map((n) => ({ buf: new Float32Array(n), i: 0 })), apR = [563, 433].map((n) => ({ buf: new Float32Array(n), i: 0 }));
  const reverb = (combs, aps, x) => {
    let y = 0;
    for (const c of combs) { const out = c.buf[c.i]; c.lp += 0.35 * (out - c.lp); c.buf[c.i] = x + c.lp * 0.78; c.i = (c.i + 1) % c.buf.length; y += out; }
    y *= 1 / 3;
    for (const a of aps) { const d = a.buf[a.i]; const out = -y + d; a.buf[a.i] = y + d * 0.5; a.i = (a.i + 1) % a.buf.length; y = out; }
    return y;
  };
  const totalFrames = Math.ceil((parsed.duration + 6) * SR);
  const events = parsed.events;
  let ei = 0, frame = 0;
  const chan = (c) => chans[c];
  const updateGain = (c) => { c.gain = c.vol * c.expr; };
  const releaseVoice = (v) => { if (v.stage !== 3) { v.stage = 3; v.rel = coef(v.inst ? v.inst.r : 0.05); } };
  const noteOn = (c, ch, note, vel, t) => {
    if (voices.length >= 72) { // steal the quietest voice that is already fading
      let k = -1, best = Infinity;
      for (let i = 0; i < voices.length; i++) { const v = voices[i], w = (v.stage === 3 ? 0 : 1) + v.env; if (w < best) { best = w; k = i; } }
      if (k >= 0) voices.splice(k, 1);
    }
    const velG = (vel / 127) ** 1.5;
    if (ch === 9) {
      const d = DRUMS[note] || DRUM_DEFAULT;
      voices.push({ drum: d, ch, note, t: 0, env: 1, stage: 1, gain: 0.45 * velG, phase: 0, phase2: 0, nEnv: 1, hp1: 0, hp2: 0, hpX: 0, cEnv: 1 });
      return;
    }
    // a new note on the same key replaces the old one
    for (const v of voices) if (v.ch === ch && v.note === note && v.stage !== 3) releaseVoice(v);
    const inst = PRESETS[c.prog] || PRESETS[0];
    const f = noteFreq(note);
    const allowed = Math.floor(SR / 2 / (f * 1.3));
    const level = LEVELS.find((l) => l <= allowed) || 1;
    const uni = inst.uni ? inst.uni[0] : 1, cents = inst.uni ? inst.uni[1] : 0;
    const det = [], phase = [];
    for (let u = 0; u < uni; u++) { det.push(2 ** ((uni === 1 ? 0 : (u / (uni - 1) - 0.5) * 2 * cents) / 1200)); phase.push(Math.random()); }
    const decay = inst.pd ? Math.min(12, Math.max(0.15, inst.pd * 2 ** ((60 - note) / 18))) : inst.d;
    const b0 = inst.bd ? 0.45 + 0.55 * (vel / 127) : inst.ba ? 0 : 0.4 + 0.6 * (vel / 127);
    voices.push({
      inst, ch, note, t: 0, env: 0, stage: 0, aStep: 1 / (Math.max(0.0005, inst.a) * SR), dCoef: coef(decay), sus: inst.s, rel: 0,
      inc: f / SR, bright: table(inst.spec, level), dark: table(inst.dark, level), b: b0, b0, det, phase, uni,
      gain: inst.gain * velG * (0.5 + 0.5 * (vel / 127)) * 0.3, nEnv: inst.breath ? 1 : 0, held: false,
    });
  };
  const apply = (e) => {
    const c = chan(e.ch);
    switch (e.type) {
      case 'on': noteOn(c, e.ch, e.a, e.b, e.t); break;
      case 'off': for (const v of voices) if (v.ch === e.ch && v.note === e.a && v.stage !== 3 && !v.drum) { if (c.sustain) v.held = true; else releaseVoice(v); } break;
      case 'prog': c.prog = e.a; break;
      case 'bend': c.bend = e.a / 8192; break;
      case 'cc':
        if (e.a === 7) { c.vol = e.b / 127; updateGain(c); }
        else if (e.a === 11) { c.expr = e.b / 127; updateGain(c); }
        else if (e.a === 10) c.pan = e.b / 127;
        else if (e.a === 91) c.send = e.b / 127;
        else if (e.a === 1) c.mod = e.b / 127;
        else if (e.a === 64) { c.sustain = e.b >= 64; if (!c.sustain) for (const v of voices) if (v.ch === e.ch && v.held) { v.held = false; releaseVoice(v); } }
        else if (e.a === 101) c.rpn = e.b === 0 ? 0 : -1; else if (e.a === 100) c.rpn = c.rpn === 0 && e.b === 0 ? 0 : -1;
        else if (e.a === 6 && c.rpn === 0) c.bendRange = e.b;
        else if (e.a === 120 || e.a === 123) { for (const v of voices) if (v.ch === e.ch) releaseVoice(v); }
        else if (e.a === 121) { c.bend = 0; c.mod = 0; c.expr = 1; c.sustain = false; updateGain(c); }
        break;
      default: break;
    }
  };
  while (frame < totalFrames) {
    while (ei < events.length && events[ei].t * SR <= frame) apply(events[ei++]);
    const nextEvent = ei < events.length ? Math.ceil(events[ei].t * SR) : totalFrames;
    const n = Math.max(1, Math.min(BLOCK, nextEvent - frame, totalFrames - frame));
    L.fill(0, 0, n); R.fill(0, 0, n); RV.fill(0, 0, n);
    for (let vi = voices.length - 1; vi >= 0; vi--) {
      const v = voices[vi], c = chans[v.ch];
      const panL = Math.cos(c.pan * Math.PI / 2), panR = Math.sin(c.pan * Math.PI / 2);
      if (v.drum) { renderDrum(v, n, L, R, RV, c.gain * panL, c.gain * panR, c.gain * v.drum.send); }
      else {
        const inst = v.inst;
        const bendF = 2 ** (c.bend * c.bendRange / 12);
        let vibF = 1;
        if (inst.vib || c.mod) {
          const [rate, depth, delay] = inst.vib || [5.5, 0, 0];
          const dep = (depth * Math.min(1, Math.max(0, (v.t - delay) / 0.4)) + c.mod * 0.3);
          if (dep) vibF = 2 ** (dep * Math.sin(2 * Math.PI * rate * v.t) / 12);
        }
        if (inst.bd) v.b = v.b0 * Math.exp(-v.t / inst.bd); else if (inst.ba) v.b = Math.min(1, v.t / inst.ba);
        renderVoice(v, n, v.inc * bendF * vibF * TL, L, R, RV, v.gain * c.gain * panL, v.gain * c.gain * panR, v.gain * c.gain * c.send * inst.send);
      }
      v.t += n / SR;
      if (v.stage === 4) voices.splice(vi, 1);
    }
    for (let i = 0; i < n; i++) {
      const w = RV[i];
      let l = L[i] + 0.9 * reverb(combL, apL, w), r = R[i] + 0.9 * reverb(combR, apR, w);
      if (l > 0.9) l = 0.9 + (l - 0.9) / (1 + (l - 0.9) * 8); else if (l < -0.9) l = -0.9 + (l + 0.9) / (1 - (l + 0.9) * 8);
      if (r > 0.9) r = 0.9 + (r - 0.9) / (1 + (r - 0.9) * 8); else if (r < -0.9) r = -0.9 + (r + 0.9) / (1 - (r + 0.9) * 8);
      L[i] = l; R[i] = r;
    }
    writeFrames(L, R, n);
    frame += n;
    if (ei >= events.length && !voices.length && frame > (parsed.duration + 2.5) * SR) break; // all quiet: the reverb tail is in
  }
}
function renderVoice(v, n, inc, L, R, RV, gL, gR, gS) {
  const bright = v.bright, dark = v.dark, uni = v.uni, det = v.det, phase = v.phase, scale = 1 / uni;
  const breath = v.inst.breath;
  for (let i = 0; i < n; i++) {
    // envelope
    if (v.stage === 0) { v.env += v.aStep; if (v.env >= 1) { v.env = 1; v.stage = 1; } }
    else if (v.stage === 1) { v.env = v.sus + (v.env - v.sus) * v.dCoef; if (v.sus === 0 && v.env < 0.0005) { v.stage = 4; return; } }
    else if (v.stage === 3) { v.env *= v.rel; if (v.env < 0.0005) { v.stage = 4; return; } }
    let s = 0;
    for (let u = 0; u < uni; u++) {
      let ph = phase[u] + inc * det[u]; if (ph >= TL) ph -= TL; phase[u] = ph;
      const i0 = ph | 0, fr = ph - i0;
      const d = dark[i0] + (dark[i0 + 1] - dark[i0]) * fr;
      s += v.b > 0.002 ? d + v.b * ((bright[i0] + (bright[i0 + 1] - bright[i0]) * fr) - d) : d;
    }
    s *= scale * v.env;
    if (breath && v.nEnv > 0.001) { s += (Math.random() * 2 - 1) * breath * v.nEnv * v.env; v.nEnv *= 0.9996; }
    L[i] += s * gL; R[i] += s * gR; RV[i] += s * gS;
  }
}
function renderDrum(v, n, L, R, RV, gL, gR, gS) {
  const d = v.drum; let alive = false;
  for (let i = 0; i < n; i++) {
    let s = 0;
    if (d.tone) {
      const [f0, f1, sweep, tau, amp] = d.tone;
      const f = sweep ? f1 + (f0 - f1) * Math.exp(-v.t / sweep) : f0;
      v.phase += f / SR; if (v.phase >= 1) v.phase -= 1;
      const e = Math.exp(-v.t / tau);
      s += Math.sin(2 * Math.PI * v.phase) * amp * e;
      if (e > 0.001) alive = true;
    }
    if (d.tone2) {
      const [f, tau, amp] = d.tone2;
      v.phase2 += f / SR; if (v.phase2 >= 1) v.phase2 -= 1;
      const e = Math.exp(-v.t / tau);
      s += Math.sin(2 * Math.PI * v.phase2) * amp * e;
      if (e > 0.001) alive = true;
    }
    if (d.noise) {
      const [tau, hp, amp, lpHz] = d.noise;
      let e = 0;
      for (let k = 0; k < d.bursts; k++) { const tt = v.t - k * 0.011; if (tt >= 0) e = Math.max(e, Math.exp(-tt / tau)); }
      const x = Math.random() * 2 - 1;
      // one-pole high-pass, applied twice for a steeper edge, then a one-pole low-pass that takes the hiss off
      const y1 = hp * (v.hp1 + x - v.hpX); v.hpX = x; v.hp1 = y1;
      const y2 = hp * (v.hp2 + y1 - (v.hpPrev || 0)); v.hpPrev = y1; v.hp2 = y2;
      const shaped = hp > 0.3 ? y2 : x * (1 - hp) + y2 * hp;
      if (v.lpK === undefined) v.lpK = 1 - Math.exp(-2 * Math.PI * (lpHz || 8000) / SR);
      v.lp = (v.lp || 0) + v.lpK * (shaped - (v.lp || 0));
      s += v.lp * amp * e;
      if (e > 0.001) alive = true;
    }
    if (d.click && v.cEnv > 0.001) { s += (Math.random() * 2 - 1) * d.click * v.cEnv; v.cEnv *= 0.995; alive = true; }
    s *= v.gain;
    L[i] += s * gL; R[i] += s * gR; RV[i] += s * gS;
    v.t += 1 / SR;
  }
  v.t -= n / SR; // the block loop adds it back
  if (!alive) v.stage = 4;
}

// worker entry: parse, synthesize to a float32 scratch file, then write the normalised 24-bit WAV
async function workerMain({ src, out }) {
  const buf = await fsp.readFile(src);
  if (buf.length > MAX_FILE) throw err('The MIDI file is too large.', 413);
  const parsed = parseMidi(buf);
  if (!parsed.noteCount || parsed.duration <= 0.05) throw err('The MIDI file has no notes.', 415);
  const tmp = out + '.f32';
  const fd = fs.openSync(tmp, 'w');
  const chunk = new Float32Array(SR * 2); let used = 0, peak = 0, frames = 0, lastLoud = 0;
  const flush = () => { if (used) fs.writeSync(fd, Buffer.from(chunk.buffer, 0, used * 4)); used = 0; };
  synthesize(parsed, (L, R, n) => {
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      chunk[used++] = l; chunk[used++] = r;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > peak) peak = a;
      if (a > 0.00025) lastLoud = frames + i;
      if (used === chunk.length) flush();
    }
    frames += n;
  });
  flush(); fs.closeSync(fd);
  if (peak < 1e-6) { await fsp.rm(tmp, { force: true }); throw err('The MIDI file played silence.', 415); }
  const end = Math.min(frames, lastLoud + Math.round(0.25 * SR));
  const gain = 0.891 / peak; // -1 dBFS
  const dataBytes = end * 6;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 6, 28); header.writeUInt16LE(6, 32); header.writeUInt16LE(24, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  const wfd = fs.openSync(out, 'w'); fs.writeSync(wfd, header);
  const rfd = fs.openSync(tmp, 'r');
  const inBuf = Buffer.alloc(SR * 8), outBuf = Buffer.alloc(SR * 6);
  let done = 0;
  while (done < end) {
    const want = Math.min(SR, end - done);
    const got = fs.readSync(rfd, inBuf, 0, want * 8, done * 8) / 8;
    if (!got) break;
    for (let i = 0; i < got * 2; i++) {
      let x = inBuf.readFloatLE(i * 4) * gain;
      if (x > 1) x = 1; else if (x < -1) x = -1;
      const v = Math.round(x * 8388607);
      outBuf[i * 3] = v & 255; outBuf[i * 3 + 1] = (v >> 8) & 255; outBuf[i * 3 + 2] = (v >> 16) & 255;
    }
    fs.writeSync(wfd, outBuf, 0, got * 6);
    done += got;
  }
  fs.closeSync(rfd); fs.closeSync(wfd);
  await fsp.rm(tmp, { force: true });
  return end / SR;
}
if (!isMainThread && workerData && workerData.linerMidiSynth) {
  workerMain(workerData).then((seconds) => parentPort.postMessage({ seconds }), (e) => parentPort.postMessage({ error: e.message, status: e.status }));
}
