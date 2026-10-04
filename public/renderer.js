// Liner renderer — draws one frame of the video for any time t, at any resolution.
// Everything is a pure function of (t, project) so the live preview and the export match frame-for-frame.

export const FONTS = {
  sans: 'system-ui, -apple-system, "SF Pro Display", "Helvetica Neue", "Segoe UI", Arial, sans-serif',
  serif: 'ui-serif, "New York", "Iowan Old Style", Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};

export const STYLES = ['aurora', 'cover', 'ink'];

// ---------------------------------------------------------------- math
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const clamp01 = (x) => Math.min(1, Math.max(0, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const easeOutQuint = (x) => 1 - Math.pow(1 - x, 5);
export const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
export const easeInCubic = (x) => x * x * x;
export const easeInOutCubic = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
export const easeInOutSine = (x) => -(Math.cos(Math.PI * x) - 1) / 2;
export const easeOutBack = (x) => { const c1 = 1.4, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };

// ---------------------------------------------------------------- dancers
// where a dancing sprite stands; the layout makes room for it (see computeLayout)
export const DANCE_PLACES = [
  { id: 'under-art', label: 'Under the artwork' },
  { id: 'beside-art', label: 'Beside the artwork' },
  { id: 'beside-list', label: 'Beside the list' },
  { id: 'corner', label: 'Bottom corner' },
  { id: 'on-art', label: 'On the artwork' },
  { id: 'by-title', label: 'By the title' },
  { id: 'custom', label: 'Anywhere: drag it in the preview' },
];
export const DANCE_SIZE = { min: 0.06, max: 0.6, def: 0.24 }; // of the frame height

// ---------------------------------------------------------------- frequency visualizer
export const VIZ_PLACES = [
  { id: 'under-art', label: 'Under the artwork' },
  { id: 'on-art', label: 'On the artwork' },
  { id: 'bottom', label: 'Along the bottom' },
  { id: 'top', label: 'Along the top' },
  { id: 'behind', label: 'Behind everything' },
  { id: 'custom', label: 'Anywhere: drag it in the preview' },
];
export const VIZ_SIZE = { min: 0.05, max: 0.4, def: 0.12 };
export const vizLabelH = (size) => (size === 'small' ? 26 : 34); // the row of Low · Mid · High captions under the bars or wave
// the server's spectrum file: "LSPC", version, bands, rate (u16), frames (u32), then one byte per band per frame
export function parseSpectrum(buf) {
  const d = new DataView(buf);
  if (buf.byteLength < 16 || d.getUint8(0) !== 0x4c || d.getUint8(1) !== 0x53 || d.getUint8(2) !== 0x50 || d.getUint8(3) !== 0x43) throw new Error('Not a spectrum file');
  const version = d.getUint8(4), bands = d.getUint8(5), rate = d.getUint16(6, true), frames = d.getUint32(8, true);
  return { version, bands, rate, frames, data: new Uint8Array(buf, 16, Math.min(buf.byteLength - 16, frames * bands)) };
}
// which bands are low (under 250 Hz), mid (to 4 kHz) and high, for the labels and the three-band style
const regionCache = new Map();
export function spectrumRegions(bands) {
  let r = regionCache.get(bands);
  if (r) return r;
  const edge = (k) => 40 * Math.pow(300, k / bands);
  const upTo = (hz) => { let k = 0; while (k < bands && edge(k + 1) <= hz * 1.001) k++; return k; };
  const a = upTo(250), b = upTo(4000);
  r = [{ name: 'LOW', from: 0, to: Math.max(1, a) }, { name: 'MID', from: Math.max(1, a), to: Math.max(a + 1, b) }, { name: 'HIGH', from: Math.max(a + 1, b), to: bands }];
  regionCache.set(bands, r);
  return r;
}
const spectrumColor = (f) => hslToRgb(0.02 + 0.6 * f, 0.82, 0.62).map((v) => Math.round(v * 255)); // warm lows to cool highs
// auto mode: tracks whose liveliness score reaches the threshold get the dancers (sensitivity 0 = only the liveliest, 1 = nearly all)
export const danceThreshold = (sensitivity) => 0.78 - 0.56 * clamp01(sensitivity == null ? 0.5 : +sensitivity);
// true / false, or null while a track has not been analysed yet
export function dancerActive(song, dance) {
  if (song.dancer === 'on') return true;
  if (song.dancer === 'off') return false;
  if (!dance || dance.mode === 'always') return true;
  const a = song.analysis;
  if (!a || typeof a.score !== 'number') return null;
  return a.score >= danceThreshold(dance.sensitivity);
}
// Beats elapsed at song-file time `ft` on a tracked beat grid: whole beats plus the fraction of the current
// interval, extrapolated with the neighbouring interval before the first beat and after the last.
export function beatProgress(beats, ft) {
  const n = beats.length;
  if (n < 2) return 0;
  if (ft < beats[0]) return (ft - beats[0]) / (beats[1] - beats[0]);
  if (ft >= beats[n - 1]) return n - 1 + (ft - beats[n - 1]) / (beats[n - 1] - beats[n - 2]);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid] <= ft) lo = mid; else hi = mid; }
  return lo + (ft - beats[lo]) / (beats[hi] - beats[lo]);
}
// The loop phase (0..1) at which a sprite's accent frame starts: with `B` beats per loop the beats should land on
// the frames where the motion settles into a pose (the editor scores those in `sprite.accents`), one every 1/B of
// the loop, so the start of the frame that gathers the most accent across those slots is where beat one goes.
export function accentPhase(sprite, B) {
  const m = sprite.meta, acc = sprite.accents;
  if (!acc || !m || !(m.frames > 1) || !(m.loop > 0)) return 0;
  const cache = sprite._accent || (sprite._accent = {});
  if (cache[B] != null) return cache[B];
  if (!m.cum) frameAtPhase(m, 0);
  const slots = Math.max(1, Math.round(B)), startOf = (i) => (i ? m.cum[i - 1] : 0) / m.loop;
  let best = -1, phase = 0;
  for (let i = 0; i < m.frames; i++) {
    let sum = 0;
    for (let j = 0; j < slots; j++) sum += acc[frameAtPhase(m, (startOf(i) + j / slots) % 1)] || 0;
    if (sum > best + 1e-9) { best = sum; phase = startOf(i); }
  }
  cache[B] = phase;
  return phase;
}
const lerpPhase = (a, b, u) => { let d = b - a; d -= Math.round(d); return (((a + d * u) % 1) + 1) % 1; }; // shortest way round the loop
const STEP_XF = 0.5; // seconds after a song change over which in-step dancers finish easing onto the new beat grid (the ease starts up to a second earlier when there is a gap to use)
const beatsPerLoop = (nativeLoop, beatLen) => { let best = Infinity, B = 1; for (const c of [0.5, 1, 2, 4, 8]) { const e = Math.abs(Math.log((c * beatLen) / nativeLoop)); if (e < best) { best = e; B = c; } } return B; };
// Background video timing. The video plays on a loop at the Motion setting's rate (Normal 1×, Slow ½×); Still
// holds one frame a little way in (the first frame of a clip is often a fade from black).
export function videoTimeAt(look, meta, t) {
  const rate = look.motion == null ? 1 : +look.motion, dur = meta.frames / meta.fps;
  if (!(dur > 0)) return 0;
  if (!(rate > 0)) return Math.min(1, dur * 0.1);
  return (((t * rate) % dur) + dur) % dur;
}
export const videoFrameIndex = (meta, vt) => Math.min(meta.frames - 1, Math.max(0, Math.floor(vt * meta.fps + 1e-6)));
const BG_STYLES = ['aurora', 'cover', 'ink'];
// the video a song shows (its own, once prepared, or another one it was given), or null
export function songVideoId(song) {
  if (!song || !song.videoUse || song.videoUse === 'off') return null;
  if (song.videoPick === 'other') return song.videoId || null;
  return song.ownVideoStatus === 'ready' && song.ownVideo ? song.ownVideo : null;
}
// a tile of film grain, the same for every renderer (so the preview and the export agree), blended over video backgrounds
function makeGrainTile(n) {
  const c = document.createElement('canvas'); c.width = c.height = n;
  const x = c.getContext('2d'), img = x.createImageData(n, n), d = img.data;
  let seed = 0x9e3779b9;
  for (let i = 0; i < d.length; i += 4) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const v = 128 + ((seed >>> 8) / 16777216 - 0.5) * 120; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  return c;
}
// index of the sprite frame showing at `phase` (0..1 of the loop)
export function frameAtPhase(meta, phase) {
  if (!meta.cum) { let acc = 0; meta.cum = meta.durations.map((d) => (acc += d)); }
  const target = phase * meta.loop, cum = meta.cum;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > target) hi = mid; else lo = mid + 1; }
  return lo;
}

const TRANS = 0.75;       // art / text crossfade (ease-out: things leaving and arriving)
const SCROLL_TRANS = 0.8; // list scroll, marker glide and row highlight share one ease-in-out curve so they settle together
const PAL_TRANS = 1.8;    // background palette blend

export function formatTime(sec, { forceHours = false } = {}) {
  sec = Math.max(0, Math.floor(sec + 1e-6));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0 || forceHours) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}
