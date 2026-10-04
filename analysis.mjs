// Liner — "liveliness" analysis of a song's decoded PCM, for the dancers' auto mode.
// Runs in a worker thread (see server.mjs) so the server keeps streaming previews while it listens.
// Features, per 21 ms frame of a 12 kHz mono downmix: loudness, share of energy below 150 Hz, spectral flux
// (onsets). From those: tempo (autocorrelation of the onset envelope), beat strength, onset rate, loudness,
// bassiness — combined into one 0..1 score. Nothing here is a judgement of quality; "lively" just means a
// steady, audible pulse that a dancing sprite can follow.

import fs from 'node:fs';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';

export const ANALYSIS_VERSION = 2; // 2: tracked beat times (`beats`, `beatConf`) for dancers that step in time
const SAMPLE_RATE = 48000, BYTES_PER_FRAME = 6, DECIMATE = 4;
const FS = SAMPLE_RATE / DECIMATE;          // 12 kHz
const N = 512, HOP = 256;                   // 42.7 ms window, 21.3 ms hop
const FRAME_RATE = FS / HOP;                // 46.875 frames per second
const LOW_HZ = 150;
const SILENCE_DB = -55;

// ---------------------------------------------------------------- FFT (radix-2, in place, real input through complex)
function makeFFT(N) {
  const BITS = Math.log2(N);
  const rev = new Uint16Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b); rev[i] = r; }
  const cosT = new Float32Array(N / 2), sinT = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / N); sinT[i] = Math.sin(-2 * Math.PI * i / N); }
  const window = new Float32Array(N);
  for (let i = 0; i < N; i++) window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); // Hann
  function fft(re, im) {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let start = 0; start < N; start += size) {
        for (let k = 0, w = 0; k < half; k++, w += step) {
          const i = start + k, j = i + half;
          const tr = re[j] * cosT[w] - im[j] * sinT[w], ti = re[j] * sinT[w] + im[j] * cosT[w];
          re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
        }
      }
    }
  }
  return { N, fft, window };
}
const F512 = makeFFT(N);
const fft = F512.fft, hann = F512.window;

// ---------------------------------------------------------------- reading: s24le stereo → 12 kHz mono float
function readMono(pcmPath, samples, dec = DECIMATE) {
  const out = new Float32Array(Math.ceil(samples / dec));
  const fd = fs.openSync(pcmPath, 'r');
  const buf = Buffer.alloc(BYTES_PER_FRAME * 65536);
  let acc = 0, accN = 0, o = 0;
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (!n) break;
      const frames = Math.floor(n / BYTES_PER_FRAME);
      for (let f = 0; f < frames; f++) {
        const p = f * BYTES_PER_FRAME;
        let l = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16); if (l & 0x800000) l -= 0x1000000;
        let r = buf[p + 3] | (buf[p + 4] << 8) | (buf[p + 5] << 16); if (r & 0x800000) r -= 0x1000000;
        acc += (l + r) * (0.5 / 8388608); accN++;
        if (accN === dec) { if (o < out.length) out[o++] = acc / dec; acc = 0; accN = 0; }
      }
    }
  } finally { fs.closeSync(fd); }
  if (accN && o < out.length) out[o++] = acc / accN;
  return out.subarray(0, o);
}

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// tempo prior: music people dance to sits around 100–140 BPM; the weight resolves the half/double tempo ambiguity
const tempoWeight = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.7, 2));

