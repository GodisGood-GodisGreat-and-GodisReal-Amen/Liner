// Liner — dancer sprites. A GIF, an animated PNG or WebP, a short video, or a set of still images becomes one
// PNG atlas (frames on a grid) plus per-frame timings, so the browser can draw any frame of the dance for any time t
// with a single drawImage — in the live preview and in the export alike. ffmpeg does the decoding and keying.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SPRITE_VERSION = 1;
const MAX_FRAMES = 240;        // longer loops are thinned evenly (their timing is kept)
const MAX_CELL = 640;          // px, longest side of one frame in the atlas
const MAX_ATLAS = 4096;        // px, atlas side
const MAX_CLIP_SECONDS = 12;   // of a video or a very long GIF
const CRISP_MAX = 200;         // px: sources this small are pixel art and are drawn without smoothing

let cfg = null;                // { dir, run, ffmpeg, ffprobe, log }
const sprites = new Map();     // id -> meta
const err = (message, status = 400) => Object.assign(new Error(message), { status });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const spriteDir = (id) => path.join(cfg.dir, id);
export async function initSprites(options) {
  cfg = options;
  await fsp.mkdir(cfg.dir, { recursive: true });
  for (const id of await fsp.readdir(cfg.dir).catch(() => [])) {
    try { const m = JSON.parse(await fsp.readFile(path.join(cfg.dir, id, 'sprite.json'), 'utf8')); if (m && m.id === id) sprites.set(id, m); }
    catch { /* skip broken entries */ }
  }
  cfg.log(`${sprites.size} sprite(s) in cache`);
}
export const listSprites = () => [...sprites.values()].map(publicSprite).sort((a, b) => b.createdAt - a.createdAt);
export const getSprite = (id) => sprites.get(id);
export async function registerSprite(id) { // a sprite folder copied into the store (from a saved mix): read it in
  if (sprites.has(id)) return sprites.get(id);
  const m = JSON.parse(await fsp.readFile(path.join(cfg.dir, id, 'sprite.json'), 'utf8'));
  if (!m || m.id !== id) throw new Error('Not a sprite folder.');
  sprites.set(id, m);
  return m;
}
export function publicSprite(m) {
  const { id, name, frames, cols, rows, cell, native, durations, loop, kinds, keyable, keyColor, key, fps, crisp, createdAt, ready, error, version, atlasBytes } = m;
  return { id, name, frames, cols, rows, cell, native, durations, loop, kinds, keyable, keyColor, key, fps, crisp, createdAt, ready, error, version, atlasBytes, sources: (m.sources || []).map((s) => s.name) };
}
async function save(m) { await fsp.writeFile(path.join(spriteDir(m.id), 'sprite.json'), JSON.stringify(m)); }

export async function createSprite(name) {
  const id = crypto.randomBytes(6).toString('hex');
  const m = { id, name: String(name || 'Dancer').trim().slice(0, 80) || 'Dancer', sources: [], frames: 0, ready: false, error: null, createdAt: Date.now(), version: 0, fps: 8, key: null, crisp: null };
  await fsp.mkdir(path.join(spriteDir(id), 'src'), { recursive: true });
  sprites.set(id, m);
  await save(m);
  return m;
}
export async function renameSprite(m, name) { m.name = String(name || '').trim().slice(0, 80) || m.name; await save(m); return m; }
export async function deleteSprite(id) {
  sprites.delete(id);
  await fsp.rm(spriteDir(id), { recursive: true, force: true }).catch(() => {});
}

// Stores one uploaded file and works out what it is: a still image, an animation (GIF/APNG/WebP) or a video.
export async function addSource(m, stream, fileName) {
  const ext = (path.extname(fileName) || '.bin').toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin';
  const k = m.sources.length;
  if (k >= 400) throw err('That is plenty of frames already (400 files).');
  const rel = path.join('src', `${String(k).padStart(3, '0')}${ext}`);
  const abs = path.join(spriteDir(m.id), rel);
  await new Promise((resolve, reject) => { const w = fs.createWriteStream(abs); stream.pipe(w); w.on('finish', resolve); w.on('error', reject); stream.on('error', reject); })
    .catch(async (e) => { await fsp.rm(abs, { force: true }).catch(() => {}); throw e; });
  let info;
  try {
    const { stdout } = await cfg.run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs]);
    info = JSON.parse(stdout);
  } catch { await fsp.rm(abs, { force: true }); throw err(`“${fileName}” could not be read as an image, GIF or video.`, 415); }
  const v = (info.streams || []).find((s) => s.codec_type === 'video');
  if (!v) { await fsp.rm(abs, { force: true }); throw err(`“${fileName}” has no picture in it.`, 415); }
  const fmt = String(info.format && info.format.format_name || '');
  const stills = /^(image2|png_pipe|jpeg_pipe|webp_pipe|bmp_pipe|tiff_pipe|heif|avif)/;
  let kind = 'image';
  if (/gif|apng/.test(fmt)) kind = 'animation';
  else if (/webp/.test(fmt)) kind = 'animation'; // a still WebP simply yields one frame
  else if (!stills.test(fmt) && !['png', 'mjpeg', 'bmp', 'tiff', 'webp'].includes(v.codec_name)) kind = 'video';
  const rate = String(v.r_frame_rate || '0/1').split('/');
  const fps = +rate[0] && +rate[1] ? +rate[0] / +rate[1] : 0;
  m.sources.push({ file: rel, name: String(fileName).slice(0, 120), kind, w: +v.width || 0, h: +v.height || 0, fps, duration: parseFloat(info.format && info.format.duration) || 0 });
  m.ready = false;
  await save(m);
  return m;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 100; };