export function formatDurationLong(sec) {
  const m = Math.round(sec / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ---------------------------------------------------------------- timeline
// the part of a song that plays: its trim, or the whole file
export function songLength(s) {
  const full = Math.max(0, +s.duration || 0);
  const t = s.trim;
  if (!t) return full;
  const start = clamp(+t.start || 0, 0, full);
  const end = t.end == null ? full : clamp(+t.end, start, full);
  return Math.max(0, end - start);
}
export const trimStart = (s) => (s.trim ? clamp(+s.trim.start || 0, 0, Math.max(0, +s.duration || 0)) : 0);
// With a crossfade, each song starts before the previous one ends (by the crossfade, or half the shorter song if
// that is less) and the gap is skipped; the picture changes halfway through the overlap, where the sound has
// crossed over. Without one, songs follow each other with the gap between them.
export function buildTimeline(songs, timing) {
  const lead = Math.max(0, +timing.lead || 0), gap = Math.max(0, +timing.gap || 0), tail = Math.max(0, +timing.tail || 0), xf = Math.max(0, +timing.crossfade || 0);
  const segs = [];
  let t = lead;
  songs.forEach((s, i) => {
    const d = songLength(s);
    const overlap = xf > 0 && i > 0 ? Math.min(xf, segs[i - 1].dur / 2, d / 2) : 0;
    const start = t - overlap;
    segs.push({ start, end: start + d, dur: d, overlap });
    t = start + d;
    if (i < songs.length - 1 && !(xf > 0)) t += gap;
  });
  const musicEnd = t;
  const total = songs.length ? t + tail : 0;
  const changeAt = segs.map((s, i) => (i === 0 ? 0 : s.overlap > 0 ? s.start + s.overlap / 2 : Math.max(0, s.start - Math.min(gap, 0.5))));
  const fadeIn = lead > 0 ? clamp(lead, 0.6, 1.2) : 0.6;
  const fadeOut = tail > 0 ? Math.min(1.6, tail) : 0;
  return {
    segs, total, musicEnd, changeAt, lead, gap, tail, fadeIn, fadeOut, crossfade: xf,
    indexAt(time) {
      let i = 0;
      for (let k = 1; k < changeAt.length; k++) { if (changeAt[k] <= time) i = k; else break; }
      return i;
    },
    songAtAudioTime(time) { // song whose audio is playing at time (the newer one inside a crossfade), or -1 in gaps/lead/tail
      for (let i = segs.length - 1; i >= 0; i--) if (time >= segs[i].start && time < segs[i].end) return i;
      return -1;
    },
  };
}

// ---------------------------------------------------------------- colours
export function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}
export function hslToRgb(h, s, l) {
  h = ((h % 1) + 1) % 1;
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = ((t % 1) + 1) % 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
export const rgbHex = (c) => '#' + c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('');

export const DEFAULT_PALETTE = {
  colors: [[0.24, 0.30, 0.52], [0.46, 0.24, 0.38], [0.17, 0.42, 0.42], [0.42, 0.36, 0.20]],
  base: [0.05, 0.055, 0.075],
  accent: [0.66, 0.72, 0.96],
};

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export function paletteFromHue(hue) {
  const mk = (h, s, l) => hslToRgb(h, s, l);
  return {
    colors: [mk(hue, 0.5, 0.38), mk(hue + 0.09, 0.45, 0.36), mk(hue - 0.11, 0.42, 0.34), mk(hue + 0.5, 0.3, 0.3)],
    base: mk(hue, 0.35, 0.07),
    accent: mk(hue, 0.55, 0.68),
  };
}

// k-means over a small thumbnail; returns 4 blob colours, a dark base and a UI accent.
export function extractPalette(source) {
  const n = 40;
  const c = document.createElement('canvas'); c.width = c.height = n;
  const x = c.getContext('2d', { willReadFrequently: true });
  drawCover(x, source, 0, 0, n, n);
  const d = x.getImageData(0, 0, n, n).data;
  const px = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
  const k = 6;
  let centers = [px[0]];
  while (centers.length < k) { // farthest-point seeding (deterministic)
    let best = null, bestD = -1;
    for (const p of px) { let dm = Infinity; for (const cc of centers) { const dd = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 + (p[2] - cc[2]) ** 2; if (dd < dm) dm = dd; } if (dm > bestD) { bestD = dm; best = p; } }
    centers.push(best);
  }
  let assign = new Array(px.length).fill(0);
  for (let it = 0; it < 10; it++) {
    for (let i = 0; i < px.length; i++) {
      let bi = 0, bd = Infinity; const p = px[i];
      for (let j = 0; j < k; j++) { const cc = centers[j]; const dd = (p[0] - cc[0]) ** 2 + (p[1] - cc[1]) ** 2 + (p[2] - cc[2]) ** 2; if (dd < bd) { bd = dd; bi = j; } }
      assign[i] = bi;
    }
    const sums = Array.from({ length: k }, () => [0, 0, 0, 0]);
    for (let i = 0; i < px.length; i++) { const s = sums[assign[i]], p = px[i]; s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++; }
    centers = sums.map((s, j) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : centers[j]));
  }
  const counts = new Array(k).fill(0); for (const a of assign) counts[a]++;
  const clusters = centers.map((col, j) => { const [h, s, l] = rgbToHsl(...col); return { col, h, s, l, w: counts[j] / px.length }; }).filter((c) => c.w > 0);
  const score = (c) => c.w * (0.2 + c.s * 1.2) * (c.l > 0.08 && c.l < 0.92 ? 1 : 0.3);
  const ranked = [...clusters].sort((a, b) => score(b) - score(a));
  const picks = [];
  for (const c of ranked) { if (picks.length >= 4) break; picks.push(c); }
  while (picks.length < 4) picks.push(picks[picks.length - 1] || { h: 0.6, s: 0.2, l: 0.4, w: 1 });
  const colors = picks.map((c) => hslToRgb(c.h, c.s < 0.08 ? c.s : clamp(c.s * 1.15, 0.3, 0.82), clamp(c.l, 0.26, 0.5)));
  const dominant = [...clusters].sort((a, b) => b.w - a.w)[0];
  const base = hslToRgb(dominant.h, clamp(dominant.s * 0.7, 0.05, 0.5), 0.065);
  const vivid = [...clusters].sort((a, b) => b.s * (0.5 + b.w) - a.s * (0.5 + a.w))[0];
  const accent = hslToRgb(vivid.h, vivid.s < 0.08 ? 0.05 : clamp(vivid.s, 0.45, 0.85), 0.68);
  return { colors, base, accent };
}

export function blendPalette(a, b, t) {
  if (t <= 0) return a; if (t >= 1) return b;
  const mix = (p, q) => p.map((v, i) => lerp(v, q[i], t));
  return { colors: a.colors.map((c, i) => mix(c, b.colors[i])), base: mix(a.base, b.base), accent: mix(a.accent, b.accent) };
}

// ---------------------------------------------------------------- 2D helpers
export function drawCover(ctx, img, x, y, w, h) { // object-fit: cover
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const sw = w / s, sh = h / s;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const measureCache = new Map();
function measure(ctx, text) {
  const key = ctx.font + '\u0001' + text;
  let w = measureCache.get(key);
  if (w == null) { w = ctx.measureText(text).width; if (measureCache.size > 4000) measureCache.clear(); measureCache.set(key, w); }
  return w;
}
// Draws digits on a fixed advance so times don't jitter as they count (tabular numerals for canvas).
function fillTabular(ctx, text, x, y, align = 'left') {
  const digitW = Math.max(...'0123456789'.split('').map((d) => measure(ctx, d)));
  const widths = [...text].map((ch) => (/\d/.test(ch) ? digitW : measure(ctx, ch)));
  const total = widths.reduce((a, b) => a + b, 0);
  let cx = align === 'right' ? x - total : align === 'center' ? x - total / 2 : x;
  const prevAlign = ctx.textAlign; ctx.textAlign = 'center';
  [...text].forEach((ch, i) => { ctx.fillText(ch, cx + widths[i] / 2, y); cx += widths[i]; });
  ctx.textAlign = prevAlign;
  return total;
}
// Text that is wider than its box glides right-to-left in a slow loop with soft edges, but only while `phase` is
// positive (the song is playing and its start delay has passed). Otherwise the text sits at its start, softly cut.
const FLOW_SPEED = 28;   // units per second once under way
const FLOW_PAUSE = 2.2;  // seconds resting at the start of each loop
const FLOW_EASE = 0.9;   // seconds spent getting going, and again settling, at each end of the glide
// How far the text has glided at `phase` seconds into its loop: rest, an eased start, a steady glide, an eased stop
// when the following copy has arrived at the start, rest again. `D` is the distance one loop covers.
function flowOffset(phase, D) {
  const v = FLOW_SPEED, ta = Math.min(FLOW_EASE, D / v / 2), T = D / v + ta; // the eased ends each cover half of what steady motion would
  const u = phase % (FLOW_PAUSE + T);
  if (u < FLOW_PAUSE) return 0;
  const m = u - FLOW_PAUSE;
  const eased = (x) => v * ta * (x * x * x - (x * x * x * x) / 2); // distance while the speed follows a smoothstep from 0 to v
  if (m < ta) return eased(m / ta);
  if (m < T - ta) return (v * ta) / 2 + v * (m - ta);
  return D - eased(Math.max(0, Math.min(1, (T - m) / ta)));
}
// Text that is wider than its box glides right-to-left. The text is rasterised once into a strip (two copies with a
// gap between them, at the device's resolution) and the strip is slid under a soft-edged window, so the letters keep
// one steady appearance while they move: re-drawing text at a new fractional position every frame makes its
// anti-aliasing flicker, which reads as shaking. The strips are cached by text, font, colour and scale.
const flowStrips = new Map();
function flowStrip(ctx, text, tw, gap, size, color, k) {
  const key = `${text}\u0001${ctx.font}\u0001${ctx.letterSpacing || ''}\u0001${color}\u0001${k.toFixed(4)}`;
  let strip = flowStrips.get(key);
  if (strip) return strip;
  const pad = size * 0.3, hU = size * 1.7, wU = tw * 2 + gap + pad * 2;
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.ceil(wU * k)); c.height = Math.max(1, Math.ceil(hU * k));
  const x = c.getContext('2d');
  x.scale(k, k); x.font = ctx.font; if ('letterSpacing' in x) x.letterSpacing = ctx.letterSpacing || '0px';
  x.textBaseline = 'alphabetic'; x.textAlign = 'left'; x.fillStyle = color;
  x.fillText(text, pad, size * 1.25); x.fillText(text, pad + tw + gap, size * 1.25);
  strip = { canvas: c, pad, hU };
  if (flowStrips.size > 96) { const k0 = flowStrips.keys().next().value; flowStrips.delete(k0); }
  flowStrips.set(key, strip);
  return strip;
}
let flowWindow = null; // one scratch canvas, resized as needed, for the soft-edged window
function flowText(ctx, text, x, y, w, phase, color, align = 'left') {
  text = String(text ?? '');
  const tw = measure(ctx, text);
  if (tw <= w) {
    ctx.textAlign = align;
    ctx.fillText(text, align === 'center' ? x + w / 2 : align === 'right' ? x + w : x, y);
    return;
  }
  const size = parseFloat((ctx.font.match(/(\d+(?:\.\d+)?)px/) || [0, 24])[1]);
  const gap = size * 2.2, fade = Math.min(Math.max(18, size * 1.1), w / 4);
  const offset = phase != null && phase > 0 ? flowOffset(phase, tw + gap) : 0;
  const k = Math.max(0.05, ctx.getTransform().a); // units → device pixels
  const strip = flowStrip(ctx, text, tw, gap, size, color, k);
  const span = w + fade, hU = strip.hU;
  const W = Math.max(1, Math.ceil(span * k)), H = Math.max(1, Math.ceil(hU * k));
  if (!flowWindow) flowWindow = document.createElement('canvas');
  if (flowWindow.width !== W || flowWindow.height !== H) { flowWindow.width = W; flowWindow.height = H; }
  const wx = flowWindow.getContext('2d');
  wx.setTransform(1, 0, 0, 1, 0, 0); wx.globalCompositeOperation = 'source-over'; wx.clearRect(0, 0, W, H);
  wx.imageSmoothingEnabled = true; wx.imageSmoothingQuality = 'high';
  wx.drawImage(strip.canvas, (fade - offset - strip.pad) * k, 0); // the glide itself: a bitmap slid by a fraction of a pixel
  const f = (fade / span) * W, g = wx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(f / W, 'rgba(0,0,0,1)'); g.addColorStop(1 - f / W, 'rgba(0,0,0,1)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  wx.globalCompositeOperation = 'destination-in'; wx.fillStyle = g; wx.fillRect(0, 0, W, H);
  // the window lands on whole device pixels, so only the text inside it moves
  const dx = Math.round((x - fade) * k) / k, dy = Math.round((y - size * 1.25) * k) / k;
  ctx.save(); ctx.imageSmoothingEnabled = false; // 1:1 already; no resampling of the window itself
  ctx.drawImage(flowWindow, dx, dy, W / k, H / k);
  ctx.restore();
}
function fitText(ctx, text, maxW) {
  text = String(text ?? '');
  if (measure(ctx, text) <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (measure(ctx, text.slice(0, mid).trimEnd() + '…') <= maxW) lo = mid; else hi = mid - 1; }
  return text.slice(0, lo).trimEnd() + '…';
}

export function makePlaceholderArt(song, size = 600) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  const hue = hashString((song.title || '') + '\u0001' + (song.artist || '') + song.id);
  const g = x.createLinearGradient(0, 0, size, size);
  g.addColorStop(0, rgbHex(hslToRgb(hue, 0.42, 0.30)));
  g.addColorStop(1, rgbHex(hslToRgb(hue + 0.12, 0.5, 0.16)));
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const r = x.createRadialGradient(size * 0.3, size * 0.25, 0, size * 0.3, size * 0.25, size * 0.9);
  r.addColorStop(0, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = r; x.fillRect(0, 0, size, size);
  const letter = ((song.title || '').trim().match(/\p{L}|\p{N}/u) || ['♪'])[0].toUpperCase();
  x.fillStyle = 'rgba(255,255,255,0.86)';
  x.font = `600 ${Math.round(size * 0.44)}px ${FONTS.sans}`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(letter, size / 2, size * 0.53);
  return c;
}

// ---------------------------------------------------------------- background (WebGL)
const VERT = `attribute vec2 aPos; varying vec2 vUv; void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uRes; uniform float uTime; uniform float uFrame; uniform float uSeed; uniform int uStyle;
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uC3; uniform vec3 uBase;
uniform float uGrain; uniform float uDim; uniform sampler2D uTexA; uniform sampler2D uTexB; uniform float uMix;

float hash21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float noise(vec2 p){ vec2 i = floor(p); vec2 f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(hash21(i), hash21(i+vec2(1.0,0.0)), u.x), mix(hash21(i+vec2(0.0,1.0)), hash21(i+vec2(1.0,1.0)), u.x), u.y); }
float fbm(vec2 p){ float v = 0.0; float a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = m * p + 3.7; a *= 0.5; } return v; }
vec3 blurTex(sampler2D t, vec2 uv){ float px = 1.35 / 48.0; vec3 c = vec3(0.0); float w = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) { float k = (i == 0 ? 2.0 : 1.0) * (j == 0 ? 2.0 : 1.0);
    c += texture2D(t, uv + vec2(float(i), float(j)) * px).rgb * k; w += k; } return c / w; }

void main(){
  vec2 uv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
  float t = uTime * 0.045 + uSeed * 37.0;
  vec3 col;
  if (uStyle == 0) {
    vec2 w = vec2(fbm(p * 1.05 + vec2(t * 0.9, -t * 0.6)), fbm(p * 1.05 + vec2(-t * 0.7, t * 0.8) + 4.2)) - 0.5;
    vec2 q = p + w * 0.75;
    col = uBase;
    // four soft pools of colour painted over each other: "over" compositing keeps hues clean
    vec2 c0 = vec2(-0.66 + 0.20 * sin(t * 1.9 + 0.4), 0.16 + 0.24 * cos(t * 1.3 + 1.0));
    vec2 c1 = vec2( 0.58 + 0.22 * cos(t * 1.5 + 2.0), -0.24 + 0.26 * sin(t * 1.1 + 0.6));
    vec2 c2 = vec2( 0.05 + 0.34 * sin(t * 0.9 + 4.0),  0.46 + 0.16 * cos(t * 1.7 + 2.5));
    vec2 c3 = vec2(-0.15 + 0.28 * cos(t * 1.2 + 5.5), -0.50 + 0.20 * sin(t * 1.4 + 3.1));
    vec2 dv; float a;
    dv = q - c0; a = exp(-dot(dv, dv) * 2.3); col = mix(col, uC0, a * 0.82);
    dv = q - c1; a = exp(-dot(dv, dv) * 2.1); col = mix(col, uC1, a * 0.76);
    dv = q - c2; a = exp(-dot(dv, dv) * 3.0); col = mix(col, uC2, a * 0.70);
    dv = q - c3; a = exp(-dot(dv, dv) * 2.7); col = mix(col, uC3, a * 0.64);
    col *= 0.82;
  } else if (uStyle == 1) {
    vec2 c = (uv - 0.5) * 0.8;
    vec2 w = vec2(fbm(p * 1.3 + t * 1.1), fbm(p * 1.3 - t * 0.8 + 7.0)) - 0.5;
    c += w * 0.07 + vec2(0.025 * sin(t * 2.0), 0.02 * cos(t * 1.6));
    vec2 tuv = vec2(c.x, c.y / aspect) + 0.5;
    vec3 img = mix(blurTex(uTexA, tuv), blurTex(uTexB, tuv), uMix);
    col = img * 0.66 + uBase * 0.22;
  } else {
    float n = fbm(p * 1.4 + vec2(t * 0.6, -t * 0.4));
    col = uBase * (0.75 + 0.5 * n);
    col += uC0 * 0.06 * exp(-length(p - vec2(-0.55, 0.25)) * 1.6);
    col += uC1 * 0.04 * exp(-length(p - vec2(0.6, -0.3)) * 1.8);
  }
  float v = smoothstep(0.35, 1.3, length(p * vec2(0.82, 1.0)));
  col *= 1.0 - 0.5 * v;
  col *= 1.0 - uDim;
  float g = hash21(gl_FragCoord.xy + vec2(uFrame * 13.1, uFrame * 7.7));
  col += (g - 0.5) * uGrain;
  col += (hash21(gl_FragCoord.xy * 0.71 + uFrame * 0.37) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export class Background {
  constructor(width, height) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    const gl = this.gl = this.canvas.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL is not available');
    const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = this.prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of ['uRes', 'uTime', 'uFrame', 'uSeed', 'uStyle', 'uC0', 'uC1', 'uC2', 'uC3', 'uBase', 'uGrain', 'uDim', 'uTexA', 'uTexB', 'uMix']) this.u[n] = gl.getUniformLocation(prog, n);
    gl.uniform1i(this.u.uTexA, 0); gl.uniform1i(this.u.uTexB, 1);
    this.textures = new Map();
    this.blank = this.makeTexture(); // 1x1 black
    gl.bindTexture(gl.TEXTURE_2D, this.blank);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([10, 10, 12, 255]));
  }
  makeTexture() {
    const gl = this.gl; const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }
  texture(key, canvas) { // upload once per key
    if (!key || !canvas) return this.blank;
    let t = this.textures.get(key);
    if (!t) {
      t = this.makeTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, t);
      this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, true);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, canvas);
      this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
      if (this.textures.size > 64) { const [k0, t0] = this.textures.entries().next().value; this.gl.deleteTexture(t0); this.textures.delete(k0); }
      this.textures.set(key, t);
    }
    return t;
  }
  render({ time, frame, seed, style, palette, grain, dim = 0, texA, texB, mix }) {
    const gl = this.gl, u = this.u;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uTime, time); gl.uniform1f(u.uFrame, frame % 4096); gl.uniform1f(u.uSeed, seed);
    gl.uniform1i(u.uStyle, Math.max(0, STYLES.indexOf(style)));
    const c = palette.colors;
    gl.uniform3f(u.uC0, ...c[0]); gl.uniform3f(u.uC1, ...c[1]); gl.uniform3f(u.uC2, ...c[2]); gl.uniform3f(u.uC3, ...c[3]);
    gl.uniform3f(u.uBase, ...palette.base);
    gl.uniform1f(u.uGrain, grain); gl.uniform1f(u.uDim, dim); gl.uniform1f(u.uMix, mix);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA || this.blank);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB || this.blank);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  dispose() { const ext = this.gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); }
}

// ---------------------------------------------------------------- layout (unit space: 1080-high reference)
// heights of the art column below the artwork, depending on which text is shown
function artBlock(artSize, opts) {
  let h = artSize, titleY = 0, artistY = 0, barY = 0, eyebrowY = 0, nextY = 0;
  const barH = opts.progressStyle === 'wave' ? 30 : 4;
  if (opts.showNowPlaying) {
    if (opts.eyebrow) { eyebrowY = h + 34 + 16; h += 26; }
    titleY = h + 34 + 40; artistY = titleY + 36; h += 34 + 48 + 34;
  }
  if (opts.showProgress) { barY = h + (opts.showNowPlaying ? 26 : 40); h = barY + barH + 14 + 22; }
  if (opts.showNext) { nextY = h + 24; h += 46; } // the Up next line: a label pill and the next title, under the song time
  return { h, titleY, artistY, barY, barH, eyebrowY, nextY };
}
export const ROW_STYLES = {
  comfortable: { rowH: 80, rowGap: 10, pad: 12, thumb: 56, idxW: 46, idxFont: 20, title: 24, sub: 19, dur: 19, titleDy: -13, subDy: 14 },
  compact: { rowH: 62, rowGap: 6, pad: 10, thumb: 42, idxW: 40, idxFont: 17, title: 21, sub: 16.5, dur: 17, titleDy: -11, subDy: 12 },
};
// corner radius as a fraction of the element size, per the Artwork › Corners setting
const CORNER = { sharp: 0.012, soft: 0.045, round: 0.14 };
export const cornerRadius = (corners, size) => Math.round(size * (CORNER[corners] || CORNER.soft));
// Dancers are described as { place, h, w } in unit space; the layout returns a box per dancer ({ x, y: feet line, w, h })
// and moves the artwork or trims the list so nothing important is covered.
function packRow(list, maxH, gap = 24) { // side by side, each scaled to fit maxH; returns [{ w, h, dx }] and the total width
  const items = list.map((d) => { const h = Math.min(d.h, maxH), w = h * (d.w / d.h); return { w, h }; });
  let x = 0;
  for (const it of items) { it.dx = x; x += it.w + gap; }
  return { items, width: Math.max(0, x - gap) };
}
function computeLayout(Wu, Hu, opts) {
  const M = Math.round(Math.min(Wu, Hu) * 0.111);
  const vertical = Wu < Hu * 1.15;
  const RS = ROW_STYLES[opts.density] || ROW_STYLES.comfortable;
  const rowH = RS.rowH, rowGap = RS.rowGap, pitch = rowH + rowGap;
  const headerH = opts.headerLines === 2 ? 96 : opts.headerLines === 1 ? 66 : 0;
  const dancers = opts.dancers || [];
  const boxes = dancers.map(() => null);
  const group = (id) => dancers.map((d, k) => ({ ...d, k })).filter((d) => d.place === id);
  const GAP = 24;
  const place = (list, maxH, x0, feetY, align = 'left') => { // lays a group side by side; align 'center' centres it on x0
    const { items, width } = packRow(list, maxH);
    const left = align === 'center' ? x0 - width / 2 : align === 'right' ? x0 - width : x0;
    items.forEach((it, i) => { boxes[list[i].k] = { x: left + it.dx, y: feetY, w: it.w, h: it.h, place: list[i].place }; });
    return width;
  };
  const maxH = (list) => Math.max(0, ...list.map((d) => d.h));
  // a dancer placed by hand: x and y are the feet point as fractions of the frame, kept inside it
  const freeBox = (d) => { const w = Math.min(d.w, Wu), h = Math.min(d.h, Hu); const cx = clamp((d.x == null ? 0.5 : d.x) * Wu, w / 2, Wu - w / 2), fy = clamp((d.y == null ? 0.85 : d.y) * Hu, h, Hu); return { x: cx - w / 2, y: fy, w, h, place: 'custom' }; };
  const viz = opts.viz || null; // { place, h, hFull, w, x, y }
  const customBox = () => { const w = clamp(viz.w, 0.1, 1) * Wu, h = Math.min(viz.h, Hu); return { x: clamp(viz.x * Wu, 0, Wu - w), y: clamp(viz.y * Hu, 0, Hu - h), w, h }; };
  // strips along the top or bottom live in the margin and push everything else inwards
  const topR = viz && viz.place === 'top' ? 36 + viz.h + 24 : 0, botR = viz && viz.place === 'bottom' ? 36 + viz.h + 24 : 0;
  const vizUnder = viz && viz.place === 'under-art' ? viz.h : 0;
  if (!vertical) {
    const areaTop = Math.max(M, topR), areaBottom = Math.min(Hu - M, Hu - botR);
    let artSize = Math.min(540, Math.round(Hu * 0.5), Math.round(Wu * 0.36));
    const under = group('under-art'), beside = group('beside-art'), byList = group('beside-list'), corner = group('corner'), onArt = group('on-art');
    // under the artwork (visualizer first, then dancers): the artwork gives up a little height (never below 320) so the column fits
    let underH = 0, vizUnderH = 0;
    if (under.length || vizUnder) {
      const extras = artBlock(artSize, opts).h - artSize;
      const room = (areaBottom - areaTop) + 0.8 * M - extras; // the column may reach 40 % into each margin
      const want = (vizUnder ? vizUnder + GAP : 0) + (under.length ? maxH(under) + GAP : 0);
      artSize = Math.round(clamp(Math.min(artSize, room - want), 320, artSize));
      let left = room - artSize;
      if (vizUnder) { vizUnderH = clamp(Math.min(vizUnder, left - GAP), 40, vizUnder); left -= vizUnderH + GAP; }
      if (under.length) underH = clamp(left - GAP, 60, maxH(under));
    }
    const colGap = Math.round(Math.min(120, Wu * 0.0625));
    const right = opts.side === 'right';
    const artX = right ? Wu - M - artSize : M;
    // beside the artwork: a column between the artwork and the list
    let besideH = beside.length ? Math.min(artSize, maxH(beside)) : 0, besideW = beside.length ? packRow(beside, besideH).width : 0;
    // beside the list: the list gives up width on its outer side
    let byListH = byList.length ? Math.min(Hu - 2 * M - headerH, maxH(byList)) : 0, byListW = byList.length ? packRow(byList, byListH).width : 0;
    const sideOf = () => (besideW ? besideW + GAP : 0) + (byListW ? byListW + GAP * 1.5 : 0);
    let listX = right ? M + 50 + (byListW ? byListW + GAP * 1.5 : 0) : M + artSize + colGap + (besideW ? besideW + GAP : 0);
    let listRight = right ? Wu - M - artSize - colGap - (besideW ? besideW + GAP : 0) : Wu - M - (byListW ? byListW + GAP * 1.5 : 0);
    const minListW = Math.min(420, Wu * 0.3);
    if (listRight - listX < minListW && sideOf() > 0) { // the list must stay readable: side dancers shrink together
      const k = Math.max(0.25, 1 - (minListW - (listRight - listX)) / (besideW + byListW));
      besideH *= k; besideW *= k; byListH *= k; byListW *= k;
      listX = right ? M + 50 + (byListW ? byListW + GAP * 1.5 : 0) : M + artSize + colGap + (besideW ? besideW + GAP : 0);
      listRight = right ? Wu - M - artSize - colGap - (besideW ? besideW + GAP : 0) : Wu - M - (byListW ? byListW + GAP * 1.5 : 0);
    }
    const listW = listRight - listX;
    // bottom corner: whatever sits above it ends before the dancer's head
    const cornerH = corner.length ? Math.min(Hu * 0.5, maxH(corner)) : 0;
    let listMaxBottom = areaBottom;
    if (corner.length && !right) listMaxBottom = Math.min(listMaxBottom, Hu - 36 - cornerH - 16);
    // the list shows whole rows only; leftover space is split above and below so the column sits centred
    const avail = listMaxBottom - areaTop - headerH;
    const slots = Math.max(1, Math.floor((avail + rowGap) / pitch));
    const slack = Math.max(0, avail - (slots * pitch - rowGap));
    const listTop = areaTop + Math.round(slack / 2), rowsTop = listTop + headerH, listBottom = rowsTop + slots * pitch - rowGap;
    let B = artBlock(artSize, opts);
    const belowArt = (vizUnderH ? GAP + vizUnderH : 0) + (underH ? GAP + underH : 0);
    let blockY = Math.round((areaTop + areaBottom - (B.h + belowArt)) / 2);
    if (corner.length && right) { // the corner dancer stands under the artwork column: lift the artwork, shrinking it rather than cramping the top margin
      const lifted = Hu - 36 - cornerH - 20 - B.h;
      if (lifted < M * 0.75) { artSize = Math.round(clamp(artSize - (M * 0.75 - lifted), 320, artSize)); B = artBlock(artSize, opts); }
      blockY = Math.min(blockY, Hu - 36 - cornerH - 20 - B.h - belowArt);
    }
    blockY = Math.max(blockY, Math.round(areaTop - M * 0.5));
    const artX2 = right ? Wu - M - artSize : M;
    if (under.length) place(under, underH, artX2 + artSize / 2, blockY + B.h + belowArt, 'center');
    if (beside.length) place(beside, besideH, right ? artX2 - GAP - besideW : artX2 + artSize + GAP, blockY + artSize);
    if (byList.length) place(byList, Math.min(byListH, listBottom - listTop), right ? M * 0.6 : Wu - M * 0.6 - byListW, listBottom);
    if (corner.length) place(corner, cornerH, Wu - 44, Hu - 36, 'right');
    if (onArt.length) place(onArt, Math.min(artSize * 0.5, maxH(onArt)), artX2 + artSize + Math.min(artSize * 0.5, maxH(onArt)) * 0.35, blockY + artSize + Math.min(artSize * 0.5, maxH(onArt)) * 0.08, 'right');
    for (const d of group('custom')) boxes[d.k] = freeBox(d);
    return {
      vertical, M, artSize, art: { x: artX2, y: blockY, size: artSize, r: cornerRadius(opts.corners, artSize) },
      text: { x: artX2, w: artSize, align: 'left', titleY: blockY + B.titleY, artistY: blockY + B.artistY, titleSize: 40, artistSize: 26, eyebrowY: blockY + B.eyebrowY, nextY: blockY + B.nextY },
      progress: { x: artX2, w: artSize, y: blockY + B.barY, h: B.barH, timesY: blockY + B.barY + B.barH + 14 + 10 },
      list: { x: listX, w: listW, top: listTop, bottom: listBottom, rowsTop, rowH, rowGap, pitch, slots, headerH },
      arrow: { x: listX - 50 },
      dancers: boxes,
      viz: !viz ? null
        : viz.place === 'under-art' ? { x: artX2, y: blockY + B.h + GAP, w: artSize, h: vizUnderH }
        : viz.place === 'on-art' ? { x: artX2 + 24, y: blockY + artSize - 24 - Math.min(viz.h, artSize * 0.45), w: artSize - 48, h: Math.min(viz.h, artSize * 0.45) }
        : viz.place === 'bottom' ? { x: M, y: Hu - 36 - viz.h, w: Wu - 2 * M, h: viz.h }
        : viz.place === 'top' ? { x: M, y: 36, w: Wu - 2 * M, h: viz.h }
        : viz.place === 'behind' ? { x: 0, y: Hu - viz.hFull, w: Wu, h: viz.hFull }
        : customBox(),
    };
  }
  // portrait / square: artwork on top, list below; shrink the artwork until at least three rows fit
  const side = [...group('under-art'), ...group('beside-art')], byList = group('beside-list'), corner = group('corner'), onArt = group('on-art');
  let artFrac = 0.34, artSize, blockBottom, avail, slots, B;
  const cornerH = corner.length ? Math.min(Hu * 0.35, maxH(corner)) : 0;
  const areaTop = Math.max(M, topR);
  const listMaxBottom = Math.min(corner.length ? Hu - 36 - cornerH - 16 : Hu - M, Hu - M, Hu - botR);
  const vizUnderH = vizUnder ? Math.min(vizUnder, Math.round(Hu * 0.12)) : 0;
  for (;;) {
    artSize = Math.min(Math.round(Wu - 2 * M), Math.round(Hu * artFrac));
    B = artBlock(artSize, opts);
    blockBottom = areaTop + B.h + (vizUnderH ? GAP + vizUnderH : 0);
    avail = listMaxBottom - (blockBottom + 40) - headerH;
    slots = Math.max(1, Math.floor((avail + rowGap) / pitch));
    if (slots >= 3 || artFrac <= 0.2) break;
    artFrac -= 0.02;
  }
  // a dancer beside the artwork: the artwork moves over, shrinking a little if it must
  let sideH = side.length ? Math.min(artSize, maxH(side)) : 0, sideW = side.length ? packRow(side, sideH).width : 0;
  if (side.length) {
    const roomW = Wu - 48 - 2 * GAP;
    if (artSize + 2 * sideW > roomW) artSize = Math.round(clamp(roomW - 2 * sideW, 300, artSize));
    if (artSize + 2 * sideW > roomW) { const k = Math.max(0.3, (roomW - artSize) / (2 * sideW)); sideW *= k; sideH *= k; }
    B = artBlock(artSize, opts); blockBottom = areaTop + B.h + (vizUnderH ? GAP + vizUnderH : 0);
    avail = listMaxBottom - (blockBottom + 40) - headerH; slots = Math.max(1, Math.floor((avail + rowGap) / pitch));
  }
  const artX = Math.round((Wu - artSize) / 2), artY = areaTop;
  const byListH = byList.length ? Math.min(avail, maxH(byList)) : 0, byListW = byList.length ? packRow(byList, byListH).width : 0;
  const listX = M + 52, listRight = Wu - M - (byListW ? byListW + GAP : 0), listW = listRight - listX;
  const listTop = blockBottom + 40, rowsTop = listTop + headerH, listBottom = rowsTop + slots * pitch - rowGap;
  if (side.length) place(side, sideH, artX + artSize + GAP, artY + artSize);
  if (byList.length) place(byList, Math.min(byListH, listBottom - listTop), Wu - 40, listBottom, 'right');
  if (corner.length) place(corner, cornerH, Wu - 36, Hu - 36, 'right');
  if (onArt.length) place(onArt, Math.min(artSize * 0.5, maxH(onArt)), artX + artSize + Math.min(artSize * 0.5, maxH(onArt)) * 0.35, artY + artSize + Math.min(artSize * 0.5, maxH(onArt)) * 0.08, 'right');
  for (const d of group('custom')) boxes[d.k] = freeBox(d);
  return {
    vertical, M, artSize, art: { x: artX, y: artY, size: artSize, r: cornerRadius(opts.corners, artSize) },
    text: { x: Wu / 2, w: Wu - 2 * M, align: 'center', titleY: artY + B.titleY, artistY: artY + B.artistY, titleSize: 40, artistSize: 26, eyebrowY: artY + B.eyebrowY, nextY: artY + B.nextY },
    progress: { x: artX, w: artSize, y: artY + B.barY, h: B.barH, timesY: artY + B.barY + B.barH + 14 + 10 },
    list: { x: listX, w: listW, top: listTop, bottom: listBottom, rowsTop, rowH, rowGap, pitch, slots, headerH },
    arrow: { x: listX - 50 },
    dancers: boxes,
    viz: !viz ? null
      : viz.place === 'under-art' ? { x: artX, y: artY + B.h + GAP, w: artSize, h: vizUnderH }
      : viz.place === 'on-art' ? { x: artX + 24, y: artY + artSize - 24 - Math.min(viz.h, artSize * 0.45), w: artSize - 48, h: Math.min(viz.h, artSize * 0.45) }
      : viz.place === 'bottom' ? { x: M, y: Hu - 36 - viz.h, w: Wu - 2 * M, h: viz.h }
      : viz.place === 'top' ? { x: M, y: 36, w: Wu - 2 * M, h: viz.h }
      : viz.place === 'behind' ? { x: 0, y: Hu - viz.hFull, w: Wu, h: viz.hFull }
      : customBox(),
  };
}

// numeric fields of two layouts blended by k (0 = the first, 1 = the second); everything else comes from the second
function blendLayout(a, b, k) {
  if (a === b || k >= 1) return b;
  if (k <= 0) return a;
  const mix = (x, y, key) => {
    if (typeof x === 'number' && typeof y === 'number') return key === 'slots' ? Math.floor(lerp(x, y, k) + 1e-6) : lerp(x, y, k);
    if (x && y && typeof x === 'object' && !Array.isArray(x) && typeof y === 'object' && !Array.isArray(y)) { const o = {}; for (const kk of Object.keys(y)) o[kk] = kk in x ? mix(x[kk], y[kk], kk) : y[kk]; return o; }
    return y;
  };
  return mix(a, b, '');
}

// ---------------------------------------------------------------- renderer
export class Renderer {
  constructor(width, height, canvas = null) {
    this.canvas = canvas || document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.layers = new Map();
    this.tiny = new Map();
    this.videoProvider = null; // { meta(id) → video meta | null, frame(id, videoTime) → CanvasImageSource | null }; set by the editor (synced <video>s) or the export (decoded frames)
    this.resize(width, height);
  }
  resize(width, height) {
    width = Math.max(2, Math.round(width)); height = Math.max(2, Math.round(height));
    if (this.W === width && this.H === height) return;
    this.W = width; this.H = height;
    this.canvas.width = width; this.canvas.height = height;
    if (this.bg) this.bg.dispose();
    this.bg = new Background(width, height);
    // unit scale: 1080-high reference for landscape, 1080-wide for portrait and square frames
    this.u = width < height * 1.15 ? width / 1080 : Math.min(width / 1920, height / 1080);
    this.Wu = width / this.u; this.Hu = height / this.u;
    this.layers.clear();
    this.layoutKey = null;
  }
  setProject(project) {
    this.project = project;
    this.songs = project.songs.filter((s) => !s.error);
    this.timeline = buildTimeline(this.songs, project.timing);
    const look = project.look;
    this.headerTitle = look.showTitle !== false && project.title ? project.title : '';
    const n = this.songs.length;
    const musicLength = this.timeline.musicEnd - this.timeline.lead - this.timeline.gap * Math.max(0, n - 1);
    this.headerMeta = [project.subtitle || '', look.showMeta !== false && n ? `${n} ${n === 1 ? 'track' : 'tracks'} · ${formatDurationLong(musicLength)}` : ''].filter(Boolean).join(' · ');
    const headerLines = (this.headerTitle ? 1 : 0) + (this.headerMeta ? 1 : 0);
    // dancers: sprites that are loaded, with the room each one needs (unit space); by-title needs a title to stand next to
    this.dancers = (project.dancers || []).filter((d) => d && d.sprite && d.sprite.image && d.sprite.meta && d.sprite.meta.frames > 0 && d.sprite.meta.cell);
    this.dance = project.dance || { mode: 'auto', sensitivity: 0.5 };
    const specs = this.dancers.map((d) => {
      const m = d.sprite.meta, h = Math.round(clamp(+d.size || DANCE_SIZE.def, DANCE_SIZE.min, DANCE_SIZE.max) * 1080);
      let place = DANCE_PLACES.some((p) => p.id === d.place) ? d.place : 'under-art';
      if (place === 'by-title' && !this.headerTitle) place = 'on-art';
      return { place, h, w: Math.round(h * (m.cell.w / m.cell.h)), x: clamp01(+d.x || 0), y: clamp01(d.y == null ? 0.85 : +d.y) };
    });
    this.titleReserve = specs.filter((sp) => sp.place === 'by-title').reduce((a, sp) => a + Math.min(sp.h, 64) * (sp.w / sp.h) + 18, 0);
    // the frequency visualizer: a box the layout keeps clear (or, for 'behind' and 'custom', just a box)
    const vz = project.viz && project.viz.style && project.viz.style !== 'off' ? project.viz : null;
    this.viz = vz;
    const vizSpec = vz ? (() => {
      const size = clamp(+vz.size || VIZ_SIZE.def, VIZ_SIZE.min, VIZ_SIZE.max);
      const labels = vz.labels !== false && vz.style !== 'bands' && vz.place !== 'behind';
      return { place: VIZ_PLACES.some((p) => p.id === vz.place) ? vz.place : 'under-art', h: Math.round(size * 1080) + (labels ? vizLabelH(vz.labelSize) : 0), hFull: Math.round(size * this.Hu), w: clamp(+vz.w || 0.4, 0.1, 1), x: clamp01(+vz.x || 0), y: clamp01(+vz.y || 0) };
    })() : null;
    const opts = { headerLines, showProgress: look.showProgress !== false, showNowPlaying: look.showNowPlaying !== false, eyebrow: !!look.eyebrow, showNext: !!look.showNext, progressStyle: look.progress === 'wave' ? 'wave' : 'bar', density: look.density || 'comfortable', side: look.side || 'left', corners: look.corners || 'soft', dancers: specs, viz: vizSpec };
    this.captions = Array.isArray(project.captions) ? project.captions.filter((c) => c && typeof c.text === 'string') : [];
    this.logo = project.logo && project.logo.id && project.logo.image ? project.logo : null;
    // Balanced composition: the more extras are on, the more the secondary ones step back (0 = nothing to calm, 1 = very busy)
    this.balanced = look.balance !== 'exact';
    const extras = (vz ? 1 : 0) + (this.logo ? 1 : 0) + this.captions.length + (look.eyebrow ? 1 : 0) + (look.showNext ? 1 : 0) + (look.showClock ? 1 : 0) + (this.dancers.length ? 1 : 0) + (look.progress === 'wave' ? 1 : 0);
    this.calm = this.balanced ? clamp01((extras - 2) / 4) : 0;
    const active = this.songs.map((s) => dancerActive(s, this.dance) === true);
    this.danceRuns = [];
    let runStart = null;
    this.songs.forEach((s, i) => { const seg = this.timeline.segs[i]; if (!active[i]) return; if (runStart == null) runStart = seg.start; if (!active[i + 1]) { this.danceRuns.push({ start: runStart, end: seg.end }); runStart = null; } });
    const key = JSON.stringify([this.W, this.H, opts]);
    if (key !== this.layoutKey) {
      // the layout makes room for dancers only while they are on screen: keep the plain layout and the one with room, and blend
      this.layoutDance = computeLayout(this.Wu, this.Hu, opts);
      this.layoutBase = specs.some((sp) => sp.place !== 'custom') ? computeLayout(this.Wu, this.Hu, { ...opts, dancers: specs.filter((sp) => sp.place === 'custom') }) : this.layoutDance;
      if (this.layoutBase !== this.layoutDance) this.layoutBase.dancers = this.layoutDance.dancers; // the boxes themselves always come from the layout with room
      this.layout = this.layoutBase;
      this.layoutKey = key;
      this.blendK = null; this.blended = null;
      this.layers.clear();
    }
    if (this.fontKey !== project.look.font) { this.fontKey = project.look.font; measureCache.clear(); }
  }
  get font() { return FONTS[this.project.look.font] || FONTS.sans; }

  // cached art layer: image with rounded corners, hairline and shadow, at pixel size
  // the artwork's drop shadow never changes between songs, so it is one cached layer drawn under whichever art is showing
  get artLayerSizeU() { return Math.max(this.layoutBase.art.size, this.layoutDance.art.size); }
  shadowLayer() {
    const sizeU = this.artLayerSizeU, sizePx = Math.round(sizeU * this.u);
    const key = `shadow:${sizePx}:${cornerRadius(this.project.look.corners || 'soft', sizeU)}`;
    let L = this.layers.get(key);
    if (L) return L;
    const padPx = Math.round(sizePx * 0.32);
    const c = document.createElement('canvas'); c.width = c.height = sizePx + 2 * padPx;
    const x = c.getContext('2d');
    const r = Math.round(cornerRadius(this.project.look.corners || 'soft', sizeU) * this.u);
    x.save(); x.shadowColor = 'rgba(0,0,0,0.5)'; x.shadowBlur = sizePx * 0.2; x.shadowOffsetY = sizePx * 0.07;
    roundRect(x, padPx, padPx, sizePx, sizePx, r); x.fillStyle = '#000'; x.fill(); x.restore();
    x.save(); x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = sizePx * 0.05; x.shadowOffsetY = sizePx * 0.015;
    roundRect(x, padPx, padPx, sizePx, sizePx, r); x.fill(); x.restore();
    L = { canvas: c, padU: padPx / this.u, sizeU };
    this.layers.set(key, L);
    return L;
  }
  artLayer(song) {
    const sizeU = this.artLayerSizeU, sizePx = Math.round(sizeU * this.u);
    const rU = cornerRadius(this.project.look.corners || 'soft', sizeU);
    const key = `art:${song.id}:${song.coverVersion}:${sizePx}:${rU}`;
    let L = this.layers.get(key);
    if (L) return L;
    const c = document.createElement('canvas'); c.width = c.height = sizePx;
    const x = c.getContext('2d');
    const r = Math.round(rU * this.u);
    x.save(); roundRect(x, 0, 0, sizePx, sizePx, r); x.clip();
    x.imageSmoothingQuality = 'high';
    drawCover(x, song.image, 0, 0, sizePx, sizePx); x.restore();
    const lw = Math.max(1, this.u);
    roundRect(x, lw / 2, lw / 2, sizePx - lw, sizePx - lw, Math.max(0, r - lw / 2));
    x.strokeStyle = 'rgba(255,255,255,0.13)'; x.lineWidth = lw; x.stroke();
    L = { canvas: c, sizeU };
    this.layers.set(key, L);
    return L;
  }
  // build a song's cached layers ahead of its transition so the first frame of a change never stalls
  warm(song) {
    if (!song || !song.image) return;
    this.artLayer(song); this.thumbLayer(song);
    if (this.project.look.style === 'cover') this.tinyTexture(song);
  }
  thumbLayer(song) {
    const sizeU = (ROW_STYLES[this.project.look.density] || ROW_STYLES.comfortable).thumb, sizePx = Math.round(sizeU * this.u);
    const corners = this.project.look.corners || 'soft';
    const key = `thumb:${song.id}:${song.coverVersion}:${sizePx}:${corners}`;
    let L = this.layers.get(key);
    if (L) return L;
    const c = document.createElement('canvas'); c.width = c.height = sizePx;
    const x = c.getContext('2d');
    const r = Math.round(sizePx * ({ sharp: 0.03, soft: 0.125, round: 0.3 }[corners] || 0.125));
    x.save(); roundRect(x, 0, 0, sizePx, sizePx, r); x.clip(); x.imageSmoothingQuality = 'high';
    drawCover(x, song.image, 0, 0, sizePx, sizePx); x.restore();
    const lw = Math.max(1, this.u * 0.75);
    roundRect(x, lw / 2, lw / 2, sizePx - lw, sizePx - lw, Math.max(0, r - lw / 2));
    x.strokeStyle = 'rgba(255,255,255,0.12)'; x.lineWidth = lw; x.stroke();
    L = { canvas: c, sizeU };
    this.layers.set(key, L);
    return L;
  }
  tinyTexture(song) { // 48px square cover for the "cover" background style, built with a halving chain
    if (!song || !song.image) return null;
    const key = `${song.id}:${song.coverVersion}`;
    let c = this.tiny.get(key);
    if (!c) {
      let src = song.image, size = Math.max(src.naturalWidth || src.width, src.naturalHeight || src.height);
      let cur = document.createElement('canvas'); const first = Math.min(512, size); cur.width = cur.height = first;
      drawCover(cur.getContext('2d'), src, 0, 0, first, first);
      let s = first;
      while (s > 48) {
        const next = Math.max(48, Math.round(s / 2));
        const n = document.createElement('canvas'); n.width = n.height = next;
        const nx = n.getContext('2d'); nx.imageSmoothingQuality = 'high'; nx.drawImage(cur, 0, 0, next, next);
        cur = n; s = next;
      }
      c = cur; this.tiny.set(key, c);
    }
    return this.bg.texture(key, c);
  }
  paletteOf(song) { return (song && song.palette) || DEFAULT_PALETTE; }

  // how much of the dancers' room the layout has at time t: opens just before the first dancer of a run pops in, closes around the run's end
  roomAt(t) {
    if (!this.danceRuns || !this.danceRuns.length || this.layoutBase === this.layoutDance) return 0;
    let k = 0;
    for (const r of this.danceRuns) {
      const rise = easeInOutCubic(clamp01((t - (r.start - 0.7)) / 0.7));
      const fall = 1 - easeInOutCubic(clamp01((t - (r.end - 0.35)) / 0.7));
      k = Math.max(k, Math.min(rise, fall));
    }
    return k;
  }
  layoutFor(t) {
    const k = this.roomAt(t);
    if (k <= 0.001) return this.layoutBase;
    if (k >= 0.999) return this.layoutDance;
    const kq = Math.round(k * 500) / 500;
    if (this.blendK !== kq) { this.blendK = kq; this.blended = blendLayout(this.layoutBase, this.layoutDance, kq); }
    return this.blended;
  }

  // ---- backgrounds: the mix's choice, a song's own choice, or a song's video
  videoMeta(id) { return id && this.videoProvider && this.videoProvider.meta ? this.videoProvider.meta(id) : null; }
  // the background a song's stretch of the video uses: the song's video (if it shows it behind), the song's own style, or the mix's
  bgSpecFor(song) {
    const look = this.project.look;
    if (song && (song.videoUse === 'background' || song.videoUse === 'both')) {
      const id = songVideoId(song);
      if (id && this.videoMeta(id)) return { style: 'video', id, blur: song.videoBlur == null ? look.videoBlur : song.videoBlur, song, own: song.videoPick !== 'other' };
    }
    if (song && song.bg && BG_STYLES.includes(song.bg.style)) return { style: song.bg.style };
    if (look.style === 'video') return look.videoId && this.videoMeta(look.videoId) ? { style: 'video', id: look.videoId, blur: look.videoBlur, song: null, own: false } : { style: 'ink' };
    return { style: BG_STYLES.includes(look.style) ? look.style : 'aurora' };
  }
  // a song's video in the artwork's place
  artSpecFor(song) {
    if (!song || !(song.videoUse === 'art' || song.videoUse === 'both')) return null;
    const id = songVideoId(song);
    return id && this.videoMeta(id) ? { style: 'video', id, song, own: song.videoPick !== 'other' } : null;
  }
  // The video time a spec shows at mix time t, with the rate it moves at. A song's own video follows the song's
  // audio (its trim included) and holds its last frame; a video given to a song loops from the song's start at the
  // Motion rate; the mix's background video loops from the start of the mix.
  videoTimeFor(spec, t) {
    const m = this.videoMeta(spec.id);
    if (!m || !(m.frames > 0)) return { vt: 0, rate: 0 };
    const dur = m.frames / m.fps;
    if (spec.song) {
      const k = this.songs.indexOf(spec.song), start = k >= 0 ? this.timeline.segs[k].start : 0;
      if (spec.own) { const ft = trimStart(spec.song) + (t - start), last = Math.max(0, dur - 1 / m.fps); return ft >= last ? { vt: last, rate: 0 } : ft < 0 ? { vt: 0, rate: 0 } : { vt: ft, rate: 1 }; }
      const rate = this.project.look.motion == null ? 1 : +this.project.look.motion;
      if (!(rate > 0)) return { vt: Math.min(1, dur * 0.1), rate: 0 };
      return { vt: ((((t - start) * rate) % dur) + dur) % dur, rate };
    }
    const rate = this.project.look.motion == null ? 1 : +this.project.look.motion;
    return { vt: videoTimeAt(this.project.look, m, t), rate: rate > 0 ? rate : 0 };
  }
  // the video frames a frame at t needs: the current (and, during a change, the previous) song's background and artwork videos
  videoNeeds(t) {
    const out = [], tl = this.timeline, n = this.songs.length;
    if (!n) return out;
    const i = tl.indexAt(t), cur = this.songs[i], prv = i > 0 ? this.songs[i - 1] : null, since = t - tl.changeAt[i];
    const add = (spec) => { if (spec && spec.style === 'video' && !out.some((o) => o.id === spec.id)) out.push({ id: spec.id, ...this.videoTimeFor(spec, t) }); };
    add(this.bgSpecFor(cur)); add(this.artSpecFor(cur));
    if (prv && since < PAL_TRANS) { add(this.bgSpecFor(prv)); add(this.artSpecFor(prv)); }
    return out;
  }
  drawBackground(t, frameIndex, cur, prv, pp, palette) {
    const { W, H, ctx } = this, P = this.project, look = P.look, n = this.songs.length;
    const specC = this.bgSpecFor(cur), specP = prv ? this.bgSpecFor(prv) : null;
    const same = !specP || (specP.style === specC.style && specP.id === specC.id && specP.song === specC.song);
    const gl = (spec, pal, texA, texB, mix, alpha) => {
      const motion = look.motion == null ? 1 : +look.motion;
      this.bg.render({ time: t * motion + (motion === 0 ? 7 : 0), frame: frameIndex, seed: P.seed || 0, style: spec.style, palette: pal, grain: (look.grain ?? 0.4) * 0.09, dim: clamp01(+look.dim || 0), texA, texB, mix });
      ctx.save(); ctx.globalAlpha = alpha; ctx.drawImage(this.bg.canvas, 0, 0, W, H); ctx.restore();
    };
    if (same) {
      if (specC.style === 'video') this.drawVideo(specC, t, frameIndex, 1);
      else gl(specC, palette, n ? this.tinyTexture(prv || cur) : null, n ? this.tinyTexture(cur) : null, prv ? pp : 1, 1);
    } else { // the new song brings a different background: it fades in over the old one
      if (specP.style === 'video') this.drawVideo(specP, t, frameIndex, 1); else gl(specP, this.paletteOf(prv), this.tinyTexture(prv), this.tinyTexture(prv), 1, 1);
      if (pp > 0.002) { if (specC.style === 'video') this.drawVideo(specC, t, frameIndex, pp); else gl(specC, this.paletteOf(cur), this.tinyTexture(cur), this.tinyTexture(cur), 1, pp); }
    }
  }
  // A video background: the frame for time t, cover-fitted, optionally softened (a quarter-size layer blurred and
  // scaled back up: cheap, and a blur there is four times as wide), darkened by the Darken setting, with film grain
  // blended over so it matches the other styles. Without a frame yet (still loading) the base colour shows.
  drawVideo(spec, t, frameIndex, alpha = 1) {
    const { W, H, ctx } = this, look = this.project.look, m = this.videoMeta(spec.id);
    if (alpha >= 0.999) { ctx.fillStyle = '#0a0a0c'; ctx.fillRect(0, 0, W, H); }
    const img = m && m.w > 0 && m.frames > 0 && this.videoProvider ? this.videoProvider.frame(spec.id, this.videoTimeFor(spec, t).vt) : null;
    if (!img && alpha < 0.999) return;
    ctx.save(); ctx.globalAlpha = alpha;
    if (img) {
      const s = Math.max(W / m.w, H / m.h), dw = m.w * s, dh = m.h * s, dx = (W - dw) / 2, dy = (H - dh) / 2;
      const blur = clamp01(+spec.blur || 0);
      if (blur > 0.005) {
        const k = 4, lw = Math.ceil(W / k), lh = Math.ceil(H / k);
        let L = this.videoLayer;
        if (!L || L.width !== lw || L.height !== lh) { L = this.videoLayer = document.createElement('canvas'); L.width = lw; L.height = lh; }
        const x = L.getContext('2d'), r = 1 + blur * 11; // up to ~48 px of blur at full size
        const g = 1 + (3 * r) / Math.min(lw, lh); // overdraw past the edges so the blur's transparent fringe stays outside the frame
        x.save(); x.filter = `blur(${r.toFixed(1)}px)`; x.imageSmoothingQuality = 'high';
        x.fillStyle = '#0a0a0c'; x.fillRect(0, 0, lw, lh);
        x.drawImage(img, lw / 2 - ((lw / 2 - dx / k) * g), lh / 2 - ((lh / 2 - dy / k) * g), (dw / k) * g, (dh / k) * g);
        x.restore();
        ctx.imageSmoothingQuality = 'high'; ctx.drawImage(L, 0, 0, W, H);
      } else { ctx.imageSmoothingQuality = 'high'; ctx.drawImage(img, dx, dy, dw, dh); }
    }
    const dim = clamp01(+look.dim || 0);
    if (dim > 0) { ctx.fillStyle = `rgba(0,0,0,${dim.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
    const grain = clamp01(look.grain == null ? 0.4 : +look.grain);
    if (grain > 0.005) {
      if (!this.grainTile) { this.grainTile = makeGrainTile(256); this.grainPattern = ctx.createPattern(this.grainTile, 'repeat'); }
      const ox = (frameIndex * 97) % 256, oy = (frameIndex * 61) % 256;
      ctx.save(); ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = grain * 0.3 * alpha;
      ctx.translate(-ox, -oy); ctx.fillStyle = this.grainPattern; ctx.fillRect(ox, oy, W, H); ctx.restore();
    }
  }
  draw(t, frameIndex = Math.floor(t * 60)) {
    const P = this.project, tl = this.timeline, songs = this.songs, n = songs.length;
    t = Math.max(0, t);
    this.layout = this.layoutFor(t);
    const { W, H, u, Wu, Hu, ctx } = this, L = this.layout, look = P.look;
    const i = n ? tl.indexAt(t) : 0;
    const cur = songs[i], prv = i > 0 ? songs[i - 1] : null;
    const since = n ? t - tl.changeAt[i] : 0;
    const pe = prv ? easeOutQuint(clamp01(since / TRANS)) : 1;
    const ph = prv ? easeInOutCubic(clamp01(since / SCROLL_TRANS)) : 1;
    const pp = prv ? easeInOutSine(clamp01(since / PAL_TRANS)) : 1;
    const intro = easeOutQuint(clamp01((t - 0.05) / 0.9));
    // extras arrive a beat after the main picture when the composition is balanced
    this.introSecondary = this.balanced ? easeOutQuint(clamp01((t - 0.5) / 0.9)) : intro;
    this.room = this.roomAt(t);
    const fadeIn = n ? easeOutCubic(clamp01(t / tl.fadeIn)) : 1;
    const fadeOut = n && tl.fadeOut > 0 ? 1 - easeInCubic(clamp01((t - (tl.total - tl.fadeOut)) / tl.fadeOut)) : 1;

    // background
    const palette = n ? (prv ? blendPalette(this.paletteOf(prv), this.paletteOf(cur), pp) : this.paletteOf(cur)) : DEFAULT_PALETTE;
    this.curPalette = palette;
    this.drawBackground(t, frameIndex, cur, prv, pp, palette);

    ctx.save();
    ctx.scale(u, u);
    ctx.textBaseline = 'alphabetic';
    if (!n) this.drawEmpty();
    else {
      if (this.viz && this.viz.place === 'behind') this.drawViz(t, true);
      this.drawArt(cur, prv, pe, intro, t);
      const seg = tl.segs[i];
      const flowPhase = look.marquee && t >= seg.start && t < seg.end ? t - seg.start - 2 : null;
      if (look.showNowPlaying !== false) this.drawText(cur, prv, pe, intro, flowPhase);
      if (look.showProgress !== false) this.drawProgress(t, i, intro);
      this.drawList(t, i, ph, intro, flowPhase);
      this.drawArrow(t, i, intro);
      if (this.dancers.length) this.drawDancers(t);
      if (this.viz && this.viz.place !== 'behind') this.drawViz(t, false);
      if (look.showNext) this.drawNext(t, i, intro * (1 - 0.25 * this.calm));
      if (look.showClock) this.drawClock(t, this.introSecondary * (1 - 0.3 * this.calm));
      if (since > 1.2 && songs[i + 1]) this.warm(songs[i + 1]);
    }
    if (this.logo) this.drawLogo(this.introSecondary);
    if (this.captions.length) this.drawCaptions(this.introSecondary);
    ctx.restore();
    const fade = fadeIn * fadeOut;
    if (fade < 0.999) { ctx.fillStyle = `rgba(0,0,0,${(1 - fade).toFixed(4)})`; ctx.fillRect(0, 0, W, H); }
  }

  drawEmpty() {
    const { ctx, Wu, Hu } = this, L = this.layout;
    ctx.save();
    ctx.globalAlpha = 0.5;
    roundRect(ctx, L.art.x, L.art.y, L.art.size, L.art.size, L.art.r); ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1; ctx.stroke();
    for (let k = 0; k < Math.min(5, L.list.slots); k++) {
      const y = L.list.rowsTop + k * L.list.pitch;
      roundRect(ctx, L.list.x, y, L.list.w, L.list.rowH, 16); ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fill();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = `500 26px ${this.font}`; ctx.textAlign = 'center';
    ctx.fillText('Add songs to see your video', Wu / 2, Hu / 2 + 9);
  }

  accentColor(alpha = 0.96) {
    if (this.project.look.accent === 'album' && this.curPalette) { const c = this.curPalette.accent; return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha})`; }
    return `rgba(255,255,255,${alpha})`;
  }
  drawArt(cur, prv, pe, intro, t = 0) {
    const { ctx } = this, A = this.layout.art;
    const cx = A.x + A.size / 2, cy = A.y + A.size / 2;
    const introScale = 0.965 + 0.035 * intro;
    if (this.project.look.glow && this.curPalette) { // a soft pool of the album's colour behind the artwork
      const c = this.curPalette.accent, rgb = `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}`;
      const g = ctx.createRadialGradient(cx, cy + A.size * 0.08, A.size * 0.15, cx, cy + A.size * 0.08, A.size * 0.95);
      g.addColorStop(0, `rgba(${rgb},${(0.55 * intro).toFixed(3)})`); g.addColorStop(0.55, `rgba(${rgb},${(0.18 * intro).toFixed(3)})`); g.addColorStop(1, `rgba(${rgb},0)`);
      ctx.fillStyle = g; ctx.fillRect(cx - A.size, cy - A.size * 0.9, A.size * 2, A.size * 2.1);
    }
    const sh = this.shadowLayer();
    const fit = A.size / sh.sizeU; // the layers are built once at the larger size and drawn at the size the layout has right now
    ctx.save(); ctx.globalAlpha = intro; ctx.translate(cx, cy); ctx.scale(introScale * fit, introScale * fit);
    const full = sh.sizeU + 2 * sh.padU;
    ctx.drawImage(sh.canvas, -full / 2, -full / 2, full, full);
    ctx.restore();
    const put = (song, alpha, scale) => {
      if (!song || !song.image || alpha <= 0.002) return;
      const lay = this.artLayer(song);
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(cx, cy); ctx.scale(scale, scale);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(lay.canvas, -A.size / 2, -A.size / 2, A.size, A.size);
      const spec = this.artSpecFor(song), vm = spec ? this.videoMeta(spec.id) : null;
      const vf = vm && vm.w > 0 && this.videoProvider ? this.videoProvider.frame(spec.id, this.videoTimeFor(spec, t).vt) : null;
      if (vf) { // the song's video where the artwork is, cropped to the square, under the same hairline
        const r = cornerRadius(this.project.look.corners || 'soft', A.size), s = Math.max(A.size / vm.w, A.size / vm.h), sw = A.size / s, sh = A.size / s;
        ctx.save(); roundRect(ctx, -A.size / 2, -A.size / 2, A.size, A.size, r); ctx.clip();
        ctx.drawImage(vf, (vm.w - sw) / 2, (vm.h - sh) / 2, sw, sh, -A.size / 2, -A.size / 2, A.size, A.size);
        ctx.restore();
        roundRect(ctx, -A.size / 2 + 0.5, -A.size / 2 + 0.5, A.size - 1, A.size - 1, Math.max(0, r - 0.5)); ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 1; ctx.stroke();
      }
      ctx.restore();
    };
    if (pe < 1) put(prv, 1 - pe, (1 - 0.03 * pe) * introScale);
    put(cur, Math.min(intro, pe), (1.03 - 0.03 * pe) * introScale);
  }

  drawText(cur, prv, pe, intro, flowPhase = null) {
    const { ctx } = this, T = this.layout.text, flow = !!this.project.look.marquee;
    const x0 = T.align === 'center' ? T.x - T.w / 2 : T.x;
    if (this.project.look.eyebrow && T.eyebrowY) { // a small label above the song title
      ctx.save(); ctx.globalAlpha = intro;
      ctx.font = `600 15px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '2.2px';
      ctx.fillStyle = this.accentColor(0.62 * (1 - 0.3 * this.calm)); ctx.textAlign = T.align; ctx.fillText('NOW PLAYING', T.x, T.eyebrowY);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.restore();
    }
    const put = (song, alpha, dy, phase) => {
      if (!song || alpha <= 0.002) return;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.font = `600 ${T.titleSize}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.6px';
      ctx.fillStyle = 'rgba(255,255,255,0.97)';
      if (flow) flowText(ctx, song.title || 'Untitled', x0, T.titleY + dy, T.w, phase, 'rgba(255,255,255,0.97)', T.align);
      else { ctx.textAlign = T.align; ctx.fillText(fitText(ctx, song.title || 'Untitled', T.w), T.x, T.titleY + dy); }
      ctx.font = `400 ${T.artistSize}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillStyle = 'rgba(255,255,255,0.62)';
      const sub = song.artist || (song.album || '');
      if (flow) flowText(ctx, sub, x0, T.artistY + dy, T.w, phase, 'rgba(255,255,255,0.62)', T.align);
      else { ctx.textAlign = T.align; ctx.fillText(fitText(ctx, sub, T.w), T.x, T.artistY + dy); }
      ctx.restore();
    };
    // the old title leaves before the new one arrives, so two titles never overlap
    const out = easeOutCubic(clamp01(pe / 0.45)), inn = easeOutCubic(clamp01((pe - 0.4) / 0.6));
    if (prv && out < 1) put(prv, 1 - out, -8 * out, null);
    put(cur, Math.min(intro, prv ? inn : 1), 8 * (1 - (prv ? inn : 1)) + 14 * (1 - intro), flowPhase);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }

  drawProgress(t, i, intro) {
    const { ctx } = this, Pg = this.layout.progress, seg = this.timeline.segs[i], song = this.songs[i], look = this.project.look;
    const el = clamp(t - seg.start, 0, seg.dur), frac = seg.dur > 0 ? el / seg.dur : 0;
    ctx.save(); ctx.globalAlpha = intro;
    if (look.progress === 'wave' && song.waveform && song.waveform.peaks && song.waveform.peaks.length) { // the song's own waveform, filled as it plays
      const peaks = song.waveform.peaks, full = song.waveform.duration || song.duration || 1;
      const t0 = trimStart(song) / full, t1 = (trimStart(song) + songLength(song)) / full;
      const barW = 4, gap = 2.5, bars = Math.max(8, Math.floor((Pg.w + gap) / (barW + gap))), pitch = (Pg.w - barW) / Math.max(1, bars - 1);
      let norm = 0.02; for (let b = Math.floor(t0 * peaks.length); b < Math.min(peaks.length, Math.ceil(t1 * peaks.length)); b++) norm = Math.max(norm, peaks[b]);
      const mid = Pg.y + Pg.h / 2;
      for (let k = 0; k < bars; k++) {
        const b0 = Math.floor((t0 + (t1 - t0) * (k / bars)) * peaks.length), b1 = Math.max(b0 + 1, Math.floor((t0 + (t1 - t0) * ((k + 1) / bars)) * peaks.length));
        let p = 0; for (let b = b0; b < b1 && b < peaks.length; b++) p = Math.max(p, peaks[b]);
        const h = Math.max(3, (p / norm) * Pg.h);
        const played = (k + 0.5) / bars <= frac;
        ctx.fillStyle = played ? this.accentColor(0.95) : 'rgba(255,255,255,0.22)';
        roundRect(ctx, Pg.x + k * pitch, mid - h / 2, barW, h, 1.5); ctx.fill();
      }
    } else {
      const y = Pg.y + (Pg.h - 4) / 2;
      roundRect(ctx, Pg.x, y, Pg.w, 4, 2); ctx.fillStyle = 'rgba(255,255,255,0.16)'; ctx.fill();
      if (frac > 0) { roundRect(ctx, Pg.x, y, Math.max(4, Pg.w * frac), 4, 2); ctx.fillStyle = this.accentColor(0.92); ctx.fill(); }
    }
    ctx.font = `500 18px ${this.font}`; if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    const mode = look.timeMode || 'elapsed', remaining = `−${formatTime(Math.max(0, seg.dur - el))}`;
    fillTabular(ctx, mode === 'remaining' ? remaining : formatTime(el), Pg.x, Pg.timesY + 6, 'left');
    fillTabular(ctx, mode === 'both' ? remaining : formatTime(seg.dur), Pg.x + Pg.w, Pg.timesY + 6, 'right');
    ctx.restore();
  }

  // "Up next" under the progress times: names the following track for the whole song, quietly, and brightens toward its end
  drawNext(t, i, intro) {
    const { ctx } = this, T = this.layout.text, tl = this.timeline, next = this.songs[i + 1];
    if (!next || !T.nextY) return;
    const seg = tl.segs[i];
    const arrive = easeOutCubic(clamp01((t - tl.changeAt[i] - 0.15) / 0.6)); // arrives with the song's title
    const near = easeInOutCubic(clamp01((t - (seg.end - Math.min(12, seg.dur * 0.5))) / 3)); // and steps forward near the end
    const a = arrive * intro;
    if (a <= 0.003) return;
    // a small label pill, then the next song's title and artist; both come forward as the song nears its end
    ctx.save(); ctx.globalAlpha = a; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const y = T.nextY, pillH = 26, padX = 10, gap = 12; // y is the line's visual centre: the pill is centred on it and the title's capitals straddle it
    const capOf = (font) => { ctx.font = font; const m = ctx.measureText('H'); return m.actualBoundingBoxAscent || parseFloat(font) * 0.72; };
    const titleFont = `600 24px ${this.font}`, artistFont = `400 20px ${this.font}`, labelFont = `700 13px ${this.font}`;
    const base = y + capOf(titleFont) / 2, labelBase = y + capOf(labelFont) / 2; // the title and artist share one baseline; the label sits centred in its pill
    ctx.font = `700 13px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '1.8px';
    const label = 'UP NEXT', lw = measure(ctx, label) + 2 * padX;
    ctx.font = `600 24px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.3px';
    const title = next.title || 'Untitled';
    ctx.font = `400 20px ${this.font}`;
    const artist = next.artist || '';
    const sep = artist ? '  ·  ' : '';
    const avail = T.w - lw - gap;
    ctx.font = `600 24px ${this.font}`; let tTitle = fitText(ctx, title, avail);
    const tw = measure(ctx, tTitle);
    ctx.font = `400 20px ${this.font}`; const tArtist = artist ? fitText(ctx, sep + artist, Math.max(0, avail - tw)) : '';
    const aw = tArtist ? measure(ctx, tArtist) : 0;
    const total = lw + gap + tw + aw;
    const start = T.align === 'center' ? T.x - total / 2 : T.x;
    // the pill: the album's colour (or white) at a soft strength, text in the same colour
    const c = this.project.look.accent === 'album' && this.curPalette ? this.curPalette.accent : null;
    const rgb = c ? `${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)}` : '255,255,255';
    roundRect(ctx, start, y - pillH / 2, lw, pillH, pillH / 2);
    ctx.fillStyle = `rgba(${rgb},${(0.14 + 0.1 * near).toFixed(3)})`; ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},${(0.22 + 0.2 * near).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
    ctx.font = labelFont; if ('letterSpacing' in ctx) ctx.letterSpacing = '1.8px';
    ctx.fillStyle = `rgba(${rgb},${(0.85 + 0.15 * near).toFixed(3)})`; ctx.fillText(label, start + padX, labelBase);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.3px';
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8 * this.u; ctx.shadowOffsetY = 1 * this.u; // legible over a video or bright art
    ctx.font = titleFont; ctx.fillStyle = `rgba(255,255,255,${(0.8 + 0.2 * near).toFixed(3)})`; ctx.fillText(tTitle, start + lw + gap, base);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    if (tArtist) { ctx.font = artistFont; ctx.fillStyle = `rgba(255,255,255,${(0.55 + 0.2 * near).toFixed(3)})`; ctx.fillText(tArtist, start + lw + gap + tw, base); }
    ctx.restore();
  }

  // the whole mix's clock in a corner: elapsed / total
  drawClock(t, intro) {
    const { ctx, Wu, Hu } = this, tl = this.timeline, M = this.layout.M;
    // a corner the logo and a visualizer strip are not using: top right first, then bottom right, top left, bottom left
    const vizEdge = this.viz && (this.viz.place === 'top' || this.viz.place === 'bottom') ? this.viz.place : null;
    const logoCorner = this.logo && this.logo.place !== 'custom' ? this.logo.place : null;
    const corner = ['top-right', 'bottom-right', 'top-left', 'bottom-left'].find((c) => c !== logoCorner && !(vizEdge && c.startsWith(vizEdge))) || 'top-right';
    const right = corner.endsWith('right'), top = corner.startsWith('top');
    ctx.save(); ctx.globalAlpha = intro;
    ctx.font = `500 20px ${this.font}`; if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    const text = `${formatTime(Math.min(t, tl.total), { forceHours: tl.total >= 3600 })} / ${formatTime(tl.total, { forceHours: tl.total >= 3600 })}`;
    fillTabular(ctx, text, right ? Wu - M * 0.45 : M * 0.45, top ? 46 : Hu - 28, right ? 'right' : 'left');
    ctx.restore();
  }

  // a logo or watermark: in a corner, or wherever it was dragged
  logoBoxFor() {
    const lg = this.logo, { Wu, Hu } = this, M = this.layout.M, img = lg.image;
    const iw = img.naturalWidth || img.width || 1, ih = img.naturalHeight || img.height || 1;
    const h = Math.round(clamp(+lg.size || 0.08, 0.03, 0.4) * 1080 * (1 - 0.15 * this.calm)), w = h * (iw / ih);
    const inset = M * 0.45, place = lg.place || 'top-right';
    let x, y;
    if (place === 'custom') { x = clamp((+lg.x || 0.5) * Wu - w / 2, 0, Wu - w); y = clamp((+lg.y || 0.5) * Hu - h / 2, 0, Hu - h); }
    else { x = place.endsWith('left') ? inset : Wu - inset - w; y = place.startsWith('top') ? 40 : Hu - 40 - h; }
    return { x, y, w, h };
  }
  drawLogo(intro) {
    const { ctx } = this, lg = this.logo, box = this.logoBoxFor();
    this.logoBox = box;
    const op = clamp(+lg.opacity == null ? 0.9 : +lg.opacity, 0.05, 1);
    ctx.save(); ctx.globalAlpha = intro * (this.balanced ? Math.min(op, 0.9 - 0.35 * this.calm) : op);
    ctx.imageSmoothingQuality = 'high';
    ctx.shadowColor = 'rgba(0,0,0,0.35)'; ctx.shadowBlur = 8 * this.u; ctx.shadowOffsetY = 1 * this.u;
    ctx.drawImage(lg.image, box.x, box.y, box.w, box.h);
    ctx.restore();
  }
  // the parts of the frame that carry something: artwork column, list, visualizer, dancers, logo, captions
  busyRects(exceptCaption = -1) {
    const L = this.layout, out = [];
    if (!L) return out;
    const colBottom = Math.max(L.text.nextY || 0, L.progress.timesY + 10, L.art.y + L.art.size);
    out.push({ x: L.art.x, y: L.art.y, w: L.art.size, h: colBottom - L.art.y });
    out.push({ x: L.list.x - 50, y: L.list.top, w: L.list.w + 50, h: L.list.bottom - L.list.top });
    if (this.viz && L.viz && this.viz.place !== 'behind') out.push(L.viz);
    for (const b of this.dancerBoxes || []) if (b) out.push(b);
    if (this.logoBox) out.push(this.logoBox);
    (this.captionBoxes || []).forEach((b, k) => { if (b && k !== exceptCaption) out.push(b); });
    return out;
  }
  isBusyUnder(box) {
    const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const idx = (this.captionBoxes || []).indexOf(box);
    return this.busyRects(idx).some((r) => inter(box, r) > box.w * box.h * 0.08);
  }
  // the emptiest place for a box of that size (unit space), as frame fractions of its centre; `candidates` are centres to try
  freeSpot(wU, hU, candidates = null) {
    const { Wu, Hu } = this, L = this.layout, M = L ? L.M : Math.round(Math.min(Wu, Hu) * 0.111);
    const inter = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    const busy = this.busyRects();
    const spots = candidates || (() => { const o = []; for (let iy = 0; iy <= 6; iy++) for (let ix = 0; ix <= 8; ix++) o.push([M + wU / 2 + (Wu - 2 * M - wU) * (ix / 8), M * 0.4 + hU / 2 + (Hu - M * 0.8 - hU) * (iy / 6)]); return o; })();
    let best = null;
    for (const [cx, cy] of spots) {
      const box = { x: cx - wU / 2, y: cy - hU / 2, w: wU, h: hU };
      let overlap = 0; for (const r of busy) overlap += inter(box, r);
      const score = overlap / (wU * hU) + 0.08 * (Math.abs(cy / Hu - 0.9) + 0.5 * Math.abs(cx / Wu - 0.5)); // free first; then low and centred
      if (!best || score < best.score) best = { score, x: cx / Wu, y: cy / Hu, overlap: overlap / (wU * hU) };
    }
    return best;
  }
  // free captions: any text, anywhere, in the mix's typeface
  drawCaptions(intro) {
    const { ctx, Wu, Hu } = this;
    this.captionBoxes = [];
    this.captions.forEach((c, k) => {
      const size = Math.round(clamp(+c.size || 0.032, 0.012, 0.2) * 1080);
      ctx.save(); ctx.globalAlpha = intro * clamp(+c.opacity == null ? 0.92 : +c.opacity, 0.05, 1);
      ctx.font = `${c.bold ? 700 : 500} ${size}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = c.bold ? '-0.3px' : '0px';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const text = c.text || ' ', w = Math.min(Wu * 0.96, measure(ctx, text)), h = size * 1.25;
      const cx = clamp((+c.x || 0.5) * Wu, w / 2, Wu - w / 2), cy = clamp((+c.y || 0.9) * Hu, h / 2, Hu - h / 2);
      const box = { x: cx - w / 2, y: cy - h / 2, w: Math.max(w, 40), h };
      this.captionBoxes[k] = box;
      const op = clamp(+c.opacity == null ? 0.92 : +c.opacity, 0.05, 1);
      ctx.globalAlpha = intro * (this.balanced ? Math.min(op, 0.95 - 0.3 * this.calm) : op);
      if (this.balanced && this.isBusyUnder(box)) { // a soft backing keeps the words readable over artwork, rows or bars
        const px = size * 0.55, py = size * 0.3, r = Math.min(size * 0.5, (h + 2 * py) / 2);
        roundRect(ctx, box.x - px, box.y - py, box.w + 2 * px, box.h + 2 * py, r);
        ctx.fillStyle = 'rgba(8,8,10,0.46)'; ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.stroke();
      } else { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8 * this.u; ctx.shadowOffsetY = 1 * this.u; }
      ctx.fillStyle = c.color === 'album' ? this.accentColor(1) : 'rgba(255,255,255,1)';
      ctx.fillText(fitText(ctx, text, Wu * 0.96), cx, cy);
      ctx.restore();
    });
    ctx.textBaseline = 'alphabetic';
  }

  scrollRows(index) {
    const { slots } = this.layout.list, n = this.songs.length;
    const anchor = Math.max(0, Math.min(2, Math.floor((slots - 1) / 2)));
    return clamp(index - anchor, 0, Math.max(0, n - slots));
  }
  scrollOffset(t, i) {
    const { pitch } = this.layout.list;
    const target = this.scrollRows(i) * pitch;
    if (i === 0) return target;
    const from = this.scrollRows(i - 1) * pitch;
    return lerp(from, target, easeInOutCubic(clamp01((t - this.timeline.changeAt[i]) / SCROLL_TRANS)));
  }

  drawList(t, i, pe, intro, flowPhase = null) {
    const ctx = this.ctx; const Ls = this.layout.list, P = this.project, look = P.look, songs = this.songs, n = songs.length;
    const off = this.scrollOffset(t, i);
    // header
    ctx.save(); ctx.globalAlpha = intro; ctx.textAlign = 'left';
    const title = this.headerTitle, metaText = this.headerMeta;
    if (title) {
      ctx.font = `600 30px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.3px';
      ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fillText(fitText(ctx, title, Ls.w - (this.titleReserve || 0)), Ls.x, Ls.top + 30);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      if (metaText) { ctx.font = `400 20px ${this.font}`; ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillText(fitText(ctx, metaText, Ls.w), Ls.x, Ls.top + 30 + 32); }
    } else if (metaText) {
      ctx.font = `500 22px ${this.font}`; ctx.fillStyle = 'rgba(255,255,255,0.55)'; ctx.fillText(fitText(ctx, metaText, Ls.w), Ls.x, Ls.top + 24);
    }
    ctx.restore();
    // rows: clipped to the rows region; a row fades only by how far it has slid outside that region, so settled rows are never touched
    ctx.save();
    ctx.beginPath(); ctx.rect(Ls.x - 6, Ls.rowsTop, Ls.w + 12, Ls.bottom - Ls.rowsTop); ctx.clip();
    ctx.textBaseline = 'middle';
    if ('fontVariantNumeric' in ctx) ctx.fontVariantNumeric = 'tabular-nums';
    const first = Math.max(0, Math.floor(off / Ls.pitch) - 1), last = Math.min(n - 1, Math.ceil((off + Ls.bottom - Ls.rowsTop) / Ls.pitch) + 1);
    const RS = ROW_STYLES[look.density] || ROW_STYLES.comfortable;
    const rowStyle = look.rows || 'boxes', boxR = { sharp: 8, soft: 18, round: 26 }[look.corners || 'soft'] || 18;
    const idxW = look.showIndex ? RS.idxW : 0, pad = RS.pad, thumb = RS.thumb, thumbW = look.showThumbs ? thumb + 16 : 0;
    for (let j = first; j <= last; j++) {
      const s = songs[j];
      let y = Ls.rowsTop + j * Ls.pitch - off;
      const slot = j - Math.round(off / Ls.pitch);
      const ri = easeOutQuint(clamp01((t - 0.12 - Math.max(0, slot) * 0.045) / 0.6));
      y += (1 - ri) * 16;
      if (y + Ls.rowH <= Ls.rowsTop || y >= Ls.bottom) continue;
      const overflow = Math.max(0, Ls.rowsTop - y, y + Ls.rowH - Ls.bottom);
      const alpha = ri * clamp01(1 - overflow / Ls.pitch);
      if (alpha <= 0.003) continue;
      const h = j === i ? pe : j === i - 1 ? 1 - pe : 0;
      ctx.globalAlpha = alpha;
      if (rowStyle === 'boxes') {
        roundRect(ctx, Ls.x, y, Ls.w, Ls.rowH, boxR);
        ctx.fillStyle = `rgba(255,255,255,${(0.06 + 0.085 * h).toFixed(3)})`; ctx.fill();
        roundRect(ctx, Ls.x + 0.5, y + 0.5, Ls.w - 1, Ls.rowH - 1, Math.max(0, boxR - 0.5));
        ctx.strokeStyle = `rgba(255,255,255,${(0.08 + 0.12 * h).toFixed(3)})`; ctx.lineWidth = 1; ctx.stroke();
        if (h > 0.01) { // a hairline of light along the top edge of the playing row, the way glass catches it
          ctx.save(); roundRect(ctx, Ls.x + 1, y + 1, Ls.w - 2, Ls.rowH - 2, Math.max(0, boxR - 1)); ctx.clip();
          const gl = ctx.createLinearGradient(0, y, 0, y + 10); gl.addColorStop(0, `rgba(255,255,255,${(0.1 * h).toFixed(3)})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
          ctx.fillStyle = gl; ctx.fillRect(Ls.x, y, Ls.w, 10); ctx.restore();
        }
      } else {
        if (h > 0.002) { roundRect(ctx, Ls.x, y, Ls.w, Ls.rowH, Math.min(boxR, 12)); ctx.fillStyle = `rgba(255,255,255,${(0.075 * h).toFixed(3)})`; ctx.fill(); }
        if (rowStyle === 'lines' && j < n - 1) { ctx.fillStyle = 'rgba(255,255,255,0.11)'; ctx.fillRect(Ls.x + pad, y + Ls.rowH + Ls.rowGap / 2 - 0.5, Ls.w - 2 * pad, 1); }
      }
      const quiet = rowStyle !== 'boxes'; // without boxes the playing row is told apart by brighter type
      let x = Ls.x + pad + 8;
      const cy = y + Ls.rowH / 2;
      if (look.showIndex) {
        ctx.font = `500 ${RS.idxFont}px ${this.font}`;
        ctx.fillStyle = `rgba(255,255,255,${(quiet ? 0.32 + 0.4 * h : 0.38 + 0.3 * h).toFixed(3)})`; ctx.textAlign = 'right';
        ctx.fillText(String(j + 1), x + 26, cy + 1);
        x += idxW;
      }
      if (look.showThumbs) {
        if (s.image) { const th = this.thumbLayer(s); ctx.drawImage(th.canvas, x, y + pad, thumb, thumb); }
        x += thumbW;
      }
      x += 4;
      let right = Ls.x + Ls.w - pad - 10;
      if (look.showDurations) {
        ctx.font = `500 ${RS.dur}px ${this.font}`;
        ctx.fillStyle = `rgba(255,255,255,${(quiet ? 0.36 + 0.3 * h : 0.42 + 0.2 * h).toFixed(3)})`; ctx.textAlign = 'right';
        const dt = formatTime(songLength(s));
        right -= fillTabular(ctx, dt, right, cy + 1, 'right') + 22;
      }
      const textW = right - x;
      ctx.textAlign = 'left';
      ctx.font = `600 ${RS.title}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.2px';
      const titleCol = `rgba(255,255,255,${(quiet ? 0.7 + 0.3 * h : 0.8 + 0.2 * h).toFixed(3)})`;
      ctx.fillStyle = titleCol;
      const sub = s.artist || s.album || '';
      const flowing = j === i && !!look.marquee; // only the playing song's row scrolls
      const line = (text, tx, ty, col) => { if (flowing) flowText(ctx, text, tx, ty, textW, flowPhase, col); else ctx.fillText(fitText(ctx, text, textW), tx, ty); };
      if (sub) {
        line(s.title || 'Untitled', x, cy + RS.titleDy, titleCol);
        ctx.font = `400 ${RS.sub}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
        const subCol = `rgba(255,255,255,${(quiet ? 0.42 + 0.25 * h : 0.5 + 0.15 * h).toFixed(3)})`;
        ctx.fillStyle = subCol;
        line(sub, x, cy + RS.subDy, subCol);
      } else {
        line(s.title || 'Untitled', x, cy + 1, titleCol);
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    ctx.restore();
    ctx.textBaseline = 'alphabetic';
  }

  drawArrow(t, i, intro) {
    const { ctx } = this, Ls = this.layout.list, tl = this.timeline;
    const center = (k) => Ls.rowsTop + k * Ls.pitch + Ls.rowH / 2;
    // interpolate between the settled on-screen positions: when the list scrolls by exactly one row the marker stays put
    const yTo = center(i) - this.scrollRows(i) * Ls.pitch;
    let y = yTo;
    if (i > 0) {
      const yFrom = center(i - 1) - this.scrollRows(i - 1) * Ls.pitch;
      y = lerp(yFrom, yTo, easeInOutCubic(clamp01((t - tl.changeAt[i]) / SCROLL_TRANS)));
    }
    const a = easeOutQuint(clamp01((t - 0.35) / 0.6));
    if (a <= 0.003) return;
    const x = this.layout.arrow.x;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.translate(x, y);
    ctx.translate(-(1 - a) * 10, 0);
    ctx.strokeStyle = this.accentColor(0.96); ctx.fillStyle = this.accentColor(0.96); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (this.project.look.marker === 'triangle') {
      // a play-style triangle; the round-joined stroke softens its corners to match the arrow's caps
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-7.5, -10); ctx.lineTo(10, 0); ctx.lineTo(-7.5, 10); ctx.closePath();
      ctx.fill(); ctx.stroke();
    } else {
      ctx.lineWidth = 3.4;
      ctx.beginPath(); ctx.moveTo(-13, 0); ctx.lineTo(12, 0); ctx.moveTo(3, -9); ctx.lineTo(12, 0); ctx.lineTo(3, 9); ctx.stroke();
    }
    ctx.restore();
  }

  // a dancer standing next to the mix title: sized to the header, placed after the title's text
  titleBox(k, d) {
    const { ctx } = this, Ls = this.layout.list, m = d.sprite.meta;
    if (!this.headerTitle) return null;
    ctx.font = `600 30px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '-0.3px';
    const tw = measure(ctx, fitText(ctx, this.headerTitle, Ls.w - (this.titleReserve || 0)));
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    const h = Math.min(Math.round(clamp(+d.size || DANCE_SIZE.def, DANCE_SIZE.min, DANCE_SIZE.max) * 1080), 64), w = h * (m.cell.w / m.cell.h);
    let x = Ls.x + tw + 18;
    const prev = this.dancers.slice(0, k).filter((o) => this.layout.dancers[this.dancers.indexOf(o)] == null);
    for (const o of prev) { const om = o.sprite.meta; x += Math.min(Math.round(clamp(+o.size || DANCE_SIZE.def, DANCE_SIZE.min, DANCE_SIZE.max) * 1080), 64) * (om.cell.w / om.cell.h) + 14; }
    x = Math.min(x, Ls.x + Ls.w - w);
    return { x, y: Ls.top + 36, w, h, place: 'by-title' };
  }

  // Band levels (0..1) at time t for the visualizer, read from the playing song's precomputed spectrum with linear
  // interpolation between its 60 Hz frames, a short envelope at the song's edges and the Level setting.
  spectrumAt(t) {
    const tl = this.timeline, i = tl.songAtAudioTime(t);
    const song = i >= 0 ? this.songs[i] : null, sp = song && song.spectrum;
    const bands = sp && sp.bands ? sp.bands : 32;
    if (!this.vizVals || this.vizVals.length !== bands) this.vizVals = new Float32Array(bands);
    const out = this.vizVals;
    out.fill(0);
    if (i < 0) return out;
    const level = clamp(+this.viz.level || 1, 0.25, 4);
    // the levels of one song at t, added into `out` with weight w (two songs add up inside a crossfade)
    const add = (k, w) => {
      const s = this.songs[k], spec = s && s.spectrum, seg = tl.segs[k];
      if (!spec || !spec.frames || !(spec.bands === bands) || w <= 0.001) return;
      const f = (trimStart(s) + (t - seg.start)) * spec.rate;
      const i0 = Math.min(spec.frames - 1, Math.max(0, Math.floor(f))), i1 = Math.min(spec.frames - 1, i0 + 1), fr = clamp01(f - i0);
      const env = clamp01(Math.min(1, (t - seg.start) / 0.25, (seg.end - t) / 0.25));
      const gain = level * env * w;
      for (let b = 0; b < bands; b++) { const x = spec.data[i0 * bands + b], y = spec.data[i1 * bands + b]; out[b] = clamp01(out[b] + ((x + (y - x) * fr) / 255) * gain); }
    };
    const seg = tl.segs[i];
    if (seg.overlap > 0 && t < seg.start + seg.overlap && i > 0) { // crossfading: the outgoing song still sounds
      const u = clamp01((t - seg.start) / seg.overlap);
      add(i - 1, Math.cos(u * Math.PI / 2)); add(i, Math.sin(u * Math.PI / 2));
    } else add(i, 1);
    return out;
  }
  vizRgb(f) {
    const viz = this.viz;
    if (viz.color === 'spectrum') return spectrumColor(f);
    if (viz.color === 'album' && this.curPalette) return this.curPalette.accent.map((v) => Math.round(v * 255));
    return [255, 255, 255];
  }
  drawViz(t, behind) {
    const viz = this.viz, box = this.layout.viz, { ctx } = this;
    if (!viz || !box || !(box.w > 8) || !(box.h > 8)) return;
    const vals = this.spectrumAt(t), n = vals.length, regions = spectrumRegions(n);
    const style = viz.style === 'bands' || viz.style === 'wave' ? viz.style : 'bars';
    const labels = viz.labels !== false && !behind && style !== 'bands' && box.h >= 48;
    const labelH = labels ? vizLabelH(viz.labelSize) : 0;
    const x0 = box.x, w = box.w, H = box.h - labelH, bottom = box.y + H;
    const am = (behind ? 0.42 : 1) * (this.balanced ? (1 - 0.25 * this.calm) * (1 - 0.35 * (this.room || 0)) : 1);
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${(a * am).toFixed(3)})`;
    ctx.save();
    if (viz.place === 'on-art') { // a scrim so the bars read over bright artwork
      const A = this.layout.art;
      ctx.save(); roundRect(ctx, A.x, A.y, A.size, A.size, A.r); ctx.clip();
      const g = ctx.createLinearGradient(0, box.y - 70, 0, A.y + A.size);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.66)');
      ctx.fillStyle = g; ctx.fillRect(A.x, box.y - 70, A.size, A.y + A.size - (box.y - 70));
      ctx.restore();
    }
    if (style === 'bars') {
      let step = 1, count = n;
      if ((w / n) * 0.68 < 3) { step = 2; count = Math.ceil(n / 2); }
      const pitch = w / count, barW = Math.max(1.5, pitch * 0.68), r = Math.min(barW / 2, 4);
      const mid = bottom - H / 2;
      if (!viz.mirror) { ctx.fillStyle = rgba([255, 255, 255], 0.16); ctx.fillRect(x0, bottom - 1, w, 1); }
      let lastKey = null, grad = null;
      for (let c = 0; c < count; c++) {
        let v = 0; for (let k = c * step; k < Math.min(n, (c + 1) * step); k++) v = Math.max(v, vals[k]);
        const col = this.vizRgb((c * step) / Math.max(1, n - 1)), key = col.join();
        if (key !== lastKey) { grad = ctx.createLinearGradient(0, bottom - H, 0, bottom); grad.addColorStop(0, rgba(col, 0.96)); grad.addColorStop(1, rgba(col, 0.48)); lastKey = key; }
        ctx.fillStyle = grad;
        const bh = Math.max(2, v * H), bx = x0 + c * pitch + (pitch - barW) / 2;
        if (viz.mirror) roundRect(ctx, bx, mid - bh / 2, barW, bh, r); else roundRect(ctx, bx, bottom - bh, barW, bh, r);
        ctx.fill();
      }
    } else if (style === 'wave') {
      const pts = [];
      for (let k = 0; k < n; k++) pts.push([x0 + ((k + 0.5) * w) / n, vals[k] * H]);
      const col = this.vizRgb(0.5);
      const trace = (sign, base) => { // Catmull-Rom through the points, as cubic Béziers
        ctx.moveTo(x0, base - sign * pts[0][1] * 0.5);
        for (let k = 0; k < n - 1; k++) {
          const p0 = pts[Math.max(0, k - 1)], p1 = pts[k], p2 = pts[k + 1], p3 = pts[Math.min(n - 1, k + 2)];
          ctx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, base - sign * (p1[1] + (p2[1] - p0[1]) / 6), p2[0] - (p3[0] - p1[0]) / 6, base - sign * (p2[1] - (p3[1] - p1[1]) / 6), p2[0], base - sign * p2[1]);
        }
        ctx.lineTo(x0 + w, base - sign * pts[n - 1][1] * 0.5);
      };
      const draw = (sign, base) => {
        ctx.beginPath(); trace(sign, base); ctx.lineTo(x0 + w, base); ctx.lineTo(x0, base); ctx.closePath();
        const g = ctx.createLinearGradient(0, base - sign * H, 0, base);
        g.addColorStop(0, rgba(col, 0.5)); g.addColorStop(1, rgba(col, 0.04));
        ctx.fillStyle = g; ctx.fill();
        ctx.beginPath(); trace(sign, base); ctx.strokeStyle = rgba(col, 0.92); ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke();
      };
      if (viz.mirror) { const mid = bottom - H / 2; for (const p of pts) p[1] *= 0.5; draw(1, mid); draw(-1, mid); }
      else draw(1, bottom);
    } else { // three meters: low, mid, high
      const vals3 = regions.map((rg) => { let s = 0, c = 0; for (let k = rg.from; k < rg.to; k++) { s += vals[k]; c++; } return c ? clamp01(Math.pow(s / c, 0.85) * 1.15) : 0; });
      const horizontal = w / box.h > 2.2;
      ctx.textBaseline = 'middle';
      if (horizontal) {
        const gapY = Math.max(6, box.h * 0.08), rowH = (box.h - 2 * gapY) / 3, labelW = Math.min(80, w * 0.16), fs = Math.round(clamp(rowH * 0.42, 11, 18));
        ctx.font = `600 ${fs}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
        regions.forEach((rg, i) => {
          const y = box.y + i * (rowH + gapY), th = Math.max(4, rowH * 0.42), ty = y + (rowH - th) / 2, col = this.vizRgb(i / 2);
          ctx.fillStyle = rgba([255, 255, 255, 1], 0.55); ctx.textAlign = 'left'; ctx.fillText(rg.name, x0, y + rowH / 2);
          roundRect(ctx, x0 + labelW, ty, w - labelW, th, th / 2); ctx.fillStyle = rgba([255, 255, 255], 0.12); ctx.fill();
          const fw = Math.max(th, (w - labelW) * vals3[i]);
          const g = ctx.createLinearGradient(x0 + labelW, 0, x0 + w, 0); g.addColorStop(0, rgba(col, 0.55)); g.addColorStop(1, rgba(col, 0.96));
          roundRect(ctx, x0 + labelW, ty, fw, th, th / 2); ctx.fillStyle = g; ctx.fill();
        });
      } else {
        const gapX = Math.max(8, w * 0.06), colW = (w - 2 * gapX) / 3, lh = Math.min(26, box.h * 0.2), Hc = box.h - lh, fs = Math.round(clamp(lh * 0.6, 11, 18));
        ctx.font = `600 ${fs}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = '1.2px';
        regions.forEach((rg, i) => {
          const x = x0 + i * (colW + gapX), col = this.vizRgb(i / 2), inner = Math.min(colW, Math.max(12, colW * 0.6)), bx = x + (colW - inner) / 2;
          roundRect(ctx, bx, box.y, inner, Hc, Math.min(inner / 2, 8)); ctx.fillStyle = rgba([255, 255, 255], 0.1); ctx.fill();
          const fh = Math.max(inner / 2, Hc * vals3[i]);
          const g = ctx.createLinearGradient(0, box.y, 0, box.y + Hc); g.addColorStop(0, rgba(col, 0.96)); g.addColorStop(1, rgba(col, 0.5));
          roundRect(ctx, bx, box.y + Hc - fh, inner, fh, Math.min(inner / 2, 8)); ctx.fillStyle = g; ctx.fill();
          ctx.fillStyle = rgba([255, 255, 255], 0.55); ctx.textAlign = 'center'; ctx.fillText(rg.name, x + colW / 2, box.y + Hc + lh / 2 + 1);
        });
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.textBaseline = 'alphabetic';
    }
    const guides = viz.guides !== false && !behind && style !== 'bands'; // faint lines where low, mid and high meet
    if (guides) {
      for (const rg of regions.slice(1)) {
        const gx = x0 + (rg.from / n) * w;
        ctx.fillStyle = rgba([255, 255, 255], 0.1); ctx.fillRect(gx - 0.5, bottom - H, 1, H);
        if (labels) { ctx.fillStyle = rgba([255, 255, 255], 0.3); ctx.fillRect(gx - 0.5, bottom + 5, 1, labelH - 12); }
      }
    }
    if (labels) { // Low · Mid · High captions under the display
      const large = viz.labelSize !== 'small', fs = large ? 19 : 14;
      ctx.save();
      ctx.font = `600 ${fs}px ${this.font}`; if ('letterSpacing' in ctx) ctx.letterSpacing = large ? '2.5px' : '1.8px';
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = 'rgba(0,0,0,0.55)'; ctx.shadowBlur = 6 * this.u; ctx.shadowOffsetY = 1 * this.u;
      ctx.fillStyle = rgba([255, 255, 255], large ? 0.8 : 0.68);
      const baseline = bottom + labelH - (large ? 9 : 7);
      for (const rg of regions) { if (rg.to > rg.from) ctx.fillText(rg.name, x0 + ((rg.from + rg.to) / 2 / n) * w, baseline); }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.restore();
    }
    ctx.restore();
  }

  // Loop phase of an in-step dancer at mix time t on song i's tracked beats, or null when that song has no usable
  // grid (not analysed yet, or no steady pulse). The loop spans a whole number of beats, the sprite's accent frame
  // lands on the beat, and the grid extends past the song's ends so a gap keeps the step; at a song change the
  // phase eases from the previous grid to the new one.
  stepPhase(d, i, t, nativeLoop) {
    const tl = this.timeline;
    const grid = (k) => {
      const s = this.songs[k], a = s && s.analysis;
      if (!a || !(a.bpm > 0) || !Array.isArray(a.beats) || a.beats.length < 4 || !((+a.beatConf || 0) >= 0.12)) return null;
      const B = beatsPerLoop(nativeLoop, 60 / a.bpm);
      const p = beatProgress(a.beats, trimStart(s) + (t - tl.segs[k].start)) / B + accentPhase(d.sprite, B);
      return ((p % 1) + 1) % 1;
    };
    // around each song change a window, mostly inside the silence before the song when there is one, eases the
    // phase from the previous song's grid to the new one; the window can start while the previous song's grid still applies
    const win = (k) => { const to = tl.changeAt[k] + STEP_XF; return [to - STEP_XF - Math.min(1, Math.max(0, tl.gap - 0.5)), to]; };
    const j = i + 1 < tl.segs.length && t >= win(i + 1)[0] ? i + 1 : i;
    if (j > 0) {
      const [from, to] = win(j);
      if (t >= from && t < to) { const prev = grid(j - 1), cur = grid(j); if (prev != null && cur != null) return lerpPhase(prev, cur, easeInOutCubic((t - from) / (to - from))); }
    }
    return grid(i);
  }

  // Sprites drawn for time t: appear with a little bounce when their first song starts, leave before its run ends,
  // and step through their frames either on the song's beat or at the loop's own pace. Pure in t, like everything else.
  drawDancers(t) {
    const D = this.dancers, tl = this.timeline, { ctx, u } = this;
    this.dancerBoxes = D.map((d, k) => { const b = this.layout.dancers[k] || this.titleBox(k, d); return b ? { x: b.x, y: b.y - b.h, w: b.w, h: b.h } : null; }); // top-left boxes, for the editor's hit test
    const run = this.danceRuns.find((r) => t >= r.start && t < r.end);
    if (!run) return;
    const inA = clamp01((t - run.start) / 0.55), outA = clamp01((run.end - t) / 0.45);
    const scale = easeOutBack(inA) * (0.75 + 0.25 * easeOutCubic(outA));
    const alpha = easeOutCubic(clamp01(inA * 2)) * easeOutCubic(outA);
    if (alpha <= 0.003) return;
    const si = tl.songAtAudioTime(t), song = si >= 0 ? this.songs[si] : null;
    const bpm = song && song.analysis && song.analysis.bpm > 0 ? song.analysis.bpm : 0;
    const songStart = si >= 0 ? tl.segs[si].start : run.start;
    const gi = si >= 0 ? si : tl.indexAt(t); // the song whose beat grid in-step dancers follow, also through a gap
    for (let k = 0; k < D.length; k++) {
      const d = D[k], m = d.sprite.meta, img = d.sprite.image;
      const box = this.layout.dancers[k] || this.titleBox(k, d);
      if (!box || !(box.w > 1) || !(box.h > 1)) continue;
      // which frame: in step with the tracked beats, the loop locked to the nearest number of beats at the average
      // tempo, or its natural length times the speed setting
      const nativeLoop = Math.max(0.05, m.loop / 1000);
      let phase = d.tempo === 'instep' ? this.stepPhase(d, gi, t, nativeLoop) : null;
      if (phase == null) {
        let loopDur, elapsed;
        if (d.tempo !== 'natural' && bpm) { loopDur = beatsPerLoop(nativeLoop, 60 / bpm) * (60 / bpm); elapsed = t - songStart; }
        else { loopDur = nativeLoop / clamp(+d.speed || 1, 0.25, 4); elapsed = t - run.start; }
        phase = (((elapsed % loopDur) + loopDur) % loopDur) / loopDur;
      }
      const fi = frameAtPhase(m, phase);
      const sx = (fi % m.cols) * m.cell.w, sy = Math.floor(fi / m.cols) * m.cell.h;
      let w = box.w, h = box.h, cx = box.x + box.w / 2, fy = box.y;
      if (m.crisp) { // pixel art: whole device pixels per source pixel, on whole-pixel positions, so every pixel stays the same size
        const k2 = Math.max(1, Math.round((h * u) / m.cell.h));
        h = (k2 * m.cell.h) / u; w = (k2 * m.cell.w) / u;
        cx = Math.round(cx * u) / u; fy = Math.round(fy * u) / u;
      }
      this.dancerBoxes[k] = { x: cx - w / 2, y: fy - h, w, h };
      // over the artwork or the list the sprite gets a stage: a soft pool of shade behind it and a dark halo around it
      const A = this.layout.art, Ls = this.layout.list;
      const hits = (r) => cx - w / 2 < r.x + r.w && cx + w / 2 > r.x && fy - h < r.y + r.h && fy > r.y;
      const overArt = hits({ x: A.x, y: A.y, w: A.size, h: A.size }), overList = hits({ x: Ls.x, y: Ls.top, w: Ls.w, h: Ls.bottom - Ls.top });
      if (overArt && alpha > 0.01) {
        ctx.save(); ctx.globalAlpha = alpha; roundRect(ctx, A.x, A.y, A.size, A.size, A.r); ctx.clip();
        const rad = Math.max(w, h) * 0.9, g = ctx.createRadialGradient(cx, fy - h * 0.45, 0, cx, fy - h * 0.45, rad);
        g.addColorStop(0, 'rgba(0,0,0,0.5)'); g.addColorStop(0.55, 'rgba(0,0,0,0.26)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g; ctx.fillRect(cx - rad, fy - h * 0.45 - rad, rad * 2, rad * 2); ctx.restore();
      }
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, fy);
      if (d.shadow !== false) { // contact shadow under the feet
        const sw = w * 0.34 * scale, sh = Math.max(3, w * 0.05 * scale);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, sw);
        g.addColorStop(0, 'rgba(0,0,0,0.38)'); g.addColorStop(0.6, 'rgba(0,0,0,0.16)'); g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.save(); ctx.scale(1, sh / sw); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, sw, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
      ctx.scale(scale * (d.flip ? -1 : 1), scale);
      ctx.imageSmoothingEnabled = !m.crisp;
      if (!m.crisp) ctx.imageSmoothingQuality = 'high';
      if (overArt || overList) { ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 9 * u; }
      ctx.drawImage(img, sx, sy, m.cell.w, m.cell.h, -w / 2, -h, w, h);
      ctx.restore();
    }
    ctx.imageSmoothingEnabled = true;
  }
}
