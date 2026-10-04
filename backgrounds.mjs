// Background videos: a video file the user drops becomes the background of the mix video, playing on a loop
// behind everything. The upload is transcoded once into a browser-friendly H.264 MP4 (what the preview's <video>
// plays) and the very same frames are written out again as a raw Annex B stream with a keyframe index: the export
// decodes that stream frame by frame with WebCodecs, so the preview and the export show the same pixels. No
// B-frames and a keyframe every second keep every access unit one frame and random access cheap. A poster frame
// serves the editor. Nothing here depends on anything but ffmpeg/ffprobe.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

let cfg = null; // { dir, run, ffmpeg, ffprobe, log, encoder }
const videos = new Map();
export const backgroundJobs = new Map(); // id → the transcode in flight
export const backgroundDir = (id) => path.join(cfg.dir, id);

export async function initBackgrounds(options) {
  cfg = options;
  await fsp.mkdir(cfg.dir, { recursive: true });
  for (const id of await fsp.readdir(cfg.dir).catch(() => [])) {
    const dir = path.join(cfg.dir, id);
    try {
      const m = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (m && m.id === id && m.ready) videos.set(id, m);
      else await fsp.rm(dir, { recursive: true, force: true }); // a transcode that never finished
    } catch { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); }
  }
  cfg.log(`${videos.size} background video(s) in cache`);
}
export const listBackgrounds = () => [...videos.values()].sort((a, b) => b.createdAt - a.createdAt);
export const getBackground = (id) => videos.get(id) || null;
export async function deleteBackground(id) { videos.delete(id); await fsp.rm(backgroundDir(id), { recursive: true, force: true }); }

async function probe(file) {
  const { stdout } = await cfg.run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,duration:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout), s = j.streams && j.streams[0];
  if (!s) throw Object.assign(new Error('There is no picture in that file.'), { status: 415 });
  const rate = (x) => { const [a, b] = String(x || '').split('/').map(Number); return b ? a / b : a || 0; };
  return { w: +s.width || 0, h: +s.height || 0, fps: rate(s.avg_frame_rate) || rate(s.r_frame_rate) || 30, duration: +s.duration || +(j.format && j.format.duration) || 0 };
}
async function codecString(file) { // avc1.PPCCLL from the first SPS of the Annex B stream: profile, constraints, level
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 16);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (let i = 0; i + 6 < bytesRead; i++) if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x1f) === 7) return `avc1.${buf.toString('hex', i + 4, i + 7).toUpperCase()}`;
  } finally { await fh.close(); }
  return 'avc1.64001F';
}

const blankMeta = (id, name) => ({ id, name: String(name).replace(/\.[^.]+$/, '').slice(0, 80) || 'Video', ready: false, error: null, createdAt: Date.now(), version: 1, w: 0, h: 0, fps: 30, frames: 0, duration: 0, key: [], codec: '', bytes: 0 });
function startBuild(meta, src, keepSource) {
  videos.set(meta.id, meta);
  const job = build(meta, src, keepSource)
    .catch((e) => {
      meta.error = e.status ? e.message : 'That video could not be read.';
      cfg.log(`background ${meta.id} failed: ${String(e.stderr ? String(e.stderr).trim().split('\n').pop() : e.message || e).slice(0, 200)}`);
      if (!keepSource) fsp.rm(src, { force: true }).catch(() => {});
    })
    .finally(() => backgroundJobs.delete(meta.id));
  backgroundJobs.set(meta.id, job);
  return meta;
}
// an uploaded video (the request body is the file)
export async function ingestBackground(req, fileName) {
  const id = crypto.randomBytes(6).toString('hex'), dir = backgroundDir(id);
  await fsp.mkdir(dir, { recursive: true });
  const ext = ((String(fileName).match(/\.([a-z0-9]{1,5})$/i) || [])[1] || 'bin').toLowerCase();
  const src = path.join(dir, `source.${ext}`);
  await pipeline(req, fs.createWriteStream(src));
  return startBuild(blankMeta(id, fileName), src, false);
}
// a video already on disk, such as the file a song was imported from (kept in place) or a download (removed after)
export async function ingestBackgroundFromPath(srcPath, name, { keepSource = false } = {}) {
  const id = crypto.randomBytes(6).toString('hex');
  await fsp.mkdir(backgroundDir(id), { recursive: true });
  return startBuild(blankMeta(id, name), srcPath, keepSource);
}