export function analyze(pcmPath, samples) {
  const x = readMono(pcmPath, samples);
  const frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const rmsDb = new Float32Array(frames), bassRatio = new Float32Array(frames), flux = new Float32Array(frames);
  const re = new Float32Array(N), im = new Float32Array(N);
  let prevMag = new Float32Array(N / 2), mag = new Float32Array(N / 2);
  const lowBins = Math.max(1, Math.round(LOW_HZ / (FS / N)));
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[off + i]; e += v * v; re[i] = v * hann[i]; im[i] = 0; }
    rmsDb[f] = 10 * Math.log10(e / N + 1e-12);
    fft(re, im);
    let tot = 0, low = 0, fl = 0;
    for (let k = 1; k < N / 2; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const p = m * m;
      tot += p; if (k <= lowBins) low += p;
      const lm = Math.log1p(m * 40); // compressed magnitudes: onsets in quiet passages count too
      const d = lm - prevMag[k]; if (d > 0) fl += d;
      mag[k] = lm;
    }
    bassRatio[f] = tot > 1e-9 ? low / tot : 0;
    flux[f] = f ? fl : 0;
    const tmp = prevMag; prevMag = mag; mag = tmp;
  }
  if (frames < FRAME_RATE * 4) return { v: ANALYSIS_VERSION, score: 0, label: 'Calm', bpm: 0, beat: 0, loudDb: -100, bass: 0, onsetRate: 0, silence: 0, duration: x.length / FS, parts: { beat: 0, drive: 0, bass: 0, loud: 0, tempo: 0 }, curve: [], beats: [], beatConf: 0 };

  // audible frames only for the level statistics
  let loudSum = 0, loudN = 0, bassSum = 0;
  for (let f = 0; f < frames; f++) if (rmsDb[f] > SILENCE_DB) { loudSum += rmsDb[f]; bassSum += bassRatio[f]; loudN++; }
  const loudDb = loudN ? loudSum / loudN : -100, bass = loudN ? bassSum / loudN : 0;
  const silence = 1 - loudN / frames;

  // onset envelope: flux above its local (1 s) mean
  const W = Math.round(FRAME_RATE);
  const onset = new Float32Array(frames);
  let run = 0;
  for (let f = 0; f < frames; f++) {
    run += flux[f]; if (f >= W) run -= flux[f - W];
    const local = run / Math.min(W, f + 1);
    onset[f] = Math.max(0, flux[f] - local);
  }
  // onsets per second: local maxima clearly above the envelope's typical level
  let mean = 0; for (let f = 0; f < frames; f++) mean += onset[f]; mean /= frames;
  let varSum = 0; for (let f = 0; f < frames; f++) { const d = onset[f] - mean; varSum += d * d; }
  const thr = mean + 1.0 * Math.sqrt(varSum / frames);
  let onsets = 0;
  for (let f = 2; f < frames - 2; f++) if (onset[f] > thr && onset[f] >= onset[f - 1] && onset[f] >= onset[f + 1] && onset[f] > onset[f - 2] && onset[f] > onset[f + 2]) onsets++;
  const audibleSec = Math.max(1, loudN / FRAME_RATE);
  const onsetRate = onsets / audibleSec;

  // tempo: autocorrelation of the mean-removed envelope over 50–200 BPM
  const minLag = Math.round(FRAME_RATE * 60 / 200), maxLag = Math.round(FRAME_RATE * 60 / 50);
  const o = new Float32Array(frames);
  for (let f = 0; f < frames; f++) o[f] = onset[f] - mean;
  let acf0 = 0; for (let f = 0; f < frames; f++) acf0 += o[f] * o[f];
  const acf = new Float32Array(maxLag + 2);
  for (let lag = Math.max(1, Math.floor(minLag / 2) - 1); lag <= maxLag + 1; lag++) { let s = 0; for (let f = lag; f < frames; f++) s += o[f] * o[f - lag]; acf[lag] = acf0 > 0 ? s / acf0 : 0; }
  let bestLag = minLag, bestW = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (!(acf[lag] >= acf[lag - 1] && acf[lag] >= acf[lag + 1])) continue; // peaks only
    const w = acf[lag] * (0.55 + 0.45 * tempoWeight(60 * FRAME_RATE / lag));
    if (w > bestW) { bestW = w; bestLag = lag; }
  }
  const beat = Math.max(0, acf[bestLag]); // normalised autocorrelation at the beat period: how regular the pulse is
  // fold the tempo into the 80–165 BPM range when the other octave is also well supported: that is the pulse a dancer follows
  const near = (lag) => Math.max(acf[Math.max(1, Math.round(lag) - 1)] || 0, acf[Math.round(lag)] || 0, acf[Math.min(acf.length - 1, Math.round(lag) + 1)] || 0);
  let lagF = bestLag;
  if (60 * FRAME_RATE / lagF < 80 && near(lagF / 2) >= 0.45 * beat) lagF = lagF / 2;
  else if (60 * FRAME_RATE / lagF > 165 && lagF * 2 <= maxLag && near(lagF * 2) >= 0.45 * beat) lagF = lagF * 2;
  // sub-frame peak position (parabolic interpolation) for a usable BPM
  const li = Math.round(lagF);
  const a = acf[li - 1] || 0, b = acf[li] || 0, c = acf[li + 1] || 0;
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? 0.5 * (a - c) / denom : 0;
  const lag = li + Math.max(-0.5, Math.min(0.5, shift));
  const bpm = 60 * FRAME_RATE / lag;
  // the beats themselves, one by one, so a dancer can land every step on one even when the tempo breathes
  const tracked = trackBeats(onset, lag);

  // score
  const beatS = smooth(0.06, 0.32, beat);
  const driveS = smooth(1.0, 5.0, onsetRate);
  const bassS = smooth(0.10, 0.42, bass);
  const loudS = smooth(-30, -13, loudDb);
  const tempoS = smooth(0.25, 0.9, tempoWeight(bpm));
  const score = clamp01(0.30 * beatS + 0.20 * driveS + 0.22 * bassS + 0.18 * loudS + 0.10 * tempoS);
  const label = score >= 0.66 ? 'Lively' : score >= 0.4 ? 'Steady' : 'Calm';

  // a small energy curve for the review list (one value per second, folded to at most 120 points)
  const secs = Math.max(1, Math.floor(frames / FRAME_RATE));
  const perSec = new Float32Array(secs);
  const secLoud = new Float32Array(secs), secOn = new Float32Array(secs);
  let fmax = 1e-6;
  for (let s = 0; s < secs; s++) {
    let l = 0, fl = 0, n = 0;
    for (let f = Math.floor(s * FRAME_RATE); f < Math.min(frames, Math.floor((s + 1) * FRAME_RATE)); f++) { l += rmsDb[f]; fl += onset[f]; n++; }
    secLoud[s] = n ? l / n : -100; secOn[s] = n ? fl / n : 0;
    fmax = Math.max(fmax, secOn[s]);
  }
  // loudness share plus onset share, the latter normalised to the song's own busiest second
  for (let s = 0; s < secs; s++) perSec[s] = clamp01(0.55 * clamp01((secLoud[s] + 45) / 35) + 0.45 * (secOn[s] / fmax));
  const points = Math.min(120, secs);
  const curve = [];
  for (let p = 0; p < points; p++) {
    const s0 = Math.floor(p * secs / points), s1 = Math.max(s0 + 1, Math.floor((p + 1) * secs / points));
    let m = 0; for (let s = s0; s < s1; s++) m += perSec[s];
    curve.push(Math.round((m / (s1 - s0)) * 100) / 100);
  }
  return {
    v: ANALYSIS_VERSION, score: Math.round(score * 1000) / 1000, label,
    bpm: Math.round(bpm * 10) / 10, beat: Math.round(beat * 1000) / 1000, loudDb: Math.round(loudDb * 10) / 10, bass: Math.round(bass * 1000) / 1000,
    onsetRate: Math.round(onsetRate * 100) / 100, silence: Math.round(silence * 1000) / 1000, duration: Math.round(x.length / FS * 10) / 10,
    parts: { beat: +beatS.toFixed(2), drive: +driveS.toFixed(2), bass: +bassS.toFixed(2), loud: +loudS.toFixed(2), tempo: +tempoS.toFixed(2) },
    curve,
    beats: tracked.beats, beatConf: tracked.conf,
  };
}