async function pngSize(file) { // IHDR: width and height right after the signature
  const fd = await fsp.open(file, 'r');
  try { const b = Buffer.alloc(24); await fd.read(b, 0, 24, 0); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; }
  finally { await fd.close(); }
}
// the four corner pixels of a frame, as [r, g, b, a]
async function corners(file) {
  const { stdout } = await cfg.run(cfg.ffmpeg, ['-v', 'error', '-i', file,
    '-filter_complex', '[0:v]format=rgba,split=4[a][b][c][d];[a]crop=1:1:0:0[a1];[b]crop=1:1:iw-1:0[b1];[c]crop=1:1:0:ih-1[c1];[d]crop=1:1:iw-1:ih-1[d1];[a1][b1][c1][d1]hstack=4',
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { encoding: 'buffer' });
  const out = [];
  for (let i = 0; i + 4 <= stdout.length && out.length < 4; i += 4) out.push([stdout[i], stdout[i + 1], stdout[i + 2], stdout[i + 3]]);
  return out;
}
const hex2 = (n) => n.toString(16).padStart(2, '0');

// Turns the sources into the atlas. Options: fps for still-image sets, key (knock out a solid background),
// crisp (nearest-neighbour pixel art). Options left null keep the previous or automatic choice.
export async function buildSprite(m, { fps, key, crisp } = {}) {
  if (!m.sources.length) throw err('Add a GIF, an animated PNG, a short video or some images first.');
  if (fps != null && Number.isFinite(+fps)) m.fps = clamp(Math.round(+fps), 1, 60);
  if (key != null) m.key = !!key;
  if (crisp != null) m.crisp = !!crisp;
  const dir = spriteDir(m.id), work = path.join(dir, 'work'), seq = path.join(dir, 'seq');
  await fsp.rm(work, { recursive: true, force: true }); await fsp.mkdir(work, { recursive: true });
  await fsp.rm(seq, { recursive: true, force: true }); await fsp.mkdir(seq, { recursive: true });
  try {
    // 1. frames out of every source, in upload order
    let frames = [];
    const order = m.sources.map((s, i) => ({ s, i })).sort((a, b) => a.s.name.localeCompare(b.s.name, undefined, { numeric: true, sensitivity: 'base' }) || a.i - b.i);
    for (const { s: src, i: k } of order) {
      const srcPath = path.join(dir, src.file), prefix = `s${String(k).padStart(3, '0')}-`;
      if (src.kind === 'image') {
        await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', srcPath, '-frames:v', '1', '-pix_fmt', 'rgba', path.join(work, `${prefix}0001.png`)]);
        frames.push({ file: path.join(work, `${prefix}0001.png`), ms: 1000 / m.fps });
        continue;
      }
      const limit = ['-t', String(MAX_CLIP_SECONDS)];
      const vf = src.kind === 'video' && src.fps > 30 ? ['-vf', 'fps=30'] : [];
      await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', srcPath, ...limit, '-fps_mode', 'passthrough', ...vf, '-pix_fmt', 'rgba', path.join(work, `${prefix}%04d.png`)]);
      const produced = (await fsp.readdir(work)).filter((n) => n.startsWith(prefix)).sort();
      let ms = [];
      if (src.kind === 'animation') {
        try {
          const { stdout } = await cfg.run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time,duration_time', '-of', 'json', '-read_intervals', `%+${MAX_CLIP_SECONDS}`, srcPath]);
          const fr = JSON.parse(stdout).frames || [];
          const pts = fr.map((f) => parseFloat(f.pts_time));
          for (let i = 0; i < fr.length; i++) {
            let d = i + 1 < fr.length ? pts[i + 1] - pts[i] : parseFloat(fr[i].duration_time);
            if (!(d > 0)) d = i > 0 ? ms[i - 1] / 1000 : 0.1;
            ms.push(d * 1000);
          }
        } catch { /* uniform timing below */ }
      }
      if (ms.length !== produced.length) { const d = src.kind === 'video' ? 1000 / Math.min(30, src.fps || 30) : (ms.length ? median(ms) : 100); ms = produced.map(() => d); }
      produced.forEach((n, i) => frames.push({ file: path.join(work, n), ms: ms[i] }));
    }
    if (!frames.length) throw err('No frames could be read from the files.', 415);
    // browsers play GIF delays of 10 ms and under as 100 ms; do the same so the dance runs at the speed people know
    for (const f of frames) { if (f.ms <= 10.5) f.ms = 100; f.ms = clamp(f.ms, 20, 4000); }
    // 2. keep the loop to a sane number of frames, keeping its total length
    if (frames.length > MAX_FRAMES) {
      const keep = [];
      for (let i = 0; i < MAX_FRAMES; i++) {
        const a = Math.floor(i * frames.length / MAX_FRAMES), b = Math.max(a + 1, Math.floor((i + 1) * frames.length / MAX_FRAMES));
        const f = frames[a]; f.ms = frames.slice(a, b).reduce((s, x) => s + x.ms, 0); keep.push(f);
      }
      frames = keep;
    }
    // 3. native size: the largest frame
    let nw = 1, nh = 1, uniform = true, first = null;
    for (const f of frames) { const s = await pngSize(f.file); if (!first) first = s; else if (s.w !== first.w || s.h !== first.h) uniform = false; nw = Math.max(nw, s.w); nh = Math.max(nh, s.h); }
    // 4. a solid background colour, if the corners agree and are opaque (a cut-out would have transparent corners)
    let keyable = false, keyColor = null;
    try {
      const c = await corners(frames[0].file);
      if (c.length === 4 && c.every((p) => p[3] >= 250)) {
        const agree = (p, q) => Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) <= 48;
        const best = c.map((p) => c.filter((q) => agree(p, q)).length);
        const i = best.indexOf(Math.max(...best));
        if (best[i] >= 3) { keyable = true; keyColor = `#${hex2(c[i][0])}${hex2(c[i][1])}${hex2(c[i][2])}`; }
      }
    } catch { /* keep keyable = false */ }
    m.keyable = keyable; m.keyColor = keyColor;
    if (m.key == null) m.key = keyable;
    if (m.crisp == null) m.crisp = Math.max(nw, nh) <= CRISP_MAX;
    // 5. atlas geometry
    const n = frames.length, cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);
    const s = Math.min(1, MAX_CELL / Math.max(nw, nh), MAX_ATLAS / (cols * nw), MAX_ATLAS / (rows * nh));
    const cw = Math.max(1, Math.round(nw * s)), ch = Math.max(1, Math.round(nh * s));
    // 6. one ffmpeg pass: key, scale, pad to the cell, tile
    for (let i = 0; i < n; i++) await fsp.rename(frames[i].file, path.join(seq, `${String(i + 1).padStart(4, '0')}.png`));
    const keyChain = m.key && keyable ? `colorkey=${keyColor.replace('#', '0x')}:0.16:0.1,` : '';
    let fit = '';
    if (s < 1 || !uniform) fit = m.crisp ? `scale=${cw}:${ch}:force_original_aspect_ratio=decrease:flags=neighbor,` : `premultiply=inplace=1,scale=${cw}:${ch}:force_original_aspect_ratio=decrease:flags=lanczos,unpremultiply=inplace=1,`;
    const chain = `format=rgba,${keyChain}${fit}pad=${cw}:${ch}:-1:-1:color=0x00000000,tile=${cols}x${rows}:color=0x00000000`;
    const atlas = path.join(dir, 'atlas.png');
    await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-reinit_filter', '0', '-framerate', '1', '-i', path.join(seq, '%04d.png'), '-vf', chain, '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', atlas]);
    // 7. a small thumbnail of the first frame for the lists
    const thumbFit = `scale=${Math.min(160, cw)}:${Math.min(160, ch)}:force_original_aspect_ratio=decrease:flags=${m.crisp ? 'neighbor' : 'lanczos'}`;
    await cfg.run(cfg.ffmpeg, ['-y', '-v', 'error', '-i', path.join(seq, '0001.png'), '-vf', `format=rgba,${keyChain}${thumbFit}`, '-frames:v', '1', '-c:v', 'png', '-pix_fmt', 'rgba', path.join(dir, 'thumb.png')]);
    const st = await fsp.stat(atlas);
    Object.assign(m, {
      frames: n, cols, rows, cell: { w: cw, h: ch }, native: { w: nw, h: nh }, durations: frames.map((f) => Math.round(f.ms)), loop: Math.round(frames.reduce((a, f) => a + f.ms, 0)),
      kinds: [...new Set(m.sources.map((x) => x.kind))], ready: true, error: null, version: (m.version || 0) + 1, atlasBytes: st.size, spriteVersion: SPRITE_VERSION,
    });
    await save(m);
    cfg.log(`sprite ${m.id}: ${n} frames, ${cols}×${rows} cells of ${cw}×${ch} (${(st.size / 1e6).toFixed(1)} MB)${m.key && keyable ? `, keyed ${keyColor}` : ''}${m.crisp ? ', crisp' : ''}`);
    return m;
  } catch (e) {
    m.ready = false; m.error = e.status ? e.message : 'The frames could not be prepared: ' + (e.stderr ? String(e.stderr).trim().split('\n').pop().slice(0, 160) : e.message);
    await save(m);
    throw e.status ? e : err(m.error, 500);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(seq, { recursive: true, force: true }).catch(() => {});
  }
}