async function build(meta, src, keepSource = false) {
  const dir = backgroundDir(meta.id), t0 = Date.now();
  const info = await probe(src);
  if (!(info.w > 0 && info.h > 0)) throw Object.assign(new Error('There is no picture in that file.'), { status: 415 });
  const fps = Math.min(60, Math.max(12, Math.round(info.fps)));
  const mp4 = path.join(dir, 'video.mp4');
  // at most 1080p, even dimensions, the source's own frame rate (rounded), 4:2:0
  const vf = `scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${fps},format=yuv420p`;
  const enc = cfg.encoder === 'libx264'
    ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '17', '-profile:v', 'high', '-bf', '0', '-g', String(fps), '-keyint_min', String(fps), '-sc_threshold', '0', '-x264-params', 'aud=1']
    : ['-c:v', cfg.encoder, '-b:v', '14M', '-profile:v', 'high', '-bf', '0', '-g', String(fps)];
  const colour = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
  await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', vf, ...enc, ...colour, '-movflags', '+faststart', mp4]);
  if (!keepSource) await fsp.rm(src, { force: true });
  await indexMp4(meta, dir, fps);
  cfg.log(`background ${meta.id}: ${meta.w}×${meta.h}, ${meta.fps} fps, ${meta.frames} frames, ${meta.key.length} keyframes, ${(meta.bytes / 1e6).toFixed(1)} MB (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
// From the transcoded video.mp4 in `dir`: the same frames as a raw Annex B stream, where every keyframe starts in it,
// the codec string, a poster, and the finished meta.json. Also what a restored (saved) video needs.
async function indexMp4(meta, dir, fps = null) {
  const mp4 = path.join(dir, 'video.mp4'), h264 = path.join(dir, 'stream.h264'), poster = path.join(dir, 'poster.jpg');
  await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', mp4, '-c:v', 'copy', '-bsf:v', 'h264_mp4toannexb', '-f', 'h264', h264]);
  const { stdout } = await cfg.run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pos,flags', '-of', 'csv=p=0', h264]);
  const key = []; let frames = 0;
  for (const line of stdout.split('\n')) {
    const [pos, flags] = line.trim().split(',');
    if (pos === undefined || pos === '') continue;
    if (/K/.test(flags || '')) key.push([frames, +pos]);
    frames++;
  }
  if (!frames || !key.length || key[0][0] !== 0) throw new Error('The transcode produced no usable frames.');
  const out = await probe(mp4);
  const rate = fps || Math.min(60, Math.max(12, Math.round(out.fps)));
  const codec = await codecString(h264);
  await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-ss', Math.min(1, frames / rate / 4).toFixed(3), '-i', mp4, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', poster]).catch(() => {});
  const st = await fsp.stat(h264);
  Object.assign(meta, { w: out.w, h: out.h, fps: rate, frames, duration: frames / rate, key, codec, bytes: st.size, ready: true, error: null });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta));
}
// A video saved with a mix comes back: its video.mp4 is copied into the store under the same id and indexed again.
export async function restoreBackground(id, fromDir) {
  const existing = videos.get(id);
  if (existing && existing.ready) return existing;
  const dir = backgroundDir(id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(path.join(fromDir, 'video.mp4'), path.join(dir, 'video.mp4'));
  let saved = {}; try { saved = JSON.parse(await fsp.readFile(path.join(fromDir, 'meta.json'), 'utf8')); } catch { /* the video alone will do */ }
  const meta = { ...blankMeta(id, saved.name || 'Video'), createdAt: saved.createdAt || Date.now(), version: saved.version || 1 };
  await indexMp4(meta, dir, saved.fps || null);
  videos.set(id, meta);
  cfg.log(`background ${id}: restored from a saved mix (${meta.frames} frames)`);
  return meta;
}