// ---------------------------------------------------------------- beat tracking
// Beat times from the onset envelope and the tempo estimate, by dynamic programming (Ellis 2007, as in librosa):
// every frame scores its onset strength plus the best predecessor between half and twice the period back, penalised
// by how far that spacing strays from the period, so the chosen chain of beats sits on the onsets and keeps the
// tempo while still following it when it drifts. Backtracking from the last strong beat gives the chain; each beat
// is then refined to the sub-frame peak of the envelope. `conf` says how much more onset there is on the beats
// than on average (0 for noise, about 1 for a solid pulse).
const TIGHTNESS = 100;
function trackBeats(onset, period) {
  const n = onset.length;
  if (!(period > 2) || n < period * 4) return { beats: [], conf: 0 };
  const ls = new Float32Array(n); // lightly smoothed, scaled to unit power
  for (let f = 0; f < n; f++) ls[f] = 0.25 * (f ? onset[f - 1] : 0) + 0.5 * onset[f] + 0.25 * (f + 1 < n ? onset[f + 1] : 0);
  let pw = 0; for (let f = 0; f < n; f++) pw += ls[f] * ls[f];
  const norm = Math.sqrt(pw / n) || 1;
  let lsMax = 0; for (let f = 0; f < n; f++) { ls[f] /= norm; if (ls[f] > lsMax) lsMax = ls[f]; }
  const dMin = Math.max(1, Math.round(period / 2)), dMax = Math.round(period * 2);
  const txwt = new Float32Array(dMax + 1);
  for (let d = dMin; d <= dMax; d++) txwt[d] = -TIGHTNESS * Math.pow(Math.log(d / period), 2);
  const cum = new Float32Array(n), back = new Int32Array(n);
  let firstBeat = true;
  for (let f = 0; f < n; f++) {
    let best = -Infinity, bi = -1;
    for (let d = dMin; d <= dMax; d++) { const p = f - d; const sc = (p >= 0 ? cum[p] : 0) + txwt[d]; if (sc > best) { best = sc; bi = p; } }
    cum[f] = ls[f] + best;
    if (firstBeat && ls[f] < 0.01 * lsMax) back[f] = -1; else { back[f] = bi; firstBeat = false; }
  }
  // the last beat: the last local maximum of the cumulative score that reaches half the median of the maxima
  const maxes = [];
  for (let f = 1; f < n - 1; f++) if (cum[f] > cum[f - 1] && cum[f] >= cum[f + 1]) maxes.push(f);
  if (!maxes.length) return { beats: [], conf: 0 };
  const med = maxes.map((f) => cum[f]).sort((a, b) => a - b)[maxes.length >> 1];
  let last = maxes[maxes.length - 1];
  for (let i = maxes.length - 1; i >= 0; i--) if (cum[maxes[i]] * 2 > med) { last = maxes[i]; break; }
  const frames = [];
  for (let f = last; f >= 0; f = back[f]) frames.push(f);
  frames.reverse();
  if (frames.length < 2) return { beats: [], conf: 0 };
  // sub-frame refinement on the smoothed envelope, then seconds at the window's centre (measured against a click
  // track that puts the tracked beats within a few ms of the clicks)
  const beats = frames.map((f) => {
    const a = f > 0 ? ls[f - 1] : ls[f], b = ls[f], c = f + 1 < n ? ls[f + 1] : ls[f];
    const den = a - 2 * b + c;
    const sh = den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
    return Math.round(((f + sh) * HOP + N / 2) / FS * 1000) / 1000;
  });
  // confidence: how much more onset sits on the beats than anywhere, and how even the beat intervals are
  let hit = 0; for (const f of frames) hit += Math.max(ls[f], f > 0 ? ls[f - 1] : 0, f + 1 < n ? ls[f + 1] : 0);
  hit /= frames.length;
  let base = 0; for (let f = 0; f < n; f++) base += ls[f]; base /= n;
  const onBeat = base > 0 ? clamp01((hit / base - 1) / 2.5) : 0;
  const iv = []; for (let i = 1; i < beats.length; i++) iv.push(beats[i] - beats[i - 1]);
  iv.sort((a, b) => a - b);
  const q = (p) => iv[Math.min(iv.length - 1, Math.floor(p * iv.length))];
  const even = iv.length >= 4 ? clamp01(1 - ((q(0.9) - q(0.1)) / q(0.5)) / 0.3) : 0;
  const conf = 0.5 * onBeat + 0.5 * even;
  return { beats, conf: Math.round(conf * 1000) / 1000 };
}

// ---------------------------------------------------------------- spectrum for the visualizer
// Band levels over time, 60 frames per second, for the frequency visualizer. Log-spaced bands from 40 Hz to 12 kHz,
// a gentle high-frequency tilt (music spectra fall with frequency; without it the top bands never move), levels
// normalised per song so a quiet recording fills the display like a loud one, and analyser-style ballistics
// (instant rise, steady fall) baked in so the picture is the same wherever playback starts. Stored as bytes.
export const SPECTRUM_VERSION = 1;
export const SPECTRUM_BANDS = 32, SPECTRUM_RATE = 60;
const SPEC_LO = 40, SPEC_HI = 12000, SPEC_TILT = 3.5, SPEC_RANGE = 54, SPEC_FALL = 0.065, SPEC_GAMMA = 1.6;
export function spectrum(pcmPath, samples, { bands = SPECTRUM_BANDS, rate = SPECTRUM_RATE } = {}) {
  const dec = 2, SR = SAMPLE_RATE / dec; // 24 kHz
  const x = readMono(pcmPath, samples, dec);
  const N = 1024, HOP = Math.round(SR / rate);
  const F = makeFFT(N), win = F.window;
  const frames = Math.max(1, Math.ceil(x.length / HOP));
  const binHz = SR / N;
  const edges = [], lo = [], hi = [], tilt = [];
  for (let k = 0; k <= bands; k++) edges.push(SPEC_LO * Math.pow(SPEC_HI / SPEC_LO, k / bands));
  for (let k = 0; k < bands; k++) {
    const a = Math.max(1, Math.round(edges[k] / binHz)), b = Math.max(a + 1, Math.round(edges[k + 1] / binHz));
    lo.push(a); hi.push(Math.min(N / 2, b));
    tilt.push(SPEC_TILT * Math.log2(Math.sqrt(edges[k] * edges[k + 1]) / 100));
  }
  const raw = new Float32Array(frames * bands);
  const re = new Float32Array(N), im = new Float32Array(N);
  const norm = 1 / (N / 4); // a full-scale sine under a Hann window peaks at N/4
  const hist = new Uint32Array(200); // 1 dB bins from -160 dB
  let counted = 0;
  for (let f = 0; f < frames; f++) {
    const centre = f * HOP;
    for (let i = 0; i < N; i++) { const p = centre - N / 2 + i; const v = p >= 0 && p < x.length ? x[p] : 0; re[i] = v * win[i]; im[i] = 0; }
    F.fft(re, im);
    for (let k = 0; k < bands; k++) {
      let p = 0;
      for (let b = lo[k]; b < hi[k]; b++) { const m = (re[b] * re[b] + im[b] * im[b]); p += m; }
      p = (p / (hi[k] - lo[k])) * norm * norm;
      const db = 10 * Math.log10(p + 1e-12) + tilt[k];
      raw[f * bands + k] = db;
      if (db > -90) { hist[Math.min(199, Math.max(0, Math.round(db + 160)))]++; counted++; }
    }
  }
  // the song's own loud end: the 99.5th percentile of all audible band levels maps to full scale
  let top = -20;
  if (counted) { let acc = 0; for (let i = 199; i >= 0; i--) { acc += hist[i]; if (acc >= counted * 0.005) { top = i - 160; break; } } }
  const floor = top - SPEC_RANGE;
  const data = new Uint8Array(frames * bands);
  const prev = new Float32Array(bands);
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < bands; k++) {
      let v = (raw[f * bands + k] - floor) / (top - floor);
      v = v < 0 ? 0 : v > 1 ? 1 : Math.pow(v, SPEC_GAMMA); // a curve so dense music does not pin every bar near the top
      if (v < prev[k] - SPEC_FALL) v = prev[k] - SPEC_FALL; // steady fall, instant rise
      prev[k] = v;
      data[f * bands + k] = Math.round(v * 255);
    }
  }
  return { v: SPECTRUM_VERSION, bands, rate, frames, top: Math.round(top * 10) / 10, floor: Math.round(floor * 10) / 10, data };
}

if (!isMainThread && parentPort && workerData && workerData.pcm) {
  try {
    if (workerData.task === 'spectrum') { const r = spectrum(workerData.pcm, workerData.samples); parentPort.postMessage({ ok: true, result: { v: r.v, bands: r.bands, rate: r.rate, frames: r.frames, top: r.top, floor: r.floor }, data: r.data }, [r.data.buffer]); }
    else parentPort.postMessage({ ok: true, result: analyze(workerData.pcm, workerData.samples) });
  } catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }
}
