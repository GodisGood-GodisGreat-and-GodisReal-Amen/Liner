// Liner — app logic: project state, song ingestion, live preview with audio, inspector, export.
import { Renderer, extractPalette, makePlaceholderArt, formatTime, rgbHex, hashString, paletteFromHue, clamp, clamp01, songLength, trimStart, dancerActive, danceThreshold, DANCE_PLACES, DANCE_SIZE, frameAtPhase, VIZ_PLACES, VIZ_SIZE, vizLabelH, parseSpectrum, videoFrameIndex, songVideoId } from './renderer.js';
import { H264Source } from './h264.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const icon = (name) => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
// yields to the event loop without the 1 s timer throttling browsers apply to background tabs
const nextFrame = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
const fmtBytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB');
const AUDIO_EXT = /\.(mp3|flac|wav|wave|aif|aiff|aifc|m4a|m4b|aac|ogg|oga|opus|wma|caf|alac|mp4|mid|midi|kar|rmi|smf)$/i; // MIDI files are rendered to sound by the server
const APP_VERSION = '1.1.0'; // must match server.mjs; an older server (or an older page) is told apart at start
const cmpVersion = (a, b) => { const A = String(a).split('.').map(Number), B = String(b).split('.').map(Number); for (let i = 0; i < Math.max(A.length, B.length); i++) { const d = (A[i] || 0) - (B[i] || 0); if (d) return d; } return 0; };
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '') || /Macintosh/.test(navigator.userAgent);
const IS_WIN = /Win/.test(navigator.platform || '');
// shortcut labels are written with Mac glyphs; elsewhere they read Ctrl+, Alt+, Shift+ and Backspace
const KEYS = (s) => (IS_MAC ? s : s.replace(/[⌘⌥⇧]\s?/g, (m) => ({ '⌘': 'Ctrl+', '⌥': 'Alt+', '⇧': 'Shift+' })[m[0]]).replace(/\+(\s|$)/g, '$1').replace(/⌫/g, 'Backspace'));
const HAS_DECODER = typeof VideoDecoder !== 'undefined'; // video backgrounds in the preview need WebCodecs

requestAnimationFrame(() => document.body.classList.add('is-ready')); // a soft arrival on launch

// ---------------------------------------------------------------- state
const PRESETS = { '720p': [1280, 720], '1080p': [1920, 1080], '1440p': [2560, 1440], '2160p': [3840, 2160] };
const defaultState = () => ({
  v: 1, title: '', subtitle: '', seed: Math.random(), songs: [],
  look: { style: 'aurora', videoId: null, videoName: '', videoBlur: 0, font: 'sans', grain: 0.4, motion: 1, dim: 0, corners: 'soft', side: 'left', glow: false, marker: 'arrow', rows: 'boxes', density: 'comfortable', accent: 'white', showTitle: true, showMeta: true, showNowPlaying: true, marquee: false, showIndex: true, showThumbs: true, showDurations: true, showProgress: true, eyebrow: false, showNext: false, timeMode: 'elapsed', showClock: false, progress: 'bar', balance: 'balanced' },
  timing: { lead: 1, gap: 1, tail: 2, crossfade: 0 },
  output: { preset: '1080p', width: 1920, height: 1080, fps: 30, codec: 'h264', quality: 'high', audio: 'aac', fileName: '' },
  audio: { bass: 'off', gain: 6 },
  dancers: [], dance: { mode: 'auto', sensitivity: 0.5 },
  viz: { style: 'off', place: 'under-art', size: VIZ_SIZE.def, color: 'white', labels: true, labelSize: 'large', guides: true, mirror: false, level: 1, x: 0.3, y: 0.72, w: 0.4 },
  captions: [], logo: { id: null, name: '', place: 'top-right', size: 0.08, opacity: 0.9, x: 0.85, y: 0.12 },
});
const cleanSong = (s) => ({ id: s.id, fileName: s.fileName || '', title: s.title || '', artist: s.artist || '', album: s.album || '', duration: +s.duration || 0, ready: !!s.ready, error: s.error || null, cover: !!s.cover, coverVersion: s.coverVersion || 0, customCover: !!s.customCover, coverMode: s.coverMode || (s.cover ? 'embedded' : 'none'), coverInfo: s.coverInfo || null, midi: s.midi || null, samples: s.samples || null, dancer: s.dancer === 'on' || s.dancer === 'off' ? s.dancer : undefined, trim: s.trim && typeof s.trim === 'object' ? { start: Math.max(0, +s.trim.start || 0), end: s.trim.end == null ? null : +s.trim.end, fade: !!s.trim.fade } : null,
  // the song's own video (from the server) and what the song does with video and background
  hasVideo: !!s.hasVideo, videoSource: s.videoSource === 'file' || s.videoSource === 'link' ? s.videoSource : null, ownVideo: s.ownVideo || null, ownVideoStatus: ['ready', 'preparing', 'error'].includes(s.ownVideoStatus) ? s.ownVideoStatus : 'none', ownVideoError: s.ownVideoError || null,
  volume: clamp(+s.volume || 0, -12, 6),
  bg: s.bg && ['aurora', 'cover', 'ink'].includes(s.bg.style) ? { style: s.bg.style } : null, videoUse: ['background', 'art', 'both'].includes(s.videoUse) ? s.videoUse : 'off', videoPick: s.videoPick === 'other' ? 'other' : 'own', videoId: s.videoId || null, videoName: s.videoName || '', videoBlur: s.videoBlur == null ? null : clamp(+s.videoBlur || 0, 0, 1) });
const syncVideoFields = (s, m) => Object.assign(s, { hasVideo: !!m.hasVideo, videoSource: m.videoSource || null, ownVideo: m.ownVideo || null, ownVideoStatus: m.ownVideoStatus || 'none', ownVideoError: m.ownVideoError || null });
const cleanDancer = (d) => ({ id: d.id || Math.random().toString(36).slice(2, 10), spriteId: d.spriteId, place: d.place || 'under-art', size: clamp(+d.size || DANCE_SIZE.def, DANCE_SIZE.min, DANCE_SIZE.max), flip: !!d.flip, shadow: d.shadow !== false, tempo: d.tempo === 'natural' || d.tempo === 'beat' ? d.tempo : 'instep', speed: clamp(+d.speed || 1, 0.25, 4), x: Number.isFinite(+d.x) ? clamp(+d.x, 0, 1) : 0.5, y: Number.isFinite(+d.y) ? clamp(+d.y, 0, 1) : 0.85 });
const cleanCaption = (c) => ({ id: c.id || Math.random().toString(36).slice(2, 10), text: String(c.text == null ? '' : c.text).slice(0, 120), x: Number.isFinite(+c.x) ? clamp(+c.x, 0, 1) : 0.5, y: Number.isFinite(+c.y) ? clamp(+c.y, 0, 1) : 0.9, size: clamp(+c.size || 0.032, 0.012, 0.2), color: c.color === 'album' ? 'album' : 'white', bold: !!c.bold, opacity: Number.isFinite(+c.opacity) ? clamp(+c.opacity, 0.05, 1) : 0.92 });
const cleanLogo = (l, d) => ({ ...d, ...(l && typeof l === 'object' ? { id: l.id || null, name: String(l.name || ''), place: l.place || d.place, size: clamp(+l.size || d.size, 0.03, 0.4), opacity: Number.isFinite(+l.opacity) ? clamp(+l.opacity, 0.05, 1) : d.opacity, x: Number.isFinite(+l.x) ? clamp(+l.x, 0, 1) : d.x, y: Number.isFinite(+l.y) ? clamp(+l.y, 0, 1) : d.y } : {}) });
function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('liner.project'));
    if (s && s.v === 1) {
      const d = defaultState();
      return { ...d, ...s, look: { ...d.look, ...s.look }, timing: { ...d.timing, ...s.timing }, output: { ...d.output, ...s.output }, audio: { ...d.audio, ...(s.audio || {}) }, songs: (s.songs || []).map(cleanSong) };
    }
  } catch { /* fresh start */ }
  return defaultState();
}
// Mixes: every mix is stored under liner.mix.<id>; liner.mixes lists them; liner.project (the original single project) is migrated once.
const MIX_INDEX_KEY = 'liner.mixes', MIX_KEY = (id) => `liner.mix.${id}`, CURRENT_MIX_KEY = 'liner.currentMix';
const newMixId = () => Math.random().toString(36).slice(2, 10);
function readMixIndex() { try { const v = JSON.parse(localStorage.getItem(MIX_INDEX_KEY)); return Array.isArray(v) ? v : []; } catch { return []; } }
function writeMixIndex(list) { localStorage.setItem(MIX_INDEX_KEY, JSON.stringify(list)); }
function normalizeState(raw) {
  const d = defaultState();
  if (!raw || raw.v !== 1) return d;
  return { ...d, ...raw, look: { ...d.look, ...raw.look }, timing: { ...d.timing, ...raw.timing }, output: { ...d.output, ...raw.output }, audio: { ...d.audio, ...(raw.audio || {}) }, dance: { ...d.dance, ...(raw.dance || {}) }, viz: { ...d.viz, ...(raw.viz || {}) }, captions: (Array.isArray(raw.captions) ? raw.captions : []).map(cleanCaption), logo: cleanLogo(raw.logo, d.logo), dancers: (Array.isArray(raw.dancers) ? raw.dancers : []).filter((x) => x && x.spriteId).map(cleanDancer), songs: (raw.songs || []).map(cleanSong) };
}
function loadMixState(id) { try { return normalizeState(JSON.parse(localStorage.getItem(MIX_KEY(id)))); } catch { return defaultState(); } }
let currentMixId = localStorage.getItem(CURRENT_MIX_KEY);
if (!readMixIndex().length) { // first run with mixes: adopt the single project as the first mix
  const legacy = normalizeState((() => { try { return JSON.parse(localStorage.getItem('liner.project')); } catch { return null; } })());
  currentMixId = newMixId();
  localStorage.setItem(MIX_KEY(currentMixId), JSON.stringify(legacy));
  writeMixIndex([{ id: currentMixId, title: legacy.title || '', updatedAt: Date.now() }]);
  localStorage.setItem(CURRENT_MIX_KEY, currentMixId);
  localStorage.removeItem('liner.project');
}
if (!currentMixId || !readMixIndex().some((m) => m.id === currentMixId)) { currentMixId = readMixIndex()[0].id; localStorage.setItem(CURRENT_MIX_KEY, currentMixId); }
const state = loadMixState(currentMixId);
let saveTimer;
// the mix as it is written to storage (and as undo and redo remember it)
const persistable = () => ({ ...state, songs: state.songs.filter((s) => !s.uploading).map(cleanSong), dancers: state.dancers.map(cleanDancer), captions: state.captions.map(cleanCaption), logo: cleanLogo(state.logo, defaultState().logo) });
function saveNow() {
  if (!currentMixId) return; // between deleting the current mix and switching to the next one there is nothing to own the state
  const json = JSON.stringify(persistable());
  localStorage.setItem(MIX_KEY(currentMixId), json);
  historyRecord(json);
  const index = readMixIndex();
  const entry = index.find((m) => m.id === currentMixId);
  if (entry) { entry.title = state.title || ''; entry.updatedAt = Date.now(); entry.songs = state.songs.filter((s) => !s.uploading).length; }
  writeMixIndex(index);
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 150); }
// song files are shared between mixes: only delete from disk when no other mix references the song
function songUsedElsewhere(id) {
  for (const m of readMixIndex()) { if (m.id === currentMixId) continue; try { const st = JSON.parse(localStorage.getItem(MIX_KEY(m.id))); if (st && st.songs && st.songs.some((s) => s.id === id)) return true; } catch { /* ignore */ } }
  return false;
}
const getPath = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const setPath = (obj, p, v) => { const ks = p.split('.'); const last = ks.pop(); const o = ks.reduce((o, k) => (o == null ? undefined : o[k]), obj); if (o != null) o[last] = v; };

// ---------------------------------------------------------------- api
const api = {
  async json(url, opts) {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
    return body;
  },
  health: () => api.json('/api/health'),
  songs: () => api.json('/api/songs'),
  song: (id) => api.json(`/api/songs/${id}`),
  removeSong: (id) => api.json(`/api/songs/${id}`, { method: 'DELETE' }),
  clearCover: (id) => api.json(`/api/songs/${id}/cover`, { method: 'DELETE' }),
  upload(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => { let body = {}; try { body = JSON.parse(xhr.responseText); } catch {} if (xhr.status >= 200 && xhr.status < 300) resolve(body); else reject(new Error(body.error || `Upload failed (${xhr.status})`)); };
      xhr.onerror = () => reject(new Error('Upload failed. Is the Liner server running?'));
      xhr.send(file);
    });
  },
  renderStart: (params) => api.json('/api/render/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params) }),
  chunk: async (rid, body, part = 0) => { const r = await fetch(`/api/render/${rid}/chunk${part ? `?part=${part}` : ''}`, { method: 'POST', body }); if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || 'The server stopped accepting frames.'); } },
  finish: (rid) => api.json(`/api/render/${rid}/finish`, { method: 'POST' }),
  status: (rid) => api.json(`/api/render/${rid}/status`),
  cancel: (rid) => api.json(`/api/render/${rid}/cancel`, { method: 'POST' }).catch(() => {}),
  reveal: (file) => api.json('/api/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) }),
  open: (file) => api.json('/api/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file }) }),
};

// ---------------------------------------------------------------- toasts, tooltip, menu
function toast(message, { error = false, duration = 4200, action = null } = {}) {
  const t = el('div', 'toast' + (error ? ' is-error' : ''), (error ? icon('warning') : '') + `<span></span>`);
  t.querySelector('span').textContent = message;
  let timer;
  const dismiss = () => { clearTimeout(timer); t.classList.add('is-out'); setTimeout(() => t.remove(), 180); };
  if (action) { const b = el('button', null, action.label); b.type = 'button'; b.addEventListener('click', () => { dismiss(); action.run(); }); t.append(b); }
  $('#toasts').append(t);
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('is-in')));
  timer = setTimeout(() => { dismiss(); if (action && action.expire) action.expire(); }, duration);
  return { dismiss };
}
const tooltip = (() => {
  const tip = $('#tooltip');
  let timer, current = null, lastHidden = 0;
  const show = (target) => {
    tip.textContent = target.dataset.tip;
    const instant = performance.now() - lastHidden < 350;
    tip.classList.toggle('is-instant', instant);
    const r = target.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 7;
    x = clamp(x, 8, innerWidth - tw - 8);
    if (y < 8) y = r.bottom + 7;
    tip.style.left = `${Math.round(x)}px`; tip.style.top = `${Math.round(y)}px`;
    tip.classList.add('is-in');
    current = target;
  };
  const hide = () => { clearTimeout(timer); if (current) { lastHidden = performance.now(); current = null; } tip.classList.remove('is-in'); };
  document.addEventListener('pointerover', (e) => {
    const t = e.target.closest && e.target.closest('[data-tip]');
    if (!t || t === current) return;
    clearTimeout(timer);
    const instant = performance.now() - lastHidden < 350;
    timer = setTimeout(() => show(t), instant ? 0 : 450);
  });
  document.addEventListener('pointerout', (e) => { const t = e.target.closest && e.target.closest('[data-tip]'); if (t && !t.contains(e.relatedTarget)) hide(); });
  document.addEventListener('pointerdown', hide, true);
  return { hide };
})();
const menu = (() => {
  const m = $('#menu');
  let closeTimer, anchor = null;
  function open(target, items) {
    clearTimeout(closeTimer);
    m.innerHTML = '';
    for (const it of items) {
      if (it === '-') { m.append(el('hr')); continue; }
      const b = el('button', (it.danger ? 'is-danger' : '') + (it.current ? ' is-current' : ''), (it.checked != null ? `<span class="menu-check">${it.checked ? icon('check') : ''}</span>` : it.icon ? icon(it.icon) : '') + `<span></span>`);
      b.lastElementChild.textContent = it.label;
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', () => { close(); it.action(); });
      m.append(b);
    }
    m.hidden = false;
    const r = target.getBoundingClientRect();
    let x = r.left, y = r.bottom + 6;
    if (x + m.offsetWidth > innerWidth - 8) x = innerWidth - 8 - m.offsetWidth;
    if (y + m.offsetHeight > innerHeight - 8) { y = r.top - 6 - m.offsetHeight; m.style.transformOrigin = 'bottom left'; } else m.style.transformOrigin = 'top left';
    m.style.left = `${Math.round(x)}px`; m.style.top = `${Math.round(y)}px`;
    anchor = target; target.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(() => m.classList.add('is-open'));
    m.querySelector('button')?.focus();
  }
  m.addEventListener('keydown', (e) => {
    if (!/^(ArrowDown|ArrowUp|Home|End)$/.test(e.key)) return;
    const items = $$('button', m); if (!items.length) return;
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next].focus(); e.preventDefault();
  });
  function close() {
    if (m.hidden) return;
    m.classList.remove('is-open');
    if (anchor) { anchor.removeAttribute('aria-expanded'); anchor = null; }
    closeTimer = setTimeout(() => { m.hidden = true; }, 150);
  }
  document.addEventListener('pointerdown', (e) => { if (!m.hidden && !m.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !m.hidden) { close(); e.stopPropagation(); } });
  return { open, close, get isOpen() { return !m.hidden; } };
})();

// ---------------------------------------------------------------- songs
const songById = (id) => state.songs.find((s) => s.id === id);
function coverUrl(s) { return `/api/songs/${s.id}/cover?v=${s.coverVersion || 0}`; }
async function hydrateSong(s) {
  if (s.cover) {
    const img = new Image();
    img.src = coverUrl(s);
    try { await img.decode(); s.image = img; s.palette = extractPalette(img); }
    catch { s.cover = false; }
  }
  if (!s.cover) {
    s.image = makePlaceholderArt(s, 600);
    s.palette = paletteFromHue(hashString((s.title || '') + '\u0001' + (s.artist || '') + s.id));
  }
  const row = rowOf(s.id);
  if (row) setRowThumb(row, s);
  invalidate();
}
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpg|mpeg|ts|m2ts|wmv|ogv)$/i;
// songs can come from video files too: the sound becomes the song and the picture can be shown later (Song settings…)
function isAudioFile(f) { return (f.type && (f.type.startsWith('audio/') || f.type.startsWith('video/'))) || AUDIO_EXT.test(f.name) || VIDEO_EXT.test(f.name); }
async function addFiles(files) {
  const list = [...files];
  const audio = list.filter(isAudioFile);
  const rejected = list.length - audio.length;
  if (rejected) toast(rejected === 1 ? 'One file was skipped: not an audio file.' : `${rejected} files were skipped: not audio files.`, { error: true });
  if (!audio.length) return;
  audio.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  for (const file of audio) {
    const temp = { id: 'tmp-' + Math.random().toString(36).slice(2), uploading: true, progress: 0, title: file.name.replace(/\.[^.]+$/, ''), artist: '', duration: 0, ready: false, cover: false, coverVersion: 0 };
    state.songs.push(temp);
    renderTracks();
    try {
      const meta = await api.upload('/api/songs', file, (p) => { temp.progress = p; const row = rowOf(temp.id); if (row) row.style.setProperty('--p', p.toFixed(3)); });
      const idx = state.songs.indexOf(temp);
      if (idx < 0) { api.removeSong(meta.id); continue; } // removed while uploading
      const song = cleanSong(meta);
      state.songs[idx] = song;
      renderTracks();
      hydrateSong(song);
      if (!song.ready) watchReadiness();
      invalidate();
    } catch (e) {
      const idx = state.songs.indexOf(temp);
      if (idx >= 0) state.songs.splice(idx, 1);
      renderTracks();
      toast(`${file.name}: ${e.message}`, { error: true, duration: 6000 });
    }
  }
}
function addSongMeta(meta) {
  const song = cleanSong(meta);
  state.songs.push(song);
  renderTracks();
  hydrateSong(song);
  if (!song.ready) watchReadiness();
  invalidate();
  if (song.videoSource) toast(`“${song.title || 'This song'}” comes with a video. It can play behind the song or in place of the artwork.`, { duration: 9000, action: { label: 'Set up…', run: () => openSongSheet(song) } });
  return song;
}
let readinessTimer = null;
function watchReadiness() {
  if (readinessTimer) return;
  readinessTimer = setInterval(async () => {
    const pending = state.songs.filter((s) => !s.uploading && !s.ready && !s.error);
    if (!pending.length) { clearInterval(readinessTimer); readinessTimer = null; return; }
    for (const s of pending) {
      try {
        const m = await api.song(s.id);
        if (m.ready || m.error) { // a MIDI song gains its piano-roll cover while it is being prepared
          const coverChanged = m.cover !== s.cover || (m.coverVersion || 0) !== (s.coverVersion || 0);
          Object.assign(s, { ready: m.ready, error: m.error, duration: m.duration, samples: m.samples, midi: m.midi || null, cover: m.cover, coverVersion: m.coverVersion, customCover: m.customCover, coverMode: m.coverMode, coverInfo: m.coverInfo });
          syncVideoFields(s, m);
          if (coverChanged) hydrateSong(s);
          updateRow(s); invalidate();
        }
      } catch (e) {
        if (/Unknown song/.test(e.message)) { s.error = 'Missing from cache'; updateRow(s); invalidate(); }
      }
    }
  }, 1000);
}
const pendingRemovals = new Map(); // id -> { song, index }
async function removeSong(id) {
  const idx = state.songs.findIndex((s) => s.id === id);
  if (idx < 0) return;
  const s = state.songs[idx];
  const row = rowOf(id);
  state.songs.splice(idx, 1);
  if (selectedId === id) selectedId = null;
  if (row) { row.style.transition = 'opacity 150ms var(--ease), transform 150ms var(--ease)'; row.style.opacity = '0'; row.style.transform = 'scale(0.98)'; await new Promise((r) => setTimeout(r, 150)); }
  renderTracks();
  invalidate();
  if (s.uploading) return;
  pendingRemovals.set(id, { song: s, index: idx });
  const finish = () => { if (!pendingRemovals.has(id)) return; pendingRemovals.delete(id); if (!songUsedElsewhere(id)) api.removeSong(id).catch(() => {}); };
  toast(`Removed “${s.title || 'Untitled'}”.`, { duration: 6000, action: { label: 'Undo', run: () => undoRemoval(id), expire: finish } });
}
function undoRemoval(id) {
  const p = pendingRemovals.get(id);
  if (!p) return;
  pendingRemovals.delete(id);
  state.songs.splice(Math.min(p.index, state.songs.length), 0, p.song);
  renderTracks();
  if (p.song.image) { const row = rowOf(id); if (row) setRowThumb(row, p.song); } else hydrateSong(p.song);
  selectRow(id);
  invalidate();
}
async function setCover(song, file) {
  if (!file.type.startsWith('image/')) return toast('Drop an image to use it as the cover.', { error: true });
  try {
    const meta = await api.upload(`/api/songs/${song.id}/cover`, file);
    Object.assign(song, { cover: true, customCover: true, coverVersion: meta.coverVersion, coverMode: meta.coverMode, coverInfo: meta.coverInfo });
    await hydrateSong(song);
    if (artSong === song) renderArtHead();
    save();
  } catch (e) { toast(e.message, { error: true }); }
}
async function restoreTags(song) {
  try {
    const meta = await api.song(song.id);
    if (song.title === (meta.title || '') && song.artist === (meta.artist || '')) return toast('The title and artist already match the file.');
    const before = { title: song.title, artist: song.artist };
    const apply = (v) => { song.title = v.title; song.artist = v.artist; song.album = song.album || meta.album || ''; updateRow(song); if (!song.cover) hydrateSong(song); invalidate(); };
    apply({ title: meta.title || '', artist: meta.artist || '' });
    toast(`“${song.title || 'Untitled'}”: title and artist are back to the file’s tags.`, { duration: 6000, action: { label: 'Undo', run: () => apply(before) } });
  } catch (e) { toast(e.message, { error: true }); }
}
async function resetCover(song) {
  try {
    const meta = await api.clearCover(song.id);
    Object.assign(song, { cover: meta.cover, customCover: false, coverVersion: meta.coverVersion, coverMode: meta.coverMode, coverInfo: meta.coverInfo });
    await hydrateSong(song);
    if (artSong === song) renderArtHead();
    save();
  } catch (e) { toast(e.message, { error: true }); }
}

// ---------------------------------------------------------------- track rows
const trackList = $('#trackList');
const rows = new Map();
const rowOf = (id) => rows.get(id);
function setRowThumb(row, s) {
  const holder = row.querySelector('.thumb-img');
  holder.innerHTML = '';
  if (s.image) {
    if (s.image instanceof HTMLImageElement) { const img = new Image(); img.src = s.image.src; img.alt = ''; img.draggable = false; holder.append(img); }
    else { const c = document.createElement('canvas'); c.width = c.height = 72; c.getContext('2d').drawImage(s.image, 0, 0, 72, 72); holder.append(c); }
  }
}
function buildRow(s) {
  const row = el('li', 'track');
  row.dataset.id = s.id;
  row.innerHTML = `
    <button class="grip" aria-label="Drag to reorder" tabindex="-1">${icon('grip')}</button>
    <span class="index"><span class="num"></span><span class="go">${icon('play')}</span></span>
    <button class="thumb" aria-label="Cover art" data-tip="Cover art"><span class="thumb-img"></span><span class="thumb-hover">${icon('image')}</span></button>
    <div class="fields"><input class="f-title" placeholder="Untitled" spellcheck="false" autocomplete="off" aria-label="Title"><input class="f-artist" placeholder="Add artist" spellcheck="false" autocomplete="off" aria-label="Artist"></div>
    <span class="dur-cell"><button class="row-video" hidden aria-label="Song settings" data-tip="Song settings…">${icon('video')}</button><span class="dur"></span></span>
    <button class="remove" aria-label="Remove" data-tip="Remove">${icon('close')}</button>`;
  row.querySelector('.row-video').addEventListener('click', (e) => { e.stopPropagation(); const song = songById(row.dataset.id); if (song) openSongSheet(song); });
  const title = row.querySelector('.f-title'), artist = row.querySelector('.f-artist');
  const commit = (field, input) => { const song = songById(row.dataset.id); if (!song) return; const v = input.value.trim(); if (song[field] !== v) { song[field] = v; if (!song.cover) hydrateSong(song); invalidate(); } };
  title.addEventListener('input', () => commit('title', title));
  artist.addEventListener('input', () => commit('artist', artist));
  for (const inp of [title, artist]) {
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') inp.blur(); e.stopPropagation(); });
    inp.addEventListener('focus', () => inp.select());
  }
  row.querySelector('.remove').addEventListener('click', () => removeSong(row.dataset.id));
  row.querySelector('.thumb').addEventListener('click', (e) => {
    const song = songById(row.dataset.id); if (!song || song.uploading) return;
    selectRow(song.id);
    menu.open(e.currentTarget, songMenuItems(song));
  });
  row.addEventListener('click', (e) => {
    if (e.target.closest('button, input')) return;
    const song = songById(row.dataset.id); if (!song) return;
    selectRow(song.id);
    if (song.uploading || song.error) return;
    const i = preview.renderer.songs.indexOf(song);
    if (i >= 0) { seek(preview.renderer.timeline.segs[i].start); if (e.target.closest('.index') && song.ready && !player.playing) play(); }
  });
  row.addEventListener('contextmenu', (e) => {
    const song = songById(row.dataset.id); if (!song || song.uploading) return;
    e.preventDefault();
    selectRow(song.id);
    const anchor = { getBoundingClientRect: () => ({ left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY, width: 0, height: 0 }), setAttribute() {}, removeAttribute() {} };
    menu.open(anchor, songMenuItems(song));
  });
  row.addEventListener('dragover', (e) => { if (hasImage(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; row.classList.add('is-cover-target'); } });
  row.addEventListener('dragleave', () => row.classList.remove('is-cover-target'));
  row.addEventListener('drop', (e) => { const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); row.classList.remove('is-cover-target'); if (f) { e.preventDefault(); e.stopPropagation(); const song = songById(row.dataset.id); if (song && !song.uploading) setCover(song, f); } });
  row.querySelector('.grip').addEventListener('pointerdown', startDrag);
  return row;
}
function songMenuItems(song) {
  const items = [{ label: 'Cover art…', icon: 'image', action: () => openArtSheet(song) }, { label: 'Trim…', icon: 'scissors', action: () => openTrimSheet(song) }, { label: 'Song settings…', icon: 'video', action: () => openSongSheet(song) }, { label: 'Export only this song…', icon: 'export', action: () => startExport({ only: song }) }];
  if (song.customCover) items.push({ label: 'Use the original art', icon: 'reset', action: () => resetCover(song) });
  items.push({ label: 'Use the file’s title and artist', icon: 'reset', action: () => restoreTags(song) });
  items.push('-', { label: 'Remove song', icon: 'close', danger: true, action: () => removeSong(song.id) });
  return items;
}
let selectedId = null;
let job = null; // the running export
let vizDrag = null; // a drag in progress on the preview
let selected = null; // the element selected in the preview, for arrow-key nudging
function selectRow(id) {
  selectedId = id;
  for (const [rid, row] of rows) row.classList.toggle('is-selected', rid === id);
  const row = id && rowOf(id);
  if (row) row.scrollIntoView({ block: 'nearest' });
}
function selectedIndex() { return state.songs.findIndex((s) => s.id === selectedId); }
function moveSelected(delta) {
  const i = selectedIndex(); if (i < 0) return;
  const j = clamp(i + delta, 0, state.songs.length - 1); if (j === i) return;
  const [song] = state.songs.splice(i, 1);
  state.songs.splice(j, 0, song);
  renderTracks(); invalidate(); selectRow(song.id);
}
function updateRow(s) {
  const row = rowOf(s.id); if (!row) return;
  row.classList.toggle('is-selected', s.id === selectedId);
  const i = state.songs.indexOf(s);
  row.classList.toggle('is-uploading', !!s.uploading);
  row.classList.toggle('has-error', !!s.error);
  const idx = row.querySelector('.index'), num = idx.querySelector('.num');
  const playable = preview.renderer && preview.renderer.songs.indexOf(s) === currentSongIndex();
  if (playable && !s.uploading && !s.error) { if (!num.querySelector('.eq')) num.innerHTML = '<span class="eq"><i></i><i></i><i></i></span>'; }
  else num.textContent = String(i + 1);
  row.classList.toggle('can-play', !!s.ready && !s.error && !s.uploading);
  const vb = row.querySelector('.row-video');
  if (vb) { // lit only when the song's video is really there; quiet while it is being prepared; red when it failed
    const vs = songVideoState(s), where = { background: 'behind the song', art: 'in the artwork', both: 'behind and in the artwork' }[s.videoUse] || '';
    vb.hidden = false;
    vb.classList.toggle('is-on', vs.status === 'ready'); vb.classList.toggle('is-busy', vs.status === 'preparing'); vb.classList.toggle('is-error', vs.status === 'error');
    vb.classList.toggle('has-source', !!s.videoSource);
    vb.dataset.tip = vs.status === 'ready' ? `Video ${where} · Song settings…` : vs.status === 'preparing' ? `Video ${where}: being prepared… · Song settings…` : vs.status === 'error' ? `The video could not be prepared${vs.error ? `: ${vs.error}` : ''} · Song settings…` : vs.status === 'missing' ? 'Video chosen but none given yet · Song settings…' : s.videoSource ? 'This song comes with a video · Song settings…' : 'Song settings…';
  }
  row.classList.toggle('is-current', !!playable);
  row.classList.toggle('is-playing', !!playable && player.playing);
  const t = row.querySelector('.f-title'), a = row.querySelector('.f-artist');
  if (document.activeElement !== t && t.value !== (s.title || '')) t.value = s.title || '';
  if (document.activeElement !== a && a.value !== (s.artist || '')) a.value = s.artist || '';
  const dur = row.querySelector('.dur');
  if (s.uploading) dur.innerHTML = `<svg class="spin">${'<use href="#i-spinner"/>'}</svg>`;
  else if (s.error) { dur.textContent = 'Error'; dur.dataset.tip = s.error; }
  else if (!s.ready) dur.innerHTML = `<span>${formatTime(songLength(s))}</span><svg class="spin" data-tip="Preparing audio">${'<use href="#i-spinner"/>'}</svg>`;
  else {
    const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const midi = s.midi ? `<span class="midi-mark" data-tip="${esc(s.midi.about ? `From a MIDI file, rendered with ${s.midi.about}` : 'From a MIDI file')}">MIDI</span>` : '';
    const mark = midi + (state.dancers.length && dancerActive(s, state.dance) === true ? '<svg class="dance-mark" data-tip="The dancers appear on this track"><use href="#i-dancer"/></svg>' : '');
    if (s.trim) { dur.innerHTML = `${mark}<svg class="trim-mark"><use href="#i-scissors"/></svg><span></span>`; dur.lastChild.textContent = formatTime(songLength(s)); dur.dataset.tip = `Trimmed from ${formatTime(s.duration)}`; }
    else { dur.innerHTML = `${mark}<span></span>`; dur.lastChild.textContent = formatTime(s.duration); delete dur.dataset.tip; }
  }
  let bar = row.querySelector('.upload-bar');
  if (s.uploading && !bar) { bar = el('div', 'upload-bar'); row.append(bar); }
  if (!s.uploading && bar) bar.remove();
}
function updateExportState() {
  const ready = state.songs.some((s) => s.ready && !s.error && !s.uploading);
  const b = $('#exportBtn');
  b.classList.toggle('is-disabled', !ready && !job);
  b.setAttribute('aria-disabled', String(!ready && !job));
  b.dataset.tip = ready ? `Export the video (${KEYS('⌘E')})` : 'Add a song to export';
}
function renderTracks() {
  const seen = new Set();
  let prev = null;
  for (const s of state.songs) {
    let row = rows.get(s.id);
    if (!row) { row = buildRow(s); rows.set(s.id, row); if (s.image) setRowThumb(row, s); }
    if (prev ? prev.nextSibling !== row : trackList.firstChild !== row) trackList.insertBefore(row, prev ? prev.nextSibling : trackList.firstChild);
    updateRow(s);
    seen.add(s.id);
    prev = row;
  }
  for (const [id, row] of rows) if (!seen.has(id)) { row.remove(); rows.delete(id); }
  const n = state.songs.filter((s) => !s.error && !s.uploading).length;
  const total = state.songs.reduce((a, s) => a + (s.error || s.uploading ? 0 : songLength(s)), 0);
  $('#tracksMeta').textContent = n ? `${n} · ${formatTime(total)}` : '';
  updateExportState();
  updateScrollFades();
}
function pickCover(song) {
  const input = $('#coverInput');
  input.onchange = () => { const f = input.files[0]; input.value = ''; if (f) setCover(song, f); };
  input.click();
}
const hasImage = (dt) => dt && [...(dt.items || [])].some((it) => it.kind === 'file' && it.type.startsWith('image/'));

// drag to reorder (pointer based, FLIP-style)
function startDrag(e) {
  if (e.button !== 0) return;
  const row = e.currentTarget.closest('.track');
  const id = row.dataset.id;
  const song = songById(id); if (!song || song.uploading) return;
  e.preventDefault();
  const grip = e.currentTarget;
  try { grip.setPointerCapture(e.pointerId); } catch { /* synthetic events have no capturable pointer */ }
  const startY = e.clientY;
  const items = [...trackList.children];
  const from = items.indexOf(row);
  const rects = items.map((r) => r.getBoundingClientRect());
  const pitch = items.length > 1 ? rects[1].top - rects[0].top : rects[0].height;
  let to = from, active = false;
  const move = (ev) => {
    const dy = ev.clientY - startY;
    if (!active) { if (Math.abs(dy) < 4) return; active = true; row.classList.add('is-dragging'); document.body.style.cursor = 'grabbing'; for (const r of items) if (r !== row) r.classList.add('is-shifting'); }
    const maxDown = (items.length - 1 - from) * pitch, maxUp = -from * pitch;
    const d = clamp(dy, maxUp - 24, maxDown + 24);
    row.style.transform = `translateY(${d}px)`;
    to = clamp(Math.round(from + d / pitch), 0, items.length - 1);
    items.forEach((r, i) => {
      if (r === row) return;
      let shift = 0;
      if (from < to && i > from && i <= to) shift = -pitch;
      else if (from > to && i >= to && i < from) shift = pitch;
      r.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  };
  const up = () => {
    grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
    document.body.style.cursor = '';
    if (!active) return;
    // FLIP: apply the reorder, then keep the visual positions and let them settle
    const before = new Map(items.map((r) => [r, r.getBoundingClientRect().top]));
    for (const r of items) { r.style.transform = ''; r.classList.remove('is-shifting'); }
    row.classList.remove('is-dragging');
    const moved = state.songs.splice(from, 1)[0];
    state.songs.splice(to, 0, moved);
    renderTracks();
    for (const r of items) {
      const after = r.getBoundingClientRect().top, delta = before.get(r) - after;
      if (Math.abs(delta) < 0.5) continue;
      r.style.transition = 'none'; r.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => { r.style.transition = ''; r.classList.add('is-shifting'); r.style.transform = ''; setTimeout(() => r.classList.remove('is-shifting'), 220); });
    }
    invalidate();
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
}

// ---------------------------------------------------------------- preview + player
const preview = { renderer: null, canvas: $('#previewCanvas'), w: 0, h: 0 };
const player = { t: 0, playing: false, audio: [new Audio(), new Audio()], active: 0, raf: 0, lastPerf: 0 };
for (const a of player.audio) { a.preload = 'auto'; a.dataset.id = ''; }
const timeline = () => (preview.renderer ? preview.renderer.timeline : null);
const currentSongIndex = () => (preview.renderer && preview.renderer.songs.length ? timeline().indexAt(player.t) : -1);

function fitPreview() {
  const frame = $('#stageFrame');
  const cs = getComputedStyle(frame);
  const aw = frame.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const ah = frame.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (aw <= 0 || ah <= 0) return;
  const ar = state.output.width / state.output.height;
  let w = aw, h = w / ar;
  if (h > ah) { h = ah; w = h * ar; }
  w = Math.floor(w); h = Math.floor(w / ar);
  const box = $('#preview');
  box.style.width = `${w}px`; box.style.height = `${h}px`;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.min(2560, Math.round(w * dpr)), ph = Math.round(pw / ar);
  if (!preview.renderer) { preview.renderer = new Renderer(pw, ph, preview.canvas); preview.renderer.videoProvider = previewProvider; }
  else preview.renderer.resize(pw, ph);
  preview.renderer.setProject(state);
  render();
}
let renderQueued = false;
// Draws the preview exactly as the export will: at the time of the output frame the playhead is in (not the
// playhead's own instant), with the same frame index for the grain and the same decoded video frames. When a
// video's frame is not decoded yet the draw waits for it; a newer request supersedes an older one.
let renderToken = 0;
function render() {
  if (!preview.renderer) return;
  // Paused at the very start, show the settled first frame as a poster instead of the fade-from-black.
  const tl = preview.renderer.timeline, fps = state.output.fps || 30;
  const tt = !player.playing && player.t === 0 && tl.total ? Math.min(tl.total, Math.max(tl.fadeIn, 1.25)) : player.t;
  const frame = Math.floor(tt * fps + 1e-6), t = frame / fps;
  const token = ++renderToken;
  const draw = () => { if (token !== renderToken || !preview.renderer) return; preview.renderer.draw(t, frame); if (selected && !vizDrag) showSelectedHandle(); };
  if (previewVideos.size && !videoFramesReady(t)) { renderStats.waited++; prepareVideoFrames(t).then(draw, draw); } else { renderStats.sync++; draw(); }
}
function invalidate() {
  if (!preview.renderer) return;
  preview.renderer.setProject(state);
  const tl = timeline();
  if (player.t > tl.total) player.t = tl.total;
  if (!renderQueued) { renderQueued = true; requestAnimationFrame(() => { renderQueued = false; if (!player.playing) render(); }); }
  if (!uiQueued) { uiQueued = true; requestAnimationFrame(() => { uiQueued = false; updateTransport(); updateTint(); renderTracks(); updateEstimate(); updateResetButtons(); }); } // once per frame, however many changes a drag makes
  if (state.dancers.length) ensureAnalyses();
  if (state.viz.style !== 'off') ensureSpectra();
  if (state.look.progress === 'wave') ensureWaveforms();
  save();
}
let uiQueued = false;
const previewUrl = (s) => `/api/songs/${s.id}/preview.m4a`;
// preview volume around trimmed cuts (the export applies the same equal-power fade to the PCM)
function fadeGain(song, pos) {
  const t = song.trim;
  if (!t || !t.fade) return 1;
  const F = 1, start = trimStart(song), end = t.end == null ? song.duration : Math.min(t.end, song.duration);
  let g = 1;
  if (start > 0 && pos < start + F) g = Math.sin(clamp01((pos - start) / F) * Math.PI / 2);
  if (end < song.duration - 0.01 && pos > end - F) g = Math.min(g, Math.sin(clamp01((end - pos) / F) * Math.PI / 2));
  return clamp01(g);
}
// The audio elements follow the playhead: the song playing at t, or, inside a crossfade, both songs with equal-power
// gains (the outgoing one on cos, the incoming one on sin), each on its own element and seeked when it drifts.
// A song's own volume goes through its element's gain node (so it can be louder than the file); the free element
// preloads the next song. The visual clock follows the newest audible song.
function syncAudio(force) {
  const r = preview.renderer; if (!r) return;
  const tl = r.timeline, master = playerVolume.muted ? 0 : playerVolume.level;
  const audible = [];
  for (let i = 0; i < tl.segs.length; i++) { const seg = tl.segs[i]; if (player.t >= seg.start && player.t < seg.end && r.songs[i].ready) audible.push({ song: r.songs[i], idx: i, seg, gain: 1 }); }
  if (audible.length >= 2) {
    const a = audible[audible.length - 2], b = audible[audible.length - 1];
    const u = b.seg.overlap > 0 ? clamp01((player.t - b.seg.start) / b.seg.overlap) : 1;
    a.gain = Math.cos((u * Math.PI) / 2); b.gain = Math.sin((u * Math.PI) / 2);
  }
  const taken = new Set();
  for (const item of audible) {
    let k = player.audio.findIndex((el) => el.dataset.id === item.song.id);
    if (k < 0) { k = player.audio.findIndex((el, j) => !taken.has(j) && !audible.some((o) => o.song.id === el.dataset.id)); if (k < 0) k = player.audio.findIndex((el, j) => !taken.has(j)); const el = player.audio[k]; el.dataset.id = item.song.id; el.src = previewUrl(item.song); el.load(); }
    taken.add(k);
    const el = player.audio[k];
    const want = trimStart(item.song) + (player.t - item.seg.start);
    if (force || Math.abs(el.currentTime - want) > 0.3) { try { el.currentTime = want; } catch { /* not ready yet */ } }
    const own = Math.pow(10, (item.song.volume || 0) / 20), g = audioGraph.gains.get(el);
    if (g) { if (Math.abs(g.gain.value - own) > 1e-4) g.gain.value = own; el.volume = fadeGain(item.song, want) * item.gain * master; }
    else el.volume = Math.min(1, fadeGain(item.song, want) * item.gain * master * own); // no audio graph: only quieter is possible
    if (player.playing && el.paused) el.play().catch(() => {});
    if (!player.playing && !el.paused) el.pause();
  }
  for (let j = 0; j < player.audio.length; j++) if (!taken.has(j) && !player.audio[j].paused) player.audio[j].pause();
  if (audible.length) player.active = player.audio.findIndex((el) => el.dataset.id === audible[audible.length - 1].song.id);
  // preload the next song into the free element
  const cur = audible.length ? audible[audible.length - 1].idx : tl.indexAt(player.t);
  const next = r.songs[cur + 1], free = player.audio.findIndex((el, j) => !taken.has(j));
  if (next && next.ready && free >= 0 && player.audio[free].dataset.id !== next.id && !audible.some((o) => o.song.id === next.id)) { const idle = player.audio[free]; idle.dataset.id = next.id; idle.src = previewUrl(next); idle.load(); }
}
const playerVolume = (() => { try { return { level: 1, muted: false, ...(JSON.parse(localStorage.getItem('liner.volume')) || {}) }; } catch { return { level: 1, muted: false }; } })();
function applyVolume() {
  for (const a of player.audio) a.volume = playerVolume.muted ? 0 : playerVolume.level; // fades at trimmed cuts are re-applied every frame in syncAudio
  $('#muteBtn').classList.toggle('is-muted', playerVolume.muted || playerVolume.level === 0);
  $('#muteBtn').dataset.tip = playerVolume.muted ? 'Unmute (M)' : 'Mute (M)';
  $('#volumeRange').value = String(playerVolume.level);
  $('#volumeRange').style.setProperty('--p', `${playerVolume.level * 100}%`);
  localStorage.setItem('liner.volume', JSON.stringify(playerVolume));
}
function seek(t) {
  const tl = timeline(); if (!tl) return;
  player.t = clamp(t, 0, tl.total);
  syncAudio(true);
  updateHeadroomGain();
  render();
  updateTransport();
  updateTint();
  renderTracks();
}
function play() {
  const tl = timeline(); if (!tl || !tl.total) return;
  if (player.t >= tl.total - 0.02) player.t = 0;
  player.playing = true;
  player.lastPerf = performance.now();
  const actx = ensureAudioGraph();
  if (actx && actx.state === 'suspended') actx.resume().catch(() => {});
  syncAudio(true);
  $('#playBtn').classList.add('is-playing'); $('#playBtn').setAttribute('aria-label', 'Pause'); $('#playBtn').dataset.tip = 'Pause (Space)';
  renderTracks();
  cancelAnimationFrame(player.raf);
  const step = (now) => {
    if (!player.playing) return;
    const dt = Math.min(0.25, (now - player.lastPerf) / 1000); player.lastPerf = now;
    const r = preview.renderer, tl = r.timeline;
    const idx = tl.songAtAudioTime(player.t);
    const a = player.audio[player.active];
    // the visual clock always runs at wall-clock rate and is only nudged towards the audio clock, so the picture never
    // freezes or steps while a freshly started audio element is still spinning up
    let next = player.t + dt;
    if (idx >= 0 && a.dataset.id === r.songs[idx].id && !a.paused && !a.seeking && a.readyState >= 2) {
      const target = tl.segs[idx].start + a.currentTime - trimStart(r.songs[idx]);
      const drift = target - next;
      next = Math.abs(drift) > 0.6 ? target : next + drift * 0.08;
    }
    player.t = Math.max(player.t, next);
    if (player.t >= tl.total) { player.t = tl.total; pause(); render(); updateTransport(); return; }
    const before = tl.indexAt(player.t - dt);
    syncAudio(false);
    // draw only when the project's next frame has come round: the preview then shows exactly the export's frames,
    // and a 60 or 120 Hz display no longer costs two to four times the work of the 30 fps video it is previewing
    const fps = state.output.fps || 30, frame = Math.floor(player.t * fps);
    if (frame !== player.lastFrame) { player.lastFrame = frame; render(); updateTransport(); if (previewVideos.size) primeVideoFrames((frame + 1) / fps); }
    if (tl.indexAt(player.t) !== before) { updateTint(); renderTracks(); updateHeadroomGain(); }
    player.raf = requestAnimationFrame(step);
  };
  player.lastFrame = -1;
  player.raf = requestAnimationFrame(step);
}
function pause() {
  player.playing = false;
  cancelAnimationFrame(player.raf);
  for (const a of player.audio) if (!a.paused) a.pause();
  $('#playBtn').classList.remove('is-playing'); $('#playBtn').setAttribute('aria-label', 'Play'); $('#playBtn').dataset.tip = 'Play (Space)';
  renderTracks();
}
$('#playBtn').addEventListener('click', () => (player.playing ? pause() : play()));

// preview bass processing with Web Audio: mirrors the export's ffmpeg chain closely enough to judge the setting
const audioGraph = { ctx: null, sources: new Map(), gains: new Map(), input: null, nodes: [] };
function ensureAudioGraph() {
  if (audioGraph.ctx) return audioGraph.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  audioGraph.ctx = ctx;
  audioGraph.input = ctx.createGain();
  for (const el of player.audio) {
    try { const src = ctx.createMediaElementSource(el), g = ctx.createGain(); src.connect(g); g.connect(audioGraph.input); audioGraph.sources.set(el, src); audioGraph.gains.set(el, g); }
    catch (e) { console.warn('audio graph: could not attach', e); }
  }
  applyAudioGraph();
  return ctx;
}
function applyAudioGraph() {
  const ctx = audioGraph.ctx; if (!ctx) return;
  for (const n of audioGraph.nodes) { try { n.disconnect(); } catch {} }
  audioGraph.nodes = [];
  try { audioGraph.input.disconnect(); } catch {}
  const { bass, gain } = state.audio;
  const keep = (n) => { audioGraph.nodes.push(n); return n; };
  if (bass === 'boost' && gain > 0) {
    const shelf = keep(ctx.createBiquadFilter()); shelf.type = 'lowshelf'; shelf.frequency.value = 200; shelf.gain.value = gain;
    audioGraph.input.connect(shelf); shelf.connect(ctx.destination);
  } else if (bass === 'smart2' && gain > 0) {
    const shelf = keep(ctx.createBiquadFilter()); shelf.type = 'lowshelf'; shelf.frequency.value = 160; shelf.gain.value = gain;
    const trim = keep(ctx.createGain()); trim.gain.value = Math.pow(10, -gain / 20); // conservative until the song's measurement arrives
    const limiter = keep(ctx.createDynamicsCompressor()); limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.08;
    audioGraph.input.connect(shelf); shelf.connect(trim); trim.connect(limiter); limiter.connect(ctx.destination);
    audioGraph.trim = trim;
    updateHeadroomGain();
  } else if (bass === 'smart' && gain > 0) {
    const lp1 = keep(ctx.createBiquadFilter()), lp2 = keep(ctx.createBiquadFilter()), hp1 = keep(ctx.createBiquadFilter()), hp2 = keep(ctx.createBiquadFilter());
    for (const f of [lp1, lp2]) { f.type = 'lowpass'; f.frequency.value = 150; f.Q.value = Math.SQRT1_2; }
    for (const f of [hp1, hp2]) { f.type = 'highpass'; f.frequency.value = 150; f.Q.value = Math.SQRT1_2; }
    const lift = keep(ctx.createGain()); lift.gain.value = Math.pow(10, gain / 20);
    const comp = keep(ctx.createDynamicsCompressor()); comp.threshold.value = -6; comp.knee.value = 6; comp.ratio.value = 2; comp.attack.value = 0.01; comp.release.value = 0.2;
    const sum = keep(ctx.createGain());
    const limiter = keep(ctx.createDynamicsCompressor()); limiter.threshold.value = -1; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.002; limiter.release.value = 0.06;
    audioGraph.input.connect(lp1); lp1.connect(lp2); lp2.connect(lift); lift.connect(comp); comp.connect(sum);
    audioGraph.input.connect(hp1); hp1.connect(hp2); hp2.connect(sum);
    sum.connect(limiter); limiter.connect(ctx.destination);
  } else {
    audioGraph.input.connect(ctx.destination);
  }
  if (bass !== 'smart2') audioGraph.trim = null;
}
// Smart boost 2: the song playing now is turned down by the amount its bass needs (measured once per song and strength)
const headroomCache = new Map();
async function headroomFor(song, gain) {
  const key = `${song.id}:${gain}`;
  if (!headroomCache.has(key)) {
    headroomCache.set(key, api.json(`/api/songs/${song.id}/headroom?gain=${gain}`).then((r) => r.gainDb).catch(() => { headroomCache.delete(key); return -gain; }));
  }
  return headroomCache.get(key);
}
async function updateHeadroomGain() {
  const node = audioGraph.trim, r = preview.renderer;
  if (!node || !r || !r.songs.length) return;
  const song = r.songs[Math.max(0, currentSongIndex())];
  if (!song || !song.ready) return;
  const gain = state.audio.gain;
  const db = await headroomFor(song, gain);
  if (audioGraph.trim !== node || state.audio.gain !== gain) return;
  const ctx = audioGraph.ctx, target = Math.pow(10, db / 20);
  node.gain.cancelScheduledValues(ctx.currentTime);
  node.gain.setTargetAtTime(target, ctx.currentTime, 0.03);
  // warm the next song's measurement so the change is seamless
  const next = r.songs[currentSongIndex() + 1];
  if (next && next.ready) headroomFor(next, gain);
}

// tint: the UI accent follows the current song's artwork
let tint = { from: [0.94, 0.70, 0.36], to: [0.94, 0.70, 0.36], t0: 0, raf: 0 };
function updateTint() {
  const r = preview.renderer; if (!r) return;
  const i = currentSongIndex();
  const target = i >= 0 && r.songs[i] && r.songs[i].palette ? r.songs[i].palette.accent : [0.94, 0.70, 0.36];
  if (target.every((v, k) => Math.abs(v - tint.to[k]) < 1e-3)) return;
  const now = performance.now();
  const cur = currentTint(now);
  cancelAnimationFrame(tint.raf);
  tint = { from: cur, to: target, t0: now, raf: 0 };
  const step = (t) => { document.documentElement.style.setProperty('--accent', rgbHex(currentTint(t))); if (t - tint.t0 < 600) tint.raf = requestAnimationFrame(step); else drawScrubber(); };
  tint.raf = requestAnimationFrame(step);
}
function currentTint(now) { const k = clamp01((now - tint.t0) / 600); const e = 1 - Math.pow(1 - k, 3); return tint.from.map((v, i) => v + (tint.to[i] - v) * e); }

// transport
const scrub = { el: $('#scrubber'), canvas: $('#scrubCanvas'), knob: $('#scrubKnob'), tip: $('#scrubTip'), dragging: false };
function updateTransport() {
  const tl = timeline(); const total = tl ? tl.total : 0;
  const fps = state.output.fps || 30, base = formatTime(player.t, { forceHours: total >= 3600 });
  $('#timeNow').textContent = player.playing ? base : `${base}.${String(Math.floor(player.t * fps + 1e-6) % fps).padStart(String(fps - 1).length, '0')}`; // paused: the frame within the second
  $('#timeTotal').textContent = formatTime(total, { forceHours: total >= 3600 });
  scrub.el.setAttribute('aria-valuemax', String(Math.round(total)));
  scrub.el.setAttribute('aria-valuenow', String(Math.round(player.t)));
  const frac = total ? player.t / total : 0;
  scrub.knob.style.left = `${(frac * 100).toFixed(3)}%`;
  drawScrubber();
}
function drawScrubber() {
  const c = scrub.canvas, w = scrub.el.clientWidth, h = scrub.el.clientHeight;
  if (!w || !h) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const tl = timeline(); const total = tl ? tl.total : 0;
  const y = h / 2 - 2, bh = 4;
  const rr = (px, py, pw, ph, r) => { x.beginPath(); x.roundRect(px, py, Math.max(0, pw), ph, r); };
  rr(0, y, w, bh, 2); x.fillStyle = 'rgba(255,255,255,0.14)'; x.fill();
  if (!total) return;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f0b35c';
  const frac = player.t / total;
  rr(0, y, w * frac, bh, 2); x.fillStyle = accent; x.fill();
  x.fillStyle = '#0a0a0c';
  for (let i = 1; i < tl.segs.length; i++) { const px = Math.round((tl.segs[i].start - tl.gap / 2) / total * w); x.fillRect(px - 1, y - 1, 2, bh + 2); }
}
function scrubAt(clientX) { const r = scrub.el.getBoundingClientRect(); return clamp01((clientX - r.left) / r.width); }
scrub.el.addEventListener('pointerdown', (e) => {
  const tl = timeline(); if (!tl || !tl.total) return;
  scrub.dragging = true; scrub.el.classList.add('is-scrubbing'); scrub.el.setPointerCapture(e.pointerId);
  const wasPlaying = player.playing; if (wasPlaying) pause();
  const move = (ev) => { const f = scrubAt(ev.clientX); seek(f * tl.total); showScrubTip(ev.clientX); };
  const up = () => { scrub.dragging = false; scrub.el.classList.remove('is-scrubbing'); scrub.el.removeEventListener('pointermove', move); scrub.el.removeEventListener('pointerup', up); scrub.el.removeEventListener('pointercancel', up); if (wasPlaying) play(); };
  scrub.el.addEventListener('pointermove', move); scrub.el.addEventListener('pointerup', up); scrub.el.addEventListener('pointercancel', up);
  move(e);
});
scrub.el.addEventListener('pointermove', (e) => { if (!scrub.dragging) showScrubTip(e.clientX); });
function showScrubTip(clientX) {
  const tl = timeline(); if (!tl || !tl.total) return;
  const f = scrubAt(clientX), t = f * tl.total;
  const i = tl.indexAt(t);
  const s = preview.renderer.songs[i];
  scrub.tip.querySelector('b').textContent = formatTime(t, { forceHours: tl.total >= 3600 });
  scrub.tip.querySelector('span').textContent = s ? (s.title || 'Untitled') : '';
  scrub.tip.style.left = `${(f * 100).toFixed(3)}%`;
}
scrub.el.addEventListener('keydown', (e) => {
  const tl = timeline(); if (!tl) return;
  if (e.key === 'ArrowLeft') { seek(player.t - (e.shiftKey ? 30 : 5)); e.preventDefault(); }
  if (e.key === 'ArrowRight') { seek(player.t + (e.shiftKey ? 30 : 5)); e.preventDefault(); }
});

// ---------------------------------------------------------------- inspector
function paintSeg(seg, value, animate = true) {
  const buttons = $$('button', seg);
  const sel = buttons.find((b) => b.dataset.value === String(value)) || buttons[0];
  seg.classList.toggle('no-anim', !animate);
  buttons.forEach((b) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(b === sel)); });
  const th = seg.querySelector('.seg-thumb');
  if (th && sel) { th.style.width = `${sel.offsetWidth}px`; th.style.transform = `translateX(${sel.offsetLeft}px)`; }
  if (!animate) requestAnimationFrame(() => seg.classList.remove('no-anim'));
}
function bindSeg(seg) {
  const path = seg.dataset.seg, buttons = $$('button', seg);
  const apply = (animate = true) => paintSeg(seg, getPath(state, path), animate);
  buttons.forEach((b) => b.addEventListener('click', () => {
    const raw = b.dataset.value; const cur = getPath(state, path);
    const v = typeof cur === 'number' ? Number(raw) : raw;
    if (v === cur) return;
    setPath(state, path, v); apply(); onChange(path);
  }));
  seg._apply = apply;
  apply(false);
}
function initSegs() { for (const seg of $$('[data-seg]')) bindSeg(seg); }
function refreshSegs() { for (const seg of $$('[data-seg]')) seg._apply && seg._apply(false); }
function bindSwitch(sw) {
  const path = sw.dataset.switch;
  sw.checked = !!getPath(state, path);
  sw.addEventListener('change', () => { setPath(state, path, sw.checked); onChange(path); });
}
function initSwitches() { for (const sw of $$('[data-switch]')) bindSwitch(sw); }
function syncControls() { // push the whole state into the inspector (after a preset or a mix switch)
  refreshSegs();
  for (const sw of $$('[data-switch]')) sw.checked = !!getPath(state, sw.dataset.switch);
  for (const r of $$('[data-range]')) { r.value = getPath(state, r.dataset.range); r.dispatchEvent(new Event('paint')); }
  $('#presetSelect').value = state.output.preset; $('#sizePair').hidden = state.output.preset !== 'custom';
  $('#widthInput').value = state.output.width; $('#heightInput').value = state.output.height;
  $('#fileNameInput').value = state.output.fileName || ''; $('#fileNameInput').placeholder = state.title || 'Untitled mix';
  $('#projectTitle').value = state.title || ''; $('#subtitleInput').value = state.subtitle || '';
  $('#styleHint').textContent = STYLE_HINTS[state.look.style];
  for (const pl of $$('.places')) pl._apply && pl._apply();
  updateBassUI(); applyAudioGraph(); updateDanceUI(); updateVizUI(); updateTimingUI();
}
function fmtVal(path, v) {
  if (path === 'look.grain' || path === 'look.videoBlur') return `${Math.round(v * 100)}%`;
  if (path === 'audio.gain') return `+${Math.round(v)} dB`;
  if (path === 'look.dim') return `${Math.round(v * 100)}%`;
  if (/^dancers\.\d+\.size$/.test(path)) return `${Math.round(v * 100)}%`;
  if (/^dancers\.\d+\.speed$/.test(path)) return `${(+v).toFixed(2).replace(/\.?0+$/, '')}×`;
  if (path === 'dance.sensitivity') return SENS_WORDS[Math.round(v * 4)];
  if (path === 'viz.size' || path === 'viz.w' || path === 'logo.size' || path === 'logo.opacity' || /^captions\.\d+\.(size|opacity)$/.test(path)) return `${Math.round(v * 100)}%`;
  if (path === 'viz.level') return `${(+v).toFixed(2).replace(/\.?0+$/, '')}×`;
  return `${(+v).toFixed(1)} s`;
}
function unitFor(path) { // how a slider's number is shown, and how a typed number maps back
  if (path === 'audio.gain') return { suffix: ' dB', scale: 1 };
  if (/\.speed$/.test(path)) return { suffix: '×', scale: 1 };
  if (path === 'dance.sensitivity' || path === 'look.grain' || path === 'look.videoBlur' || path === 'look.dim' || path === 'viz.size' || path === 'viz.w' || path === 'viz.level' || path === 'logo.size' || path === 'logo.opacity' || /^(dancers|captions)\.\d+\.(size|opacity)$/.test(path)) return path === 'viz.level' ? { suffix: '×', scale: 1 } : { suffix: '%', scale: 100 };
  return { suffix: ' s', scale: 1 };
}
function editValue(r, path, val) {
  if (val.querySelector('input')) return;
  const unit = unitFor(path), cur = getPath(state, path);
  const input = el('input', 'val-input'); input.type = 'text'; input.inputMode = 'decimal'; input.setAttribute('aria-label', 'Exact value');
  input.value = unit.scale === 100 ? String(Math.round(cur * 100)) : String(+(+cur).toFixed(2));
  val.textContent = ''; val.append(input); input.focus(); input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return; done = true;
    if (commit) {
      const n = parseFloat(String(input.value).replace(',', '.').replace(/[^\d.+-]/g, ''));
      if (Number.isFinite(n)) { const v = clamp(n / unit.scale, +r.min, +r.max); setPath(state, path, v); r.value = v; onChange(path); }
    }
    input.remove(); r.dispatchEvent(new Event('paint'));
  };
  input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}
function bindRange(r) {
  const path = r.dataset.range;
  const val = r.parentElement && r.parentElement.querySelector(`[data-val="${path}"]`) || $(`[data-val="${path}"]`);
  const paint = () => { const p = (r.value - r.min) / (r.max - r.min) * 100; r.style.setProperty('--p', `${p}%`); if (val && !val.querySelector('input')) val.textContent = fmtVal(path, r.value); };
  if (val && !val.dataset.editable && path !== 'dance.sensitivity') { val.dataset.editable = '1'; val.classList.add('val-edit'); val.tabIndex = 0; val.dataset.tip = 'Click to type a value'; val.addEventListener('click', () => editValue(r, path, val)); val.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); editValue(r, path, val); } }); }
  r.value = getPath(state, path); paint();
  r.addEventListener('paint', paint);
  r.addEventListener('input', () => { setPath(state, path, +r.value); paint(); onChange(path); });
  const def = defaultFor(path);
  if (typeof def === 'number') {
    if (!r.dataset.tip) r.dataset.tip = 'Double-click to reset';
    const reset = () => { if (same(getPath(state, path), def)) return; setPath(state, path, def); r.value = def; paint(); onChange(path); };
    r.addEventListener('dblclick', reset);
    r.addEventListener('pointerdown', (e) => { if (e.altKey) { e.preventDefault(); reset(); } });
  }
}
function initRanges() { for (const r of $$('[data-range]')) bindRange(r); }
function initSelects() {
  const sel = $('#presetSelect');
  sel.value = state.output.preset;
  sel.addEventListener('change', () => { state.output.preset = sel.value; if (PRESETS[sel.value]) { [state.output.width, state.output.height] = PRESETS[sel.value]; } onChange('output.preset'); });
  const w = $('#widthInput'), h = $('#heightInput');
  w.value = state.output.width; h.value = state.output.height;
  const commitSize = () => {
    const W = clamp(Math.round(+w.value / 2) * 2 || 1920, 160, 8192), H = clamp(Math.round(+h.value / 2) * 2 || 1080, 90, 8192);
    w.value = W; h.value = H; state.output.width = W; state.output.height = H; onChange('output.size');
  };
  for (const inp of [w, h]) { inp.addEventListener('change', commitSize); inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); }); }
  $('#sizePair').hidden = state.output.preset !== 'custom';
}
function initText() {
  const f = $('#fileNameInput');
  f.value = state.output.fileName;
  f.addEventListener('input', () => { state.output.fileName = f.value; save(); });
  f.addEventListener('keydown', (e) => { if (e.key === 'Enter') f.blur(); e.stopPropagation(); });
  const t = $('#projectTitle');
  t.value = state.title;
  t.addEventListener('input', () => { state.title = t.value.trim(); $('#fileNameInput').placeholder = state.title || 'Untitled mix'; invalidate(); });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') t.blur(); e.stopPropagation(); });
  $('#fileNameInput').placeholder = state.title || 'Untitled mix';
  const sub = $('#subtitleInput');
  sub.value = state.subtitle || '';
  sub.addEventListener('input', () => { state.subtitle = sub.value.trim(); invalidate(); });
  sub.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') sub.blur(); e.stopPropagation(); });
}
const STYLE_HINTS = { aurora: 'Flowing colour drawn from each song’s artwork.', cover: 'The artwork itself, softened and slowly drifting.', ink: 'Near-black, quiet. Lets the type and art speak.', video: 'A video of your own, playing on a loop behind everything. Its sound is ignored.' };
function onChange(path) {
  if (path === 'look.style') { $('#styleHint').textContent = STYLE_HINTS[state.look.style]; renderVideoUI(); hydrateVideo(); }
  if (path === 'look.motion') renderVideoUI();
  if (path === 'output.preset' || path === 'output.size' || path === 'output.fps') { $('#sizePair').hidden = state.output.preset !== 'custom'; $('#widthInput').value = state.output.width; $('#heightInput').value = state.output.height; fitPreview(); }
  if (path.startsWith('output.')) updateEstimate();
  if (path === 'output.audio') $('#audioHint').textContent = state.output.audio === 'alac' ? 'Apple Lossless, bit-exact from the decoded songs. Larger file; plays in QuickTime, VLC and on YouTube.' : 'Plays everywhere. Songs are joined without re-tuning.';
  if (path.startsWith('audio.')) { updateBassUI(); applyAudioGraph(); }
  if (path.startsWith('dance')) updateDanceUI();
  if (path.startsWith('timing.')) updateTimingUI();
  if (path === 'look.showNext' && state.look.showNext && state.songs.filter((x) => !x.error && !x.uploading).length < 2) toast('“Up next” names the following track under each song. Add a second song to see it.');
  if (path.startsWith('viz.')) updateVizUI();
  if (path === 'logo.place') renderLogoUI();
  invalidate();
}
function updateTimingUI() {
  const xf = +state.timing.crossfade || 0;
  $('#xfHint').hidden = !(xf > 0);
  $('#xfHint').textContent = xf > 0 ? `Each song starts ${xf} s before the one before it ends and the two blend into each other; the gap is skipped.` : '';
  $('#gapRange').closest('.row').classList.toggle('is-dim', xf > 0);
}
const BASS_HINTS = {
  off: '',
  boost: 'A plain lift of everything below about 200 Hz. Loud songs will clip at high strengths.',
  smart: 'The same lift, with the low end compressed and a limiter so nothing clips. Changes the feel of loud songs a little.',
  smart2: 'No compression at all: each song is turned down by exactly what its bass needs, then lifted. Dynamics and tone stay as recorded; the file plays a touch quieter, which streaming sites level out anyway.',
};
function updateBassUI() {
  const mode = state.audio.bass;
  $('#bassGainRow').hidden = mode === 'off';
  $('#bassHint').textContent = BASS_HINTS[mode] || '';
  $('#bassHint').hidden = mode === 'off';
}
function computeBitrate(o) {
  const px = o.width * o.height;
  const fpsF = Math.pow(o.fps / 30, 0.6);
  const bpp = 0.2 * (o.codec === 'hevc' ? 0.65 : 1);
  const q = { standard: 0.7, high: 1, max: 1.7 }[o.quality] || 1;
  return Math.round(clamp(px * 30 * bpp * fpsF * q, 2e6, 240e6));
}
function updateEstimate() {
  const o = state.output; const tl = timeline(); const total = tl ? tl.total : 0;
  const vbr = computeBitrate(o);
  const abr = o.audio === 'alac' ? 1400e3 : 320e3;
  $('#bitrateHint').textContent = `About ${(vbr / 1e6).toFixed(vbr >= 10e6 ? 0 : 1)} Mb/s of video${o.codec === 'hevc' ? ' (HEVC keeps more detail per bit)' : ''}.`;
  $('#sizeEstimate').textContent = total ? `≈ ${fmtBytes((vbr + abr) / 8 * total)}` : '—';
  $('#formatChip').textContent = `${o.height}p · ${o.fps} fps`;
}
let currentTab = 'look', tabsApply = null;
const paneScroll = {};
function selectTab(name) { if (tabsApply) { tabsApply(name); localStorage.setItem('liner.tab', name); } }
function initTabs() {
  const tabs = $$('.tabs [role=tab]'), ink = $('#tabInk'), scroller = $('.panel-inspector .panel-scroll');
  const apply = (name, animate = true) => {
    if (!tabs.some((t) => t.dataset.tab === name)) name = 'look';
    if (name !== currentTab) paneScroll[currentTab] = scroller.scrollTop;
    currentTab = name;
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    $$('.tab-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const t = tabs.find((x) => x.dataset.tab === name);
    if (!animate) ink.style.transition = 'none';
    ink.style.width = `${t.offsetWidth - 24}px`; ink.style.transform = `translateX(${t.offsetLeft + 12}px)`;
    if (!animate) requestAnimationFrame(() => { ink.style.transition = ''; });
    scroller.scrollTop = paneScroll[name] || 0;
    refreshSegs();
    animateThumbs();
    updateScrollFades();
  };
  tabsApply = apply;
  tabs.forEach((t) => t.addEventListener('click', () => { apply(t.dataset.tab); localStorage.setItem('liner.tab', t.dataset.tab); }));
  apply(localStorage.getItem('liner.tab') || 'look', false);
}

// ---------------------------------------------------------------- export
const caps = { server: null, webcodecs: 'VideoEncoder' in window, hevcBrowser: false, hevcServer: false };
function avcCodecString(w, h, fps) {
  const mbs = Math.ceil(w / 16) * Math.ceil(h / 16), mbps = mbs * fps;
  const levels = [[0x28, 8192, 245760], [0x2a, 8704, 522240], [0x32, 22080, 589824], [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3c, 139264, 4177920], [0x3d, 139264, 8355840], [0x3e, 139264, 16711680]];
  const lv = (levels.find(([, fs, r]) => mbs <= fs && mbps <= r) || levels[levels.length - 1])[0];
  return `avc1.6400${lv.toString(16).padStart(2, '0')}`;
}
function hevcCodecString(w, h, fps) {
  const lps = w * h * fps;
  const L = lps <= 62668800 ? 120 : lps <= 133693440 ? 123 : lps <= 267386880 ? 150 : lps <= 534773760 ? 153 : lps <= 1069547520 ? 156 : lps <= 2139095040 ? 180 : 186;
  return `hvc1.1.6.L${L}.B0`;
}
// WebCodecs encoders may return NAL units with 4-byte length prefixes (avcC / hvcC packaging) instead of Annex B start
// codes, and then keep the parameter sets in the decoder description. ffmpeg needs Annex B, so convert on the fly.
const NAL_START = new Uint8Array([0, 0, 0, 1]);
const isAnnexB = (b) => b.length >= 4 && b[0] === 0 && b[1] === 0 && (b[2] === 1 || (b[2] === 0 && b[3] === 1));
function parseParameterSets(d, codec) {
  const nals = [];
  const read16 = (p) => (d[p] << 8) | d[p + 1];
  try {
    if (codec === 'hevc') { // hvcC: 22-byte header, then arrays of NAL units (VPS, SPS, PPS…)
      const lengthSize = (d[21] & 3) + 1;
      let p = 23;
      for (let a = 0, n = d[22]; a < n; a++) { const cnt = read16(p + 1); p += 3; for (let k = 0; k < cnt; k++) { const len = read16(p); p += 2; nals.push(d.subarray(p, p + len)); p += len; } }
      return { nals, lengthSize };
    }
    const lengthSize = (d[4] & 3) + 1; // avcC
    let p = 6;
    for (let k = 0, n = d[5] & 31; k < n; k++) { const len = read16(p); p += 2; nals.push(d.subarray(p, p + len)); p += len; }
    for (let k = 0, n = d[p++]; k < n; k++) { const len = read16(p); p += 2; nals.push(d.subarray(p, p + len)); p += len; }
    return { nals, lengthSize };
  } catch { return { nals, lengthSize: 4 }; }
}
function toAnnexB(buf, isKey, ps) {
  const parts = []; let total = 0;
  if (isKey && ps) for (const n of ps.nals) { parts.push(NAL_START, n); total += 4 + n.length; }
  const ls = ps ? ps.lengthSize : 4;
  let p = 0;
  while (p + ls <= buf.length) {
    let n = 0; for (let k = 0; k < ls; k++) n = n * 256 + buf[p + k];
    p += ls;
    if (n <= 0 || p + n > buf.length) break;
    parts.push(NAL_START, buf.subarray(p, p + n)); total += 4 + n; p += n;
  }
  const out = new Uint8Array(total); let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}
function encoderConfig(o, hwPref = 'prefer-hardware') {
  const codec = o.codec === 'hevc' ? hevcCodecString(o.width, o.height, o.fps) : avcCodecString(o.width, o.height, o.fps);
  const cfg = { codec, width: o.width, height: o.height, bitrate: computeBitrate(o), framerate: o.fps, hardwareAcceleration: hwPref, latencyMode: 'quality', bitrateMode: 'variable' };
  const fmt = o.debugFormat === 'length' ? (o.codec === 'hevc' ? 'hevc' : 'avc') : 'annexb';
  if (o.codec === 'hevc') cfg.hevc = { format: fmt }; else cfg.avc = { format: fmt };
  return cfg;
}
async function probeEncoder(o) {
  if (!caps.webcodecs || typeof window.VideoEncoder !== 'function') return null;
  for (const hw of ['prefer-hardware', 'no-preference']) {
    try { const r = await VideoEncoder.isConfigSupported(encoderConfig(o, hw)); if (r && r.supported) return { config: r.config || encoderConfig(o, hw), hw }; } catch { /* try next */ }
  }
  return null;
}
async function detectCaps() {
  try { caps.server = await api.health(); } catch { caps.server = null; }
  if (caps.server && caps.server.version !== APP_VERSION) {
    if (cmpVersion(caps.server.version, APP_VERSION) > 0) toast('This page is from an older version of Liner than the server. Reload it to get the new features.', { error: true, duration: 20000, action: { label: 'Reload', run: () => location.reload() } });
    else toast('The Liner server is running an older version than this page. Stop it (Ctrl-C in the terminal where it runs), start it again, then reload.', { error: true, duration: 14000 });
  }
  if (caps.webcodecs) {
    try { const r = await VideoEncoder.isConfigSupported(encoderConfig({ width: 1920, height: 1080, fps: 30, codec: 'hevc', quality: 'high' })); caps.hevcBrowser = !!(r && r.supported); } catch {}
  }
  caps.hevcServer = !!(caps.server && caps.server.caps && caps.server.caps.hevc);
  const hevcOk = caps.hevcBrowser || caps.hevcServer;
  $('#hevcBtn').disabled = !hevcOk;
  if (!hevcOk && state.output.codec === 'hevc') { state.output.codec = 'h264'; refreshSegs(); }
  const fact = $('#encoderFact');
  if (!caps.server) fact.textContent = 'Server offline';
  else if (caps.webcodecs) fact.textContent = 'GPU, in the browser';
  else fact.textContent = 'ffmpeg on this computer';
  if (!caps.server) toast('The Liner server is not reachable. Start it and reload.', { error: true, duration: 8000 });
  // the system's own folder chooser exists on macOS only; elsewhere the Mixes folder is the one place
  const canAsk = !!(caps.server && caps.server.platform === 'darwin');
  for (const id of ['saveMixElse', 'loadMixElse']) { const b = $('#' + id); if (!b) continue; b.disabled = !canAsk; if (canAsk) delete b.dataset.tip; else b.dataset.tip = 'The folder chooser is only available on macOS for now.'; }
}

const sheet = {
  root: $('#exportSheet'), canvas: $('#sheetCanvas'), bar: $('#sheetBar'), pct: $('#sheetPct'), detail: $('#sheetDetail'), sub: $('#sheetSub'), title: $('#sheetTitle'),
  progress: $('#sheetProgress'), result: $('#sheetResult'), error: $('#sheetError'), errorText: $('#sheetErrorText'),
  cancel: $('#sheetCancel'), open: $('#sheetOpen'), reveal: $('#sheetReveal'), done: $('#sheetDone'), phases: $$('#phases li'),
};
let sheetCloseTimer = null;
function openSheet() { clearTimeout(sheetCloseTimer); sheet.root.hidden = false; requestAnimationFrame(() => sheet.root.classList.add('is-open')); }
function closeSheet() { sheet.root.classList.remove('is-open'); clearTimeout(sheetCloseTimer); sheetCloseTimer = setTimeout(() => { sheet.root.hidden = true; }, 200); document.title = 'Liner'; }
function setPhase(name) { let past = true; for (const li of sheet.phases) { const is = li.dataset.phase === name; li.classList.toggle('is-active', is); li.classList.toggle('is-done', past && !is); if (is) past = false; } }
function setProgress(frac, pctText, detail) { sheet.bar.style.transform = `scaleX(${clamp01(frac).toFixed(4)})`; sheet.pct.textContent = pctText; sheet.detail.textContent = detail; document.title = `${pctText} · Liner`; }

async function startExport(opts = {}) {
  if (job) return;
  const only = opts && opts.only && opts.only.id ? opts.only : null; // one song on its own, from its menu
  const songs = (only ? [only] : state.songs).filter((s) => !s.error && !s.uploading);
  if (state.songs.some((s) => s.uploading)) return toast('Wait for the uploads to finish.');
  if (!songs.length) return toast('Add at least one song first.');
  if (songs.some((s) => !s.ready)) return toast('Some songs are still being prepared. One moment…');
  if (!caps.server) return toast('The Liner server is not reachable.', { error: true });
  pause();
  if (state.dancers.some((d) => !d.sprite)) return toast('A dancer is still loading. One moment…');
  if (state.dancers.length && (state.dance.mode !== 'always' || state.dancers.some((d) => d.tempo !== 'natural')) && state.songs.some((s) => s.ready && !s.error && !s.analysis)) { toast('Listening to the tracks for the dancers…'); await ensureAnalyses(); }
  if (state.viz.style !== 'off' && state.songs.some((s) => s.ready && !s.error && !s.spectrum)) { toast('Preparing the visualizer…'); await ensureSpectra(); }
  if (state.look.progress === 'wave' && state.songs.some((s) => s.ready && !s.error && !s.waveform)) await ensureWaveforms();
  if (state.logo.id && !state.logo.image) await hydrateLogo();
  // every video the export draws (the mix's background and the songs' own or chosen videos), decoded frame by frame
  const waiting = songs.find((s) => s.videoUse && s.videoUse !== 'off' && s.videoPick !== 'other' && s.videoSource && s.ownVideoStatus === 'preparing');
  if (waiting) return toast(`The video for “${waiting.title || 'a song'}” is still being prepared. One moment…`);
  const videoIds = videoIdsInUse({ ...state, songs }), vmetas = new Map();
  for (const id of videoIds) {
    const m = await videoMeta(id).catch(() => null);
    if (!m || m.error) return toast(m && m.error ? m.error : 'A video could not be found. Drop it again.', { error: true });
    if (!m.ready) return toast('A video is still being prepared. One moment…');
    vmetas.set(id, m);
  }
  if (videoIds.length && typeof VideoDecoder === 'undefined') return toast('This browser cannot decode videos for the export.', { error: true });
  let vsrc = null, Rs = null;
  const o = { ...state.output };
  const name = (only ? (only.title || 'Untitled') : (state.output.fileName || state.title || 'Untitled mix')).trim();
  job = { cancelled: false, rid: null, encoders: null };
  sheet.title.textContent = 'Exporting'; sheet.sub.textContent = `${name}.mp4`;
  sheet.progress.hidden = false; sheet.result.hidden = true; sheet.error.hidden = true;
  sheet.cancel.hidden = false; sheet.open.hidden = true; sheet.reveal.hidden = true; sheet.done.hidden = true;
  sheet.bar.parentElement.classList.remove('is-indeterminate');
  setPhase('render'); setProgress(0, '0%', 'Preparing…');
  openSheet();
  const sc = sheet.canvas; sc.width = 960; sc.height = Math.round(960 * o.height / o.width); const sx = sc.getContext('2d');
  $('#sheetPreview').style.aspectRatio = `${o.width} / ${o.height}`;
  let R = null;
  try {
    const enc = await probeEncoder(o);
    const mode = enc ? 'stream' : 'raw';
    console.info(`Liner export: ${o.width}×${o.height}@${o.fps} ${o.codec}, ${mode === 'stream' ? `browser encoder (${enc.hw}${o.debugFormat === 'length' ? ', length-prefixed test' : ''})` : 'ffmpeg on the server'}`);
    if (!enc && !(o.codec === 'hevc' ? caps.hevcServer : caps.server.caps.h264)) throw new Error('No encoder is available for this codec and size.');
    R = new Renderer(o.width, o.height);
    R.setProject({ ...state, songs });
    const tl = R.timeline;
    const total = tl.total, N = Math.ceil(total * o.fps);
    // the hardware encoder is the slow step: two encoders working on the two halves of the video at once get more out of it
    const parts = mode === 'stream' && N >= o.fps * 8 ? (state.output.parts === 1 ? 1 : 2) : 1; // output.parts = 1 forces a single encoder (for comparisons)
    const { rid } = await api.renderStart({ mode, codec: o.codec, width: o.width, height: o.height, fps: o.fps, bitrate: computeBitrate(o), audio: o.audio, audioBitrate: 320, fileName: name, title: state.title, frames: N, parts, bass: { mode: state.audio.bass, gain: state.audio.gain }, songs: songs.map((s) => ({ id: s.id, start: trimStart(s), end: s.trim && s.trim.end != null ? Math.min(s.trim.end, s.duration) : null, fade: s.trim && s.trim.fade ? 1 : 0, gainDb: s.volume || 0 })), lead: state.timing.lead, gap: state.timing.gap, tail: state.timing.tail, crossfade: state.timing.crossfade || 0 });
    job.rid = rid;
    console.info(`Liner export: render ${rid}, ${N} frames in ${parts} part${parts > 1 ? 's' : ''}`);
    Rs = [R];
    for (let p = 1; p < parts; p++) { const R2 = new Renderer(o.width, o.height); R2.setProject({ ...state, songs }); Rs.push(R2); }
    const srcFor = (p, id) => { let src = vsrc[p].get(id); if (!src) { const m = vmetas.get(id); src = new H264Source(`/api/backgrounds/${id}/stream.h264?v=${m.version}`, m); vsrc[p].set(id, src); } return src; };
    if (videoIds.length) {
      vsrc = Rs.map(() => new Map());
      Rs.forEach((R2, p) => { R2.videoProvider = { meta: (id) => vmetas.get(id) || null, frame: (id) => { const src = vsrc[p].get(id); return src ? src.current : null; } }; });
    }
    const readyFrames = async (p, t) => { for (const need of Rs[p].videoNeeds(t)) await srcFor(p, need.id).frameAt(videoFrameIndex(vmetas.get(need.id), need.vt)); };
    let encError = null;
    // uploads run in the background, one request after another per part so the server writes them in order; the render
    // loop only waits when the backlog grows large, so a slow connection no longer stalls rendering and encoding
    const inflight = new Array(parts).fill(null), queued = new Array(parts).fill(0), pending = Array.from({ length: parts }, () => []), pendingBytes = new Array(parts).fill(0);
    const BACKLOG = mode === 'raw' ? 96e6 : 48e6;
    const flush = (p) => {
      if (!pending[p].length) return;
      // plain typed arrays as request bodies: Blob bodies pile up in the browser's blob store and run it out of memory
      let body;
      if (pending[p].length === 1) body = pending[p][0];
      else { body = new Uint8Array(pendingBytes[p]); let o2 = 0; for (const part of pending[p]) { body.set(part, o2); o2 += part.byteLength; } }
      pending[p] = []; pendingBytes[p] = 0;
      queued[p] += body.byteLength;
      inflight[p] = (inflight[p] || Promise.resolve()).then(() => api.chunk(rid, body, p)).then(() => { queued[p] -= body.byteLength; }, (e) => { encError = encError || e; queued[p] -= body.byteLength; });
    };
    const encoders = [];
    if (mode === 'stream') {
      for (let p = 0; p < parts; p++) {
        let paramSets = null, streamFormat = null;
        const encoder = new VideoEncoder({
          output: (chunk, meta) => {
            const desc = meta && meta.decoderConfig && meta.decoderConfig.description;
            if (desc) paramSets = parseParameterSets(desc instanceof ArrayBuffer ? new Uint8Array(desc) : new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength), o.codec);
            const buf = new Uint8Array(chunk.byteLength); chunk.copyTo(buf);
            if (streamFormat == null) { streamFormat = isAnnexB(buf) ? 'annexb' : 'length'; if (streamFormat === 'length' && p === 0) console.info('Liner: encoder emits length-prefixed NAL units; converting to Annex B'); }
            const out = streamFormat === 'annexb' ? buf : toAnnexB(buf, chunk.type === 'key', paramSets);
            pending[p].push(out); pendingBytes[p] += out.byteLength;
          },
          error: (e) => { encError = encError || e; },
        });
        encoder.configure(enc.config);
        encoders.push(encoder);
      }
      job.encoders = encoders;
    }
    const t0 = performance.now();
    const frameDur = 1e6 / o.fps;
    const starts = [], ends = [];
    for (let p = 0; p < parts; p++) { starts.push(Math.floor((N * p) / parts)); ends.push(Math.floor((N * (p + 1)) / parts)); }
    const longest = Math.max(...ends.map((e, p) => e - starts[p]));
    let lastUi = 0, done = 0;
    for (let k = 0; k < longest; k++) {
      if (job.cancelled) throw new Error('cancelled');
      if (encError) throw encError;
      for (let p = 0; p < parts; p++) {
        const i = starts[p] + k;
        if (i >= ends[p]) continue;
        if (vsrc) await readyFrames(p, i / o.fps);
        Rs[p].draw(i / o.fps, i);
        if (mode === 'stream') {
          const frame = new VideoFrame(Rs[p].canvas, { timestamp: Math.round(k * frameDur), duration: Math.round(frameDur) });
          encoders[p].encode(frame, { keyFrame: k % (o.fps * 2) === 0 }); // every part begins with a keyframe, so the parts join cleanly
          frame.close();
          if (encoders[p].encodeQueueSize > 8) await new Promise((r) => { const h = () => { encoders[p].removeEventListener('dequeue', h); r(); }; encoders[p].addEventListener('dequeue', h); setTimeout(h, 100); });
          if (pendingBytes[p] > 3e6 || k % o.fps === o.fps - 1) flush(p);
        } else {
          const px = Rs[p].ctx.getImageData(0, 0, o.width, o.height);
          pending[p].push(new Uint8Array(px.data.buffer)); pendingBytes[p] += px.data.byteLength;
          if (pendingBytes[p] >= 24e6) flush(p); // a few frames per request; the final flush sends the rest
        }
        if (queued[p] > BACKLOG && inflight[p]) await inflight[p];
        done++;
      }
      const now = performance.now();
      if (now - lastUi > 120 || k === longest - 1) {
        lastUi = now;
        const el = (now - t0) / 1000, fps = done / el, eta = fps > 0 ? (N - done) / fps : 0;
        setProgress(done / N, `${Math.floor(done / N * 100)}%`, `Frame ${done.toLocaleString()} of ${N.toLocaleString()} · ${fps.toFixed(0)} fps · ${eta > 90 ? `about ${Math.ceil(eta / 60)} min left` : `${Math.ceil(eta)} s left`}`);
        if (k % o.fps < 1 || k === longest - 1) sx.drawImage(R.canvas, 0, 0, sc.width, sc.height);
        await nextFrame();
      }
    }
    if (mode === 'stream') { await Promise.all(encoders.map((e) => e.flush())); encoders.forEach((e) => e.close()); job.encoders = null; }
    for (let p = 0; p < parts; p++) { flush(p); if (inflight[p]) await inflight[p]; }
    if (encError) throw encError;
    setPhase('finish'); setProgress(1, '100%', 'Encoding audio…');
    sheet.bar.parentElement.classList.add('is-indeterminate');
    await api.finish(rid);
    let status;
    for (;;) {
      await new Promise((r) => setTimeout(r, 500));
      if (job.cancelled) throw new Error('cancelled');
      status = await api.status(rid);
      if (status.phase === 'done' || status.phase === 'error' || status.phase === 'cancelled') break;
      if (status.phase === 'audio' && status.progress > 0) { sheet.bar.parentElement.classList.remove('is-indeterminate'); setProgress(status.progress, `${Math.floor(status.progress * 100)}%`, 'Encoding audio and writing the file…'); }
    }
    if (status.phase !== 'done') throw new Error(status.error || 'Export was cancelled.');
    sheet.bar.parentElement.classList.remove('is-indeterminate');
    setPhase('done'); setProgress(1, '100%', 'Finished');
    if (vsrc) await readyFrames(0, Math.min(total, Math.max(tl.fadeIn, 1.25))).catch(() => {});
    R.draw(Math.min(total, Math.max(tl.fadeIn, 1.25)), 0); // poster frame for the result card, not the faded-out last frame
    sx.drawImage(R.canvas, 0, 0, sc.width, sc.height);
    sheet.title.textContent = 'Exported';
    sheet.progress.hidden = true; sheet.result.hidden = false;
    $('#resultName').textContent = status.file.split('/').pop();
    $('#resultMeta').textContent = `${o.width} × ${o.height} · ${o.fps} fps · ${formatTime(status.probe ? status.probe.duration : total)} · ${status.sizeText}`;
    if (status.warning) toast(status.warning, { error: true, duration: 8000 });
    sheet.cancel.hidden = true; sheet.open.hidden = false; sheet.reveal.hidden = false; sheet.done.hidden = false;
    sheet.reveal.onclick = () => api.reveal(status.file);
    sheet.open.onclick = () => api.open(status.file);
    sheet.done.focus();
  } catch (e) {
    console.info('Liner export ended:', e && e.message);
    if (job.encoders) for (const e of job.encoders) { try { e.close(); } catch {} }
    if (job.rid) api.cancel(job.rid);
    if (e.message === 'cancelled') { closeSheet(); }
    else {
      console.error(e);
      sheet.bar.parentElement.classList.remove('is-indeterminate');
      sheet.title.textContent = 'Export failed';
      sheet.progress.hidden = true; sheet.error.hidden = false; sheet.errorText.textContent = e.message || String(e);
      sheet.cancel.hidden = true; sheet.done.hidden = false; sheet.done.textContent = 'Close';
    }
  } finally {
    if (Rs) for (const R2 of Rs) R2.bg.dispose(); else if (R) R.bg.dispose(); // every renderer, including a second one left by a failed or cancelled export
    if (vsrc) for (const m of vsrc) for (const v of m.values()) v.close();
    job = null;
    document.title = 'Liner';
    updateExportState();
  }
}
sheet.cancel.addEventListener('click', () => { if (job) job.cancelled = true; });
window.addEventListener('pagehide', () => { if (job && job.rid) navigator.sendBeacon(`/api/render/${job.rid}/cancel`); });
sheet.done.addEventListener('click', () => { closeSheet(); sheet.done.textContent = 'Done'; });
$('#exportBtn').addEventListener('click', startExport);

// ---------------------------------------------------------------- trim sheet (in/out points on the waveform, audition, fades at the cuts)
const trimUI = { root: $('#trimSheet'), song: $('#trimSong'), wave: $('#trimWave'), canvas: $('#trimCanvas'), loading: $('#trimLoading'), ruler: $('#trimRuler'), play: $('#trimPlay'), time: $('#trimTime'), start: $('#trimStartInput'), end: $('#trimEndInput'), setStart: $('#trimSetStart'), setEnd: $('#trimSetEnd'), fade: $('#trimFade'), keep: $('#trimKeep'), reset: $('#trimReset'), cancel: $('#trimCancel'), apply: $('#trimApply') };
const trimAudio = new Audio(); trimAudio.preload = 'auto';
let trimSong = null, trimOpen = false, trimWave = null, trimCloseTimer = null, trimSel = { start: 0, end: 0, fade: false }, trimPos = 0, trimPlaying = false, trimRaf = 0, trimDrag = null, trimToken = 0;
const MIN_KEEP = 1;
const fmtTrim = (sec) => { sec = Math.max(0, sec); const m = Math.floor(sec / 60), s = sec - m * 60; return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`; };
function parseTrim(text) {
  const t = String(text || '').trim().replace(',', '.');
  if (!t) return NaN;
  const parts = t.split(':').map(Number);
  if (parts.some((v) => Number.isNaN(v))) return NaN;
  return parts.reduce((a, v) => a * 60 + v, 0);
}
function openTrimSheet(song) {
  if (job) return toast('Wait for the export to finish first.');
  if (!song.ready) return toast('This song is still being prepared. One moment…');
  pause();
  trimSong = song; trimOpen = true; trimWave = null; trimToken++;
  const full = song.duration;
  trimSel = { start: trimStart(song), end: song.trim && song.trim.end != null ? Math.min(song.trim.end, full) : full, fade: !!(song.trim && song.trim.fade) };
  trimPos = trimSel.start;
  trimUI.song.textContent = [song.title || 'Untitled', song.artist].filter(Boolean).join(' · ');
  trimUI.loading.hidden = false;
  clearTimeout(trimCloseTimer);
  trimUI.root.hidden = false;
  requestAnimationFrame(() => { trimUI.root.classList.add('is-open'); drawTrim(); });
  updateTrimFields();
  trimAudio.src = previewUrl(song); trimAudio.load();
  const token = trimToken;
  api.json(`/api/songs/${song.id}/waveform`).then((w) => { if (token !== trimToken) return; trimWave = w; trimUI.loading.hidden = true; drawTrim(); })
    .catch((e) => { if (token === trimToken) { trimUI.loading.textContent = e.message; } });
}
function closeTrimSheet() {
  trimOpen = false; trimToken++;
  stopTrimAudio();
  trimUI.root.classList.remove('is-open');
  clearTimeout(trimCloseTimer);
  trimCloseTimer = setTimeout(() => { trimUI.root.hidden = true; trimSong = null; }, 200);
}
function stopTrimAudio() {
  trimPlaying = false; cancelAnimationFrame(trimRaf);
  if (!trimAudio.paused) trimAudio.pause();
  trimUI.play.classList.remove('is-playing');
}
function trimPlayPause() {
  if (!trimSong) return;
  if (trimPlaying) { stopTrimAudio(); drawTrim(); return; }
  if (trimPos < trimSel.start || trimPos >= trimSel.end - 0.05) trimPos = trimSel.start;
  try { trimAudio.currentTime = trimPos; } catch {}
  trimAudio.play().catch(() => {});
  trimPlaying = true; trimUI.play.classList.add('is-playing');
  const step = () => {
    if (!trimPlaying) return;
    if (!trimAudio.seeking && trimAudio.readyState >= 2) trimPos = trimAudio.currentTime;
    trimAudio.volume = fadeGain({ trim: trimSel, duration: trimSong.duration }, trimPos);
    if (trimPos >= trimSel.end) { stopTrimAudio(); trimPos = trimSel.start; updateTrimFields(); drawTrim(); return; }
    trimUI.time.textContent = fmtTrim(trimPos);
    drawTrim();
    trimRaf = requestAnimationFrame(step);
  };
  trimRaf = requestAnimationFrame(step);
}
function updateTrimFields() {
  if (document.activeElement !== trimUI.start) trimUI.start.value = fmtTrim(trimSel.start);
  if (document.activeElement !== trimUI.end) trimUI.end.value = fmtTrim(trimSel.end);
  trimUI.fade.checked = trimSel.fade;
  const full = trimSong ? trimSong.duration : 0, kept = trimSel.end - trimSel.start;
  const untouched = trimSel.start < 0.05 && trimSel.end > full - 0.05;
  trimUI.keep.textContent = untouched ? `Whole song · ${formatTime(full)}` : `Keeping ${formatTime(kept)} of ${formatTime(full)}`;
  trimUI.time.textContent = fmtTrim(trimPos);
}
function setTrimRange(start, end) {
  const full = trimSong ? trimSong.duration : 0;
  start = clamp(start, 0, Math.max(0, full - MIN_KEEP));
  end = clamp(end, start + MIN_KEEP, full);
  trimSel.start = start; trimSel.end = end;
  if (trimPos < start || trimPos > end) trimPos = start;
  updateTrimFields(); drawTrim();
}
function drawTrim() {
  const c = trimUI.canvas, w = trimUI.wave.clientWidth, h = trimUI.wave.clientHeight;
  if (!w || !h || !trimSong) return;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
  const full = trimSong.duration || 1;
  const px = (t) => (t / full) * w;
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#f0b35c';
  const s0 = px(trimSel.start), s1 = px(trimSel.end);
  x.fillStyle = 'rgba(255,255,255,0.05)'; x.fillRect(s0, 0, s1 - s0, h);
  if (trimWave) {
    const peaks = trimWave.peaks, n = peaks.length, mid = h / 2, amp = h * 0.44;
    if (trimWave.norm == null) trimWave.norm = Math.max(0.02, ...peaks); // quiet recordings still show their shape
    for (let i = 0; i < w; i++) {
      const b0 = Math.floor((i / w) * n), b1 = Math.max(b0 + 1, Math.floor(((i + 1) / w) * n));
      let p = 0; for (let b = b0; b < b1 && b < n; b++) if (peaks[b] > p) p = peaks[b];
      const hh = Math.max(1, (p / trimWave.norm) * amp);
      const inside = i >= s0 && i <= s1;
      x.fillStyle = inside ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.22)';
      x.fillRect(i, mid - hh, 1, hh * 2);
    }
  }
  // handles
  for (const hx of [s0, s1]) {
    x.fillStyle = accent; x.fillRect(Math.round(hx) - 1, 0, 2, h);
    x.beginPath(); x.roundRect(Math.round(hx) - 5, h / 2 - 13, 10, 26, 5); x.fill();
    x.fillStyle = 'rgba(10,10,12,0.55)'; x.fillRect(Math.round(hx) - 1, h / 2 - 6, 2, 12);
  }
  // playhead
  const ph = px(trimPos);
  x.fillStyle = 'rgba(255,255,255,0.95)'; x.fillRect(Math.round(ph), 0, 1.5, h);
  // ruler
  if (trimUI.ruler.dataset.for !== `${full}:${w}`) {
    trimUI.ruler.dataset.for = `${full}:${w}`;
    trimUI.ruler.innerHTML = '';
    const steps = [5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((v) => full / v <= 9) || 600;
    for (let t = 0; t <= full; t += step) { const sp = el('span', null, formatTime(t)); sp.style.left = `${px(t)}px`; trimUI.ruler.append(sp); }
  }
}
function trimPointerTime(e) { const r = trimUI.wave.getBoundingClientRect(); return clamp01((e.clientX - r.left) / r.width) * (trimSong ? trimSong.duration : 0); }
trimUI.wave.addEventListener('pointerdown', (e) => {
  if (!trimSong || e.button !== 0) return;
  const r = trimUI.wave.getBoundingClientRect(), full = trimSong.duration || 1;
  const xs = (e.clientX - r.left), hs = ((trimSel.start / full) * r.width), he = ((trimSel.end / full) * r.width);
  const dStart = Math.abs(xs - hs), dEnd = Math.abs(xs - he);
  if (Math.min(dStart, dEnd) <= 12) trimDrag = dStart <= dEnd ? 'start' : 'end';
  else trimDrag = 'seek';
  trimUI.wave.setPointerCapture(e.pointerId);
  trimUI.wave.classList.toggle('is-dragging', trimDrag !== 'seek');
  const move = (ev) => {
    const t = trimPointerTime(ev);
    if (trimDrag === 'start') setTrimRange(t, trimSel.end);
    else if (trimDrag === 'end') setTrimRange(trimSel.start, t);
    else { trimPos = clamp(t, 0, full); if (trimPlaying) { try { trimAudio.currentTime = trimPos; } catch {} } updateTrimFields(); drawTrim(); }
  };
  const up = () => { trimUI.wave.removeEventListener('pointermove', move); trimUI.wave.removeEventListener('pointerup', up); trimUI.wave.removeEventListener('pointercancel', up); trimUI.wave.classList.remove('is-dragging'); trimDrag = null; };
  trimUI.wave.addEventListener('pointermove', move); trimUI.wave.addEventListener('pointerup', up); trimUI.wave.addEventListener('pointercancel', up);
  move(e);
});
trimUI.wave.addEventListener('pointermove', (e) => {
  if (trimDrag || !trimSong) return;
  const r = trimUI.wave.getBoundingClientRect(), full = trimSong.duration || 1;
  const xs = e.clientX - r.left, near = Math.min(Math.abs(xs - (trimSel.start / full) * r.width), Math.abs(xs - (trimSel.end / full) * r.width)) <= 12;
  trimUI.wave.style.cursor = near ? 'ew-resize' : 'crosshair';
});
trimUI.play.addEventListener('click', trimPlayPause);
trimUI.start.addEventListener('change', () => { const v = parseTrim(trimUI.start.value); if (!Number.isNaN(v)) setTrimRange(v, trimSel.end); else updateTrimFields(); });
trimUI.end.addEventListener('change', () => { const v = parseTrim(trimUI.end.value); if (!Number.isNaN(v)) setTrimRange(trimSel.start, v); else updateTrimFields(); });
for (const inp of [trimUI.start, trimUI.end]) inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); e.stopPropagation(); });
trimUI.setStart.addEventListener('click', () => setTrimRange(trimPos, Math.max(trimSel.end, trimPos + MIN_KEEP)));
trimUI.setEnd.addEventListener('click', () => setTrimRange(Math.min(trimSel.start, trimPos - MIN_KEEP), trimPos));
trimUI.fade.addEventListener('change', () => { trimSel.fade = trimUI.fade.checked; });
trimUI.reset.addEventListener('click', () => { trimSel.fade = false; setTrimRange(0, trimSong ? trimSong.duration : 0); });
trimUI.cancel.addEventListener('click', closeTrimSheet);
trimUI.apply.addEventListener('click', () => {
  if (!trimSong) return;
  const full = trimSong.duration;
  const untouched = trimSel.start < 0.05 && trimSel.end > full - 0.05;
  trimSong.trim = untouched ? null : { start: +trimSel.start.toFixed(3), end: trimSel.end > full - 0.05 ? null : +trimSel.end.toFixed(3), fade: trimSel.fade };
  const song = trimSong;
  closeTrimSheet();
  invalidate();
  toast(song.trim ? `“${song.title}” trimmed to ${formatTime(songLength(song))}.` : `“${song.title}” plays in full.`);
});
trimUI.root.addEventListener('pointerdown', (e) => { if (e.target === trimUI.root) closeTrimSheet(); });
window.addEventListener('resize', () => { if (trimOpen) drawTrim(); });
trimAudio.addEventListener('ended', () => { if (trimPlaying) { stopTrimAudio(); trimPos = trimSel.start; drawTrim(); } });

// ---------------------------------------------------------------- cover art sheet (find automatically / choose an image / none)
const artUI = { root: $('#artSheet'), current: $('#artCurrent'), song: $('#artSong'), source: $('#artSource'), modes: $('#artModes'), query: $('#artQuery'), search: $('#artSearchBtn'), grid: $('#artGrid'), drop: $('#artDrop'), browse: $('#artBrowse'), useNone: $('#artUseNone'), noneTile: $('#artNoneTile'), summary: $('#artSummary'), done: $('#artDone') };
let artSong = null, artMode = 'find', artCands = [], artToken = 0, artOpen = false, artBusy = false, artCloseTimer = null;
const SOURCE_LABELS = { embedded: 'Embedded in the file', link: 'Thumbnail from the link', custom: 'Your image', found: 'Found online', none: 'No cover' };
function coverLabel(song) {
  if (!song.cover || song.coverMode === 'none') return 'No cover · generated tile';
  const info = song.coverInfo || {};
  const label = info.label || SOURCE_LABELS[song.coverMode] || 'Cover';
  return info.w && info.h ? `${label} · ${info.w} × ${info.h}` : label;
}
function setArtMode(mode, animate = true) {
  artMode = mode;
  const buttons = $$('button', artUI.modes);
  const sel = buttons.find((b) => b.dataset.value === mode) || buttons[0];
  buttons.forEach((b) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(b === sel)); });
  const th = artUI.modes.querySelector('.seg-thumb');
  artUI.modes.classList.toggle('no-anim', !animate);
  th.style.width = `${sel.offsetWidth}px`; th.style.transform = `translateX(${sel.offsetLeft}px)`;
  if (!animate) requestAnimationFrame(() => artUI.modes.classList.remove('no-anim'));
  $$('.art-pane', artUI.root).forEach((p) => { p.hidden = p.dataset.pane !== mode; });
  if (mode === 'find' && !artCands.length && !artBusy) artSearch();
  if (mode === 'none') drawNoneTile();
}
function renderArtHead() {
  const s = artSong; if (!s) return;
  artUI.current.innerHTML = '';
  if (s.image) {
    if (s.image instanceof HTMLImageElement) { const img = new Image(); img.src = s.image.src; img.alt = ''; artUI.current.append(img); }
    else { const c = document.createElement('canvas'); c.width = c.height = 144; c.getContext('2d').drawImage(s.image, 0, 0, 144, 144); artUI.current.append(c); }
  }
  artUI.song.textContent = [s.title || 'Untitled', s.artist].filter(Boolean).join(' · ');
  artUI.source.textContent = coverLabel(s);
  artUI.useNone.disabled = !s.cover || s.coverMode === 'none';
  artUI.useNone.textContent = !s.cover || s.coverMode === 'none' ? 'Using no cover' : 'Use no cover';
  markCurrentTile();
}
function drawNoneTile() {
  artUI.noneTile.innerHTML = '';
  if (!artSong) return;
  const tile = makePlaceholderArt(artSong, 144);
  artUI.noneTile.append(tile);
}
function openArtSheet(song) {
  if (job) return toast('Wait for the export to finish first.');
  artSong = song; artCands = []; artOpen = true; artToken++;
  artUI.query.value = [song.artist, song.title].filter(Boolean).join(' ');
  artUI.grid.innerHTML = '';
  artUI.summary.textContent = '';
  renderArtHead();
  clearTimeout(artCloseTimer);
  artUI.root.hidden = false;
  requestAnimationFrame(() => { artUI.root.classList.add('is-open'); setArtMode(song.coverMode === 'custom' ? 'choose' : 'find', false); });
}
function closeArtSheet() {
  artOpen = false; artToken++;
  artUI.root.classList.remove('is-open');
  clearTimeout(artCloseTimer);
  artCloseTimer = setTimeout(() => { artUI.root.hidden = true; artSong = null; }, 200);
}
function markCurrentTile() {
  const cur = artSong && artSong.coverInfo && artSong.coverInfo.candidate;
  for (const t of $$('.art-tile', artUI.grid)) {
    const is = !!cur && t.dataset.id === cur;
    t.classList.toggle('is-current', is);
    const badge = t.querySelector('.art-badge');
    if (is) { if (!badge) t.prepend(el('span', 'art-badge', 'Current')); else badge.textContent = 'Current'; }
    else if (badge && badge.textContent === 'Current') { if (t.dataset.best === '1') badge.textContent = 'Best match'; else badge.remove(); }
  }
}
async function artSearch(queryText) {
  if (!artSong) return;
  const song = artSong, token = ++artToken;
  const q = (queryText != null ? queryText : artUI.query.value).trim();
  const body = queryText != null || q !== [song.artist, song.title].filter(Boolean).join(' ') ? { title: q, artist: '', album: '' } : { title: song.title, artist: song.artist, album: song.album };
  if (!q) { artUI.grid.innerHTML = ''; artUI.grid.append(el('div', 'art-empty', 'Type an artist and song to search.')); return; }
  artBusy = true; artUI.search.disabled = true;
  artUI.grid.innerHTML = '';
  for (let i = 0; i < 4; i++) artUI.grid.append(el('div', 'art-skeleton', '<i></i><i></i><i></i>'));
  artUI.summary.textContent = 'Searching Apple Music, Deezer and the Cover Art Archive…';
  try {
    const r = await api.json('/api/art/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (token !== artToken) return;
    artCands = r.candidates || [];
    renderArtGrid();
  } catch (e) {
    if (token !== artToken) return;
    artUI.grid.innerHTML = '';
    artUI.grid.append(el('div', 'art-empty', 'The search failed. Check the connection and try again.'));
    artUI.summary.textContent = '';
    toast(e.message, { error: true });
  } finally { if (token === artToken) { artBusy = false; artUI.search.disabled = false; } }
}
function renderArtGrid() {
  artUI.grid.innerHTML = '';
  if (!artCands.length) {
    artUI.grid.append(el('div', 'art-empty', 'Nothing matching was found.<br>Try a shorter query, like just the artist and the album.'));
    artUI.summary.textContent = '';
    return;
  }
  artCands.forEach((c, i) => {
    const t = el('button', 'art-tile');
    t.dataset.id = c.id; t.dataset.best = i === 0 ? '1' : '0';
    t.type = 'button';
    t.innerHTML = `<img alt="" draggable="false"><b></b><span></span>`;
    t.querySelector('img').src = c.local;
    t.querySelector('b').textContent = c.album || c.title;
    t.querySelector('span').textContent = `${c.short || c.label} · ${c.width} × ${c.height}`;
    t.title = `${c.album || c.title}\n${c.artist}${c.year ? ' · ' + c.year : ''}\nMatch ${Math.round(c.match * 100)}%`;
    if (i === 0) t.prepend(el('span', 'art-badge', 'Best match'));
    t.addEventListener('click', () => useCandidate(c));
    artUI.grid.append(t);
  });
  const best = artCands[0];
  artUI.summary.textContent = `${artCands.length} ${artCands.length === 1 ? 'result' : 'results'} · best: ${best.label}, ${best.width} × ${best.height}`;
  markCurrentTile();
}
async function useCandidate(c) {
  const song = artSong; if (!song) return;
  try {
    const meta = await api.json(`/api/songs/${song.id}/cover/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate: c.id }) });
    Object.assign(song, { cover: true, customCover: true, coverVersion: meta.coverVersion, coverMode: meta.coverMode, coverInfo: meta.coverInfo });
    await hydrateSong(song);
    renderArtHead();
    save();
  } catch (e) { toast(e.message, { error: true }); }
}
async function useNoCover(song = artSong) {
  if (!song) return;
  try {
    const meta = await api.json(`/api/songs/${song.id}/cover/none`, { method: 'POST' });
    Object.assign(song, { cover: false, customCover: false, coverVersion: meta.coverVersion, coverMode: 'none', coverInfo: null });
    await hydrateSong(song);
    renderArtHead();
    save();
  } catch (e) { toast(e.message, { error: true }); }
}
$$('button', artUI.modes).forEach((b) => b.addEventListener('click', () => setArtMode(b.dataset.value)));
artUI.search.addEventListener('click', () => artSearch(artUI.query.value));
artUI.query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); artSearch(artUI.query.value); } if (e.key === 'Escape') closeArtSheet(); e.stopPropagation(); });
artUI.browse.addEventListener('click', () => { if (artSong) pickCover(artSong); });
artUI.drop.addEventListener('dragover', (e) => { if (hasImage(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); artUI.drop.classList.add('is-over'); } });
artUI.drop.addEventListener('dragleave', () => artUI.drop.classList.remove('is-over'));
artUI.drop.addEventListener('drop', (e) => { artUI.drop.classList.remove('is-over'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f && artSong) { e.preventDefault(); e.stopPropagation(); setCover(artSong, f); } });
artUI.useNone.addEventListener('click', () => useNoCover());
artUI.done.addEventListener('click', closeArtSheet);
artUI.root.addEventListener('pointerdown', (e) => { if (e.target === artUI.root) closeArtSheet(); });
window.addEventListener('resize', () => { if (artOpen) setArtMode(artMode, false); });

// find covers for every song that has no real artwork yet (none, or only the video thumbnail from a link)
async function findCoversForAll() {
  if (job) return toast('Wait for the export to finish first.');
  const targets = state.songs.filter((s) => !s.uploading && !s.error && (!s.cover || s.coverMode === 'none' || s.coverMode === 'link'));
  if (!targets.length) return toast('Every song already has artwork. Open a song’s cover art to change it.');
  const btn = $('#findAllBtn'); btn.disabled = true;
  let found = 0, done = 0;
  const progress = el('div', 'toast is-in', '<span></span>');
  $('#toasts').append(progress);
  const say = (t) => { progress.querySelector('span').textContent = t; };
  say(`Finding cover art… 0 of ${targets.length}`);
  for (const s of targets) {
    try {
      const r = await api.json('/api/art/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: s.title, artist: s.artist, album: s.album }) });
      const best = (r.candidates || [])[0];
      if (best && best.match >= 0.6) {
        const meta = await api.json(`/api/songs/${s.id}/cover/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ candidate: best.id }) });
        Object.assign(s, { cover: true, customCover: true, coverVersion: meta.coverVersion, coverMode: meta.coverMode, coverInfo: meta.coverInfo });
        await hydrateSong(s);
        found++;
      }
    } catch (e) { console.warn('cover search failed for', s.title, e); }
    done++;
    say(`Finding cover art… ${done} of ${targets.length}`);
  }
  save();
  progress.classList.add('is-out'); setTimeout(() => progress.remove(), 180);
  btn.disabled = false;
  const missed = targets.length - found;
  toast(found ? `Found cover art for ${found} ${found === 1 ? 'song' : 'songs'}${missed ? `; ${missed} kept ${missed === 1 ? 'its' : 'their'} current look` : ''}.` : 'No confident matches were found. Try a song’s cover art sheet to search by hand.', { duration: 6000 });
}
$('#findAllBtn').addEventListener('click', findCoversForAll);

// ---------------------------------------------------------------- add from a link (YouTube / SoundCloud through yt-dlp)
const linkUI = { root: $('#linkSheet'), text: $('#linkText'), fetch: $('#linkFetch'), list: $('#linkList'), summary: $('#linkSummary'), addAll: $('#linkAddAll'), close: $('#linkClose'), hint: $('#linkHint') };
const LINK_ACTIVE = new Set(['queued', 'downloading', 'converting']);
const linkRows = new Map();
let linkJobs = [], linkPollTimer = null, linkOpen = false, linkCloseTimer = null;
const parseUrls = (text) => [...new Set((String(text || '').match(/https?:\/\/[^\s<>"']+/gi) || []).map((u) => u.replace(/[),.;]+$/, '')))];
const shortUrl = (u) => { try { const x = new URL(u); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 24) : ''); } catch { return u.slice(0, 40); } };
function openLinkSheet(prefill) {
  if (job) return toast('Wait for the export to finish first.');
  linkOpen = true;
  if (prefill) linkUI.text.value = prefill;
  const ok = !!(caps.server && caps.server.caps && caps.server.caps.ytdlp);
  linkUI.fetch.disabled = !ok;
  linkUI.hint.textContent = ok
    ? 'Best available audio, saved as WAV in Liner › Downloads. Add what you like to the tracks afterwards.'
    : 'yt-dlp is not installed. Install it (“brew install yt-dlp” on a Mac, “pip install yt-dlp” elsewhere), then restart Liner.';
  clearTimeout(linkCloseTimer);
  linkUI.root.hidden = false;
  requestAnimationFrame(() => linkUI.root.classList.add('is-open'));
  refreshLinks();
  setTimeout(() => linkUI.text.focus(), 60);
}
function closeLinkSheet() {
  linkOpen = false;
  clearTimeout(linkPollTimer);
  linkUI.root.classList.remove('is-open');
  clearTimeout(linkCloseTimer);
  linkCloseTimer = setTimeout(() => { linkUI.root.hidden = true; }, 200);
}
async function refreshLinks() {
  try { linkJobs = await api.json('/api/links'); } catch { return; }
  renderLinks();
  clearTimeout(linkPollTimer);
  if (linkOpen && linkJobs.some((j) => LINK_ACTIVE.has(j.status))) linkPollTimer = setTimeout(refreshLinks, 800);
}
async function fetchLinks() {
  const urls = parseUrls(linkUI.text.value);
  if (!urls.length) { toast('Paste a YouTube or SoundCloud link first.'); linkUI.text.focus(); return; }
  linkUI.fetch.disabled = true; linkUI.fetch.textContent = 'Looking up…';
  try {
    const r = await api.json('/api/links/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls }) });
    for (const e of r.errors || []) toast(`${shortUrl(e.url)}: ${e.error}`, { error: true, duration: 7000 });
    if (r.items && r.items.length) {
      await api.json('/api/links/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: r.items }) });
      linkUI.text.value = '';
      const sets = [...new Set(r.items.map((i) => i.playlist).filter(Boolean))];
      toast(r.items.length === 1 ? `Downloading “${r.items[0].title || shortUrl(r.items[0].url)}”.` : `Downloading ${r.items.length} items${sets.length ? ` from “${sets[0]}”` : ''}.`);
    }
    await refreshLinks();
  } catch (e) { toast(e.message, { error: true, duration: 6000 }); }
  finally { linkUI.fetch.disabled = false; linkUI.fetch.textContent = 'Fetch'; }
}
function linkRow(j) {
  const row = el('div', 'link-row');
  row.dataset.id = j.id;
  row.innerHTML = `<div class="link-thumb"><img alt="" draggable="false" hidden></div>
    <div class="link-info"><b class="link-title"></b><span class="link-meta"></span><div class="link-status"><div class="link-progress"><i></i></div><span class="link-state"></span></div></div>
    <div class="link-actions"></div>`;
  return row;
}
function linkStateText(j) {
  switch (j.status) {
    case 'queued': return 'Waiting';
    case 'downloading': return `Downloading · ${Math.round((j.progress || 0) * 100)}%${j.eta ? ` · ${j.eta} left` : ''}`;
    case 'converting': return 'Converting to WAV…';
    case 'ready': return ['WAV', j.sampleRate ? `${(j.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz` : '', j.size ? fmtBytes(j.size) : ''].filter(Boolean).join(' · ');
    case 'added': return 'Added to the tracks';
    case 'error': return j.error || 'Failed';
    default: return '';
  }
}
function updateLinkRow(row, j) {
  const img = row.querySelector('img');
  const src = j.thumb ? `/api/links/${j.id}/thumb` : (j.thumbnail || '');
  if (img.dataset.src !== src) { img.dataset.src = src; if (src) { img.src = src; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; } }
  row.querySelector('.link-title').textContent = j.title || shortUrl(j.url);
  row.querySelector('.link-meta').textContent = [j.artist, j.duration ? formatTime(j.duration) : ''].filter(Boolean).join(' · ');
  row.dataset.status = j.status;
  const bar = row.querySelector('.link-progress');
  bar.style.setProperty('--p', String(j.status === 'converting' ? 1 : j.progress || 0));
  bar.classList.toggle('is-indeterminate', j.status === 'converting');
  row.querySelector('.link-state').textContent = linkStateText(j);
  const key = j.status + (j.status === 'error' ? ':' + !!j.url : '');
  if (row.dataset.actions !== key) {
    row.dataset.actions = key;
    const box = row.querySelector('.link-actions');
    box.innerHTML = '';
    const mk = (cls, html, label, fn) => { const b = el('button', cls, html); if (label) { b.setAttribute('aria-label', label); b.dataset.tip = label; } b.addEventListener('click', fn); box.append(b); return b; };
    if (j.status === 'ready') mk('btn btn-primary btn-sm', 'Add', null, () => addFromLink(j.id));
    if (j.status === 'added') mk('btn btn-sm', 'Add again', null, () => addFromLink(j.id));
    if (j.status === 'error') mk('btn btn-sm', 'Retry', null, () => retryLink(j));
    if (LINK_ACTIVE.has(j.status)) mk('btn btn-icon btn-sm', icon('close'), 'Cancel', () => discardLink(j.id));
    else mk('btn btn-icon btn-sm', icon('close'), j.status === 'error' ? 'Remove' : 'Delete the file', () => discardLink(j.id));
  }
}
function renderLinks() {
  const seen = new Set();
  let prev = null;
  for (const j of linkJobs) {
    let row = linkRows.get(j.id);
    if (!row) { row = linkRow(j); linkRows.set(j.id, row); }
    if (prev ? prev.nextSibling !== row : linkUI.list.firstChild !== row) linkUI.list.insertBefore(row, prev ? prev.nextSibling : linkUI.list.firstChild);
    updateLinkRow(row, j);
    seen.add(j.id);
    prev = row;
  }
  for (const [id, row] of linkRows) if (!seen.has(id)) { row.remove(); linkRows.delete(id); }
  let empty = linkUI.list.querySelector('.link-empty');
  if (!linkJobs.length) { if (!empty) { empty = el('div', 'link-empty', 'Nothing here yet. Paste a link above.'); linkUI.list.append(empty); } }
  else if (empty) empty.remove();
  const n = (st) => linkJobs.filter((j) => j.status === st).length;
  const active = linkJobs.filter((j) => LINK_ACTIVE.has(j.status)).length;
  const parts = [];
  if (active) parts.push(`${active} downloading`);
  if (n('ready')) parts.push(`${n('ready')} ready`);
  if (n('added')) parts.push(`${n('added')} added`);
  if (n('error')) parts.push(`${n('error')} failed`);
  linkUI.summary.textContent = parts.join(' · ');
  linkUI.addAll.hidden = n('ready') < 2;
}
async function addFromLink(id) {
  const row = linkRows.get(id);
  const btn = row && row.querySelector('.btn-primary, .btn-sm:not(.btn-icon)');
  if (btn) btn.disabled = true;
  try {
    const r = await api.json(`/api/links/${id}/add`, { method: 'POST' });
    const song = addSongMeta(r.song);
    toast(`Added “${song.title || 'Untitled'}” to the tracks.`);
    await refreshLinks();
  } catch (e) { toast(e.message, { error: true }); if (btn) btn.disabled = false; }
}
async function addAllReady() {
  for (const j of linkJobs.filter((x) => x.status === 'ready')) await addFromLink(j.id);
}
async function discardLink(id) {
  try { await api.json(`/api/links/${id}`, { method: 'DELETE' }); await refreshLinks(); }
  catch (e) { toast(e.message, { error: true }); }
}
async function retryLink(j) {
  try {
    await api.json('/api/links/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ url: j.url, title: j.title, artist: j.artist, album: j.album, duration: j.duration, thumbnail: j.thumbnail }] }) });
    await api.json(`/api/links/${j.id}`, { method: 'DELETE' });
    await refreshLinks();
  } catch (e) { toast(e.message, { error: true }); }
}
linkUI.fetch.addEventListener('click', fetchLinks);
linkUI.text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); fetchLinks(); } if (e.key === 'Escape') { closeLinkSheet(); } e.stopPropagation(); });
linkUI.addAll.addEventListener('click', addAllReady);
linkUI.close.addEventListener('click', closeLinkSheet);
linkUI.root.addEventListener('pointerdown', (e) => { if (e.target === linkUI.root) closeLinkSheet(); });
$('#linkBtn').addEventListener('click', () => openLinkSheet());
$('#linkBtn2').addEventListener('click', () => openLinkSheet());
// pasting a link anywhere in the window opens the sheet with it
document.addEventListener('paste', (e) => {
  const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const text = e.clipboardData ? e.clipboardData.getData('text') : '';
  if (!parseUrls(text).length) return;
  e.preventDefault();
  openLinkSheet(text);
  fetchLinks();
});

// ---------------------------------------------------------------- look presets
const LOOK_PRESETS = {
  midnight: { style: 'aurora', font: 'sans', motion: 1, dim: 0, corners: 'soft', glow: false, rows: 'boxes', density: 'comfortable', accent: 'white', marker: 'arrow' },
  vinyl: { style: 'cover', font: 'serif', motion: 0.5, dim: 0.1, corners: 'soft', glow: false, rows: 'lines', density: 'comfortable', accent: 'album', marker: 'triangle' },
  studio: { style: 'ink', font: 'mono', motion: 0, dim: 0, corners: 'sharp', glow: false, rows: 'plain', density: 'compact', accent: 'white', marker: 'arrow' },
  neon: { style: 'aurora', font: 'sans', motion: 1, dim: 0.05, corners: 'round', glow: true, rows: 'boxes', density: 'comfortable', accent: 'album', marker: 'triangle' },
};
for (const b of $$('.preset')) b.addEventListener('click', () => {
  const p = LOOK_PRESETS[b.dataset.preset]; if (!p) return;
  Object.assign(state.look, p);
  syncControls();
  invalidate();
  toast(`${b.textContent.trim()} applied. Everything stays adjustable.`);
});

// ---------------------------------------------------------------- preview volume, expanded preview, shortcuts sheet
$('#volumeRange').addEventListener('input', (e) => { playerVolume.level = +e.target.value; if (playerVolume.level > 0) playerVolume.muted = false; applyVolume(); syncAudio(false); });
const resetVolume = () => { playerVolume.level = 1; playerVolume.muted = false; applyVolume(); syncAudio(false); };
$('#volumeRange').addEventListener('dblclick', resetVolume);
$('#volumeRange').addEventListener('pointerdown', (e) => { if (e.altKey) { e.preventDefault(); resetVolume(); } });
$('#volumeRange').dataset.tip = 'Preview volume · double-click to reset';
$('#muteBtn').addEventListener('click', () => { playerVolume.muted = !playerVolume.muted; applyVolume(); syncAudio(false); });
function toggleTheatre(force) {
  const on = force == null ? !document.body.classList.contains('is-theatre') : force;
  document.body.classList.toggle('is-theatre', on);
  $('#theatreBtn').dataset.tip = on ? 'Restore the panels (F)' : 'Expand preview (F)';
  $('#theatreBtn').setAttribute('aria-label', on ? 'Restore the panels' : 'Expand the preview');
}
$('#theatreBtn').addEventListener('click', () => toggleTheatre());
let helpOpen = false, helpCloseTimer = null;
function openHelp() { clearTimeout(helpCloseTimer); helpOpen = true; $('#helpSheet').hidden = false; requestAnimationFrame(() => $('#helpSheet').classList.add('is-open')); }
function closeHelp() { helpOpen = false; $('#helpSheet').classList.remove('is-open'); clearTimeout(helpCloseTimer); helpCloseTimer = setTimeout(() => { $('#helpSheet').hidden = true; }, 200); }
$('#helpBtn').addEventListener('click', () => (helpOpen ? closeHelp() : openHelp()));
$('#helpClose').addEventListener('click', closeHelp);
$('#helpSheet').addEventListener('pointerdown', (e) => { if (e.target === $('#helpSheet')) closeHelp(); });

// ---------------------------------------------------------------- mixes
function switchMix(id) {
  if (id === currentMixId) return;
  pause();
  saveNow();
  currentMixId = id; localStorage.setItem(CURRENT_MIX_KEY, id);
  resetHistory(); // each mix keeps its own steps; those of the one left behind are let go
  const next = loadMixState(id);
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  for (const [, row] of rows) row.remove();
  rows.clear();
  selectedId = null; player.t = 0; selectElement(null);
  for (const a of player.audio) { a.pause(); a.removeAttribute('src'); a.dataset.id = ''; }
  renderTracks();
  renderDancers();
  renderCaptions();
  renderLogoUI();
  syncControls();
  fitPreview();
  hydrateDancers();
  hydrateLogo();
  hydrateVideo();
  Promise.all(state.songs.map(hydrateSong)).then(() => { if (state.songs.some((s) => !s.ready && !s.error)) watchReadiness(); invalidate(); });
  invalidate();
  updateTransport();
}
function createMix(fromState, opts = {}) {
  saveNow();
  const id = newMixId();
  const st = fromState ? normalizeState(JSON.parse(JSON.stringify(fromState))) : defaultState();
  if (fromState) st.title = opts.title != null ? opts.title : (fromState.title || 'Untitled mix') + ' copy';
  localStorage.setItem(MIX_KEY(id), JSON.stringify(st));
  writeMixIndex([...readMixIndex(), { id, title: st.title || '', updatedAt: Date.now(), songs: st.songs.length }]);
  switchMix(id);
}
function deleteMix(id) {
  const index = readMixIndex();
  if (index.length <= 1) return toast('This is the only mix. Make a new one first, then delete this one.');
  const victim = index.find((m) => m.id === id); if (!victim) return;
  const ids = id === currentMixId ? state.songs.map((s) => s.id) : (() => { try { return (JSON.parse(localStorage.getItem(MIX_KEY(id))).songs || []).map((s) => s.id); } catch { return []; } })();
  clearTimeout(saveTimer);
  localStorage.removeItem(MIX_KEY(id));
  writeMixIndex(index.filter((m) => m.id !== id));
  if (id === currentMixId) { currentMixId = null; switchMix(readMixIndex()[0].id); }
  for (const sid of ids) if (!songUsedElsewhere(sid) && !state.songs.some((s) => s.id === sid)) api.removeSong(sid).catch(() => {});
  toast(`Deleted “${victim.title || 'Untitled mix'}”.`);
}
$('#mixesBtn').addEventListener('click', (e) => {
  const index = readMixIndex().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const items = index.map((m) => ({ label: `${m.title || 'Untitled mix'}${m.songs != null ? ` · ${m.songs}` : ''}`, icon: m.id === currentMixId ? 'check' : 'music', current: m.id === currentMixId, action: () => switchMix(m.id) }));
  items.push('-', { label: 'New mix', icon: 'plus', action: () => createMix(null) }, { label: 'Duplicate this mix', icon: 'stack', action: () => createMix(state) });
  items.push('-', { label: 'Save mix…', icon: 'folder', action: openSaveMix }, { label: 'Load mix…', icon: 'open', action: openLoadMix });
  items.push({ label: 'Reset every setting…', icon: 'reset', action: () => toast('Put every look, dancer, visualizer and output setting back to the defaults? Songs, dancers and the title stay.', { duration: 8000, action: { label: 'Reset', run: resetEverything } }) });
  if (index.length > 1) items.push({ label: 'Delete this mix…', icon: 'close', danger: true, action: () => toast(`Delete “${state.title || 'Untitled mix'}”? Its songs stay on disk if another mix uses them.`, { duration: 7000, action: { label: 'Delete', run: () => deleteMix(currentMixId) } }) });
  menu.open(e.currentTarget, items);
});

// ---------------------------------------------------------------- dancers (sprites that dance on the lively tracks)
const SPRITE_EXT = /\.(gif|png|apng|webp|jpe?g|bmp|tiff?|mp4|m4v|mov|webm|mkv|avif|heic)$/i;
const isSpriteFile = (f) => (f.type && (f.type.startsWith('image/') || f.type.startsWith('video/'))) || SPRITE_EXT.test(f.name);
const MAX_DANCERS = 4;
const newDancerId = () => Math.random().toString(36).slice(2, 10);
const spriteCache = new Map(); // spriteId -> Promise<{ meta, image }>
// Which frames of a loop are its accents, for dancers that step in time: the motion into each frame from the one
// before (read from a small copy of every cell), per second of the frame's duration. A frame where that motion
// settles (a pose reached, a landing, a reversal) scores high, more so at the loop's lowest point than its highest
// (a landing, not the top of a jump), and a frame held longer than the others counts as a pose. 0..1 per frame.
function spriteAccents(image, meta) {
  try {
    const n = meta.frames, { cols, cell } = meta;
    if (!(n > 1) || !cell) return null;
    const S = 40, c = document.createElement('canvas'); c.width = c.height = S;
    const x = c.getContext('2d', { willReadFrequently: true });
    const px = [], cy = new Float32Array(n), dur = (i) => Math.max(10, +meta.durations[i] || 100);
    for (let i = 0; i < n; i++) {
      x.clearRect(0, 0, S, S); x.drawImage(image, (i % cols) * cell.w, Math.floor(i / cols) * cell.h, cell.w, cell.h, 0, 0, S, S);
      const d = x.getImageData(0, 0, S, S).data; px.push(d);
      let sy = 0, sa = 0;
      for (let p = 0, q = 0; p < d.length; p += 4, q++) { const a = d[p + 3]; sy += a * Math.floor(q / S); sa += a; }
      cy[i] = sa ? sy / sa : S / 2;
    }
    const v = new Float32Array(n); let vMean = 0, dMean = 0, yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = px[(i + n - 1) % n], b = px[i]; let sum = 0;
      for (let p = 0; p < a.length; p += 4) { const wa = a[p + 3], wb = b[p + 3]; sum += 2 * Math.abs(wa - wb) + (Math.abs(a[p] * wa - b[p] * wb) + Math.abs(a[p + 1] * wa - b[p + 1] * wb) + Math.abs(a[p + 2] * wa - b[p + 2] * wb)) / 255; }
      v[i] = sum / (S * S) / (dur(i) / 1000);
      vMean += v[i] / n; dMean += dur(i) / n; yMin = Math.min(yMin, cy[i]); yMax = Math.max(yMax, cy[i]);
    }
    const acc = new Float32Array(n); let top = 0;
    for (let i = 0; i < n; i++) {
      const dip = Math.max(0, (v[(i + n - 1) % n] + v[(i + 1) % n]) / 2 - v[i]) / (vMean + 1e-6);
      const low = yMax > yMin + 0.5 ? (cy[i] - yMin) / (yMax - yMin) : 0.5;
      const hold = Math.max(0, dur(i) / dMean - 1);
      acc[i] = dip * (0.6 + 0.4 * low) + 0.5 * hold;
      top = Math.max(top, acc[i]);
    }
    if (top > 0) for (let i = 0; i < n; i++) acc[i] /= top;
    return acc;
  } catch (e) { console.warn('sprite accents', e); return null; }
}
function loadSprite(id, fresh = false) {
  if (fresh) spriteCache.delete(id);
  if (!spriteCache.has(id)) {
    spriteCache.set(id, (async () => {
      const meta = await api.json(`/api/sprites/${id}`);
      if (!meta.ready) throw new Error(meta.error || 'This dancer is not ready yet.');
      const image = new Image();
      image.src = `/api/sprites/${id}/atlas.png?v=${meta.version}`;
      await image.decode();
      return { meta, image, accents: spriteAccents(image, meta) };
    })().catch((e) => { spriteCache.delete(id); throw e; }));
  }
  return spriteCache.get(id);
}
async function hydrateDancers() {
  const gone = [];
  await Promise.all(state.dancers.map(async (d) => {
    try { d.sprite = await loadSprite(d.spriteId); }
    catch (e) { if (/Unknown dancer/.test(e.message)) gone.push(d); else console.warn('dancer', d.spriteId, e); }
  }));
  if (gone.length) { state.dancers = state.dancers.filter((d) => !gone.includes(d)); toast(gone.length === 1 ? 'A dancer was missing from the cache and was removed.' : `${gone.length} dancers were missing from the cache and were removed.`, { error: true }); }
  renderDancers();
  invalidate();
}
// liveliness analysis of each ready song, fetched once (the server keeps it); drives the auto mode and the review list
const analysisJobs = new Map();
function ensureAnalyses(force = false) {
  if (force || state.dancers.length) {
    for (const s of state.songs) {
      if (!s.ready || s.error || s.uploading || analysisJobs.has(s.id)) continue;
      if (s.analysis && ((s.analysis.v || 1) >= 2 || s.analysisRetried)) continue; // an older analysis has no beat times: ask once more
      if (s.analysis) s.analysisRetried = true;
      const id = s.id;
      const p = api.json(`/api/songs/${id}/analysis`)
        .then((a) => { const song = songById(id); if (song) { song.analysis = a; updateRow(song); if (danceOpen) renderDanceRows(); updateDanceUI(); invalidate(); } })
        .catch((e) => console.warn('analysis failed for', s.title, e.message))
        .finally(() => analysisJobs.delete(id));
      analysisJobs.set(id, p);
    }
  }
  return Promise.all([...analysisJobs.values()]);
}
// waveform peaks for the waveform-style progress bar, fetched once per song
const waveformJobs = new Map();
function ensureWaveforms() {
  if (state.look.progress === 'wave') {
    for (const s of state.songs) {
      if (!s.ready || s.error || s.uploading || s.waveform || waveformJobs.has(s.id)) continue;
      const id = s.id;
      const p = api.json(`/api/songs/${id}/waveform`).then((w) => { const song = songById(id); if (song) { song.waveform = w; invalidate(); } }).catch((e) => console.warn('waveform failed for', s.title, e.message)).finally(() => waveformJobs.delete(id));
      waveformJobs.set(id, p);
    }
  }
  return Promise.all([...waveformJobs.values()]);
}
const logoImages = new Map(); // id -> Promise<Image>
function hydrateLogo() {
  const lg = state.logo;
  if (!lg || !lg.id) { if (lg) lg.image = null; return Promise.resolve(); }
  if (!logoImages.has(lg.id)) logoImages.set(lg.id, new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error('The logo could not be loaded.')); img.src = `/api/logos/${lg.id}.png`; }));
  return logoImages.get(lg.id).then((img) => { if (state.logo.id === lg.id) { state.logo.image = img; invalidate(); } }).catch((e) => { if (/loaded/.test(e.message) && state.logo.id === lg.id) { state.logo.id = null; state.logo.image = null; renderLogoUI(); toast('The logo image was missing from the cache and was removed.', { error: true }); } });
}
function freePlace() { const used = new Set(state.dancers.map((d) => d.place)); return (DANCE_PLACES.find((p) => p.id !== 'custom' && !used.has(p.id)) || DANCE_PLACES[0]).id; }
async function addDancer(spriteId, replace = null) {
  if (!replace && state.dancers.length >= MAX_DANCERS) return toast(`Up to ${MAX_DANCERS} dancers per mix.`);
  let sprite;
  try { sprite = await loadSprite(spriteId, true); } catch (e) { return toast(e.message, { error: true }); }
  if (replace) { replace.spriteId = spriteId; replace.sprite = sprite; }
  else state.dancers.push({ id: newDancerId(), spriteId, place: freePlace(), size: DANCE_SIZE.def, flip: false, shadow: true, tempo: 'instep', speed: 1, x: 0.5, y: 0.85, sprite });
  renderDancers();
  invalidate();
  ensureAnalyses();
  if (!replace) { selectTab('dancers'); toast(`“${sprite.meta.name}” joined the mix.`); }
}
function removeDancer(id) {
  const i = state.dancers.findIndex((d) => d.id === id); if (i < 0) return;
  const [d] = state.dancers.splice(i, 1);
  renderDancers(); invalidate();
  toast(`Removed “${d.sprite ? d.sprite.meta.name : 'the dancer'}”.`, { duration: 5000, action: { label: 'Undo', run: () => { state.dancers.splice(Math.min(i, state.dancers.length), 0, d); renderDancers(); invalidate(); } } });
}
async function rebuildSprite(d, opts) { // re-key or re-time the frames on the server, then refresh every dancer that uses the sprite
  const cards = $$('.dancer-card'); cards.forEach((c) => c.classList.add('is-busy'));
  try {
    await api.json(`/api/sprites/${d.spriteId}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts) });
    const sprite = await loadSprite(d.spriteId, true);
    for (const o of state.dancers) if (o.spriteId === d.spriteId) o.sprite = sprite;
    renderDancers(); invalidate();
  } catch (e) { toast(e.message, { error: true }); cards.forEach((c) => c.classList.remove('is-busy')); }
}
async function renameSprite(d, name) {
  try { const meta = await api.json(`/api/sprites/${d.spriteId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }); for (const o of state.dancers) if (o.spriteId === d.spriteId && o.sprite) o.sprite.meta.name = meta.name; }
  catch (e) { toast(e.message, { error: true }); }
}

// the little pictograms of the places: a frame with the artwork, the list and a dot where the dancer stands
function placeIcon(id) {
  const frame = '<rect class="pframe" x="1" y="1" width="42" height="26" rx="3"/>';
  const art = (x, y, s) => `<rect class="part" x="${x}" y="${y}" width="${s}" height="${s}" rx="1.2"/>`;
  const lines = (x, w, ys) => ys.map((y) => `<path class="pline" d="M${x} ${y}h${w}"/>`).join('');
  const dot = (x, y) => `<circle class="pdot" cx="${x}" cy="${y}" r="2.6"/>`;
  let body = '';
  switch (id) {
    case 'under-art': body = art(6, 5, 9) + lines(22, 16, [7, 12, 17, 22]) + dot(10.5, 21); break;
    case 'beside-art': body = art(5, 8, 9) + lines(26, 13, [7, 12, 17, 22]) + dot(18.5, 17); break;
    case 'beside-list': body = art(6, 8, 9) + lines(21, 11, [7, 12, 17, 22]) + dot(37.5, 20); break;
    case 'corner': body = art(6, 8, 9) + lines(22, 16, [7, 12, 17]) + dot(38, 22); break;
    case 'on-art': body = art(6, 7, 10) + lines(22, 16, [7, 12, 17, 22]) + dot(15.5, 17); break;
    case 'by-title': body = art(6, 8, 9) + `<path class="pline pline-strong" d="M22 7h10"/>` + lines(22, 16, [13, 18, 23]) + dot(36, 7); break;
    case 'custom': body = art(6, 8, 9) + lines(22, 16, [7, 12, 17, 22]) + '<rect class="pdash" x="13" y="11" width="12" height="11" rx="1.5"/>' + dot(19, 16.5); break;
    default: body = art(6, 8, 9) + lines(22, 16, [7, 12, 17, 22]);
  }
  return `<svg viewBox="0 0 44 28" aria-hidden="true">${frame}${body}</svg>`;
}
const dancerUI = { list: $('#dancerList'), empty: $('#dancerEmpty'), rules: $('#danceRules'), addRow: $('#dancerAddRow'), summary: $('#danceSummary'), sensRow: $('#danceSensRow'), hint: $('#danceHint') };
const dancerThumbs = []; // { canvas, dancer }
let thumbRaf = 0;
function dancerCard(d, k) {
  const m = d.sprite ? d.sprite.meta : null;
  const card = el('div', 'dancer-card');
  card.dataset.id = d.id;
  card.innerHTML = `
    <div class="dancer-head">
      <div class="dancer-thumb"><canvas width="112" height="112"></canvas></div>
      <div class="dancer-info"><input class="dancer-name" spellcheck="false" autocomplete="off" aria-label="Dancer name" maxlength="80" placeholder="Dancer"><span class="dancer-meta"></span></div>
      <button class="btn btn-icon dancer-more" aria-label="More" data-tip="More">${icon('more')}</button>
    </div>
    <div class="places places-dance" role="radiogroup" aria-label="Where the dancer stands">${DANCE_PLACES.map((p) => `<button type="button" data-value="${p.id}" data-tip="${p.label}" aria-label="${p.label}">${placeIcon(p.id)}</button>`).join('')}</div>
    <p class="hint dancer-hint" hidden>Drag it in the preview to put it anywhere. Over the artwork or the list it gets a little stage of its own.</p>
    <div class="row"><label>Size</label><div class="range-wrap"><input type="range" data-range="dancers.${k}.size" min="${DANCE_SIZE.min}" max="${DANCE_SIZE.max}" step="0.01" aria-label="Size"><span class="val" data-val="dancers.${k}.size"></span></div></div>
    <div class="row dancer-tempo"><label>Tempo</label><div class="seg seg-sm seg-wide" data-seg="dancers.${k}.tempo" role="radiogroup" aria-label="Tempo"><button type="button" data-value="instep">In step</button><button type="button" data-value="beat">On the beat</button><button type="button" data-value="natural">Own pace</button><span class="seg-thumb"></span></div><p class="hint dancer-tempo-hint"></p></div>
    <div class="row dancer-speed"><label>Speed</label><div class="range-wrap"><input type="range" data-range="dancers.${k}.speed" min="0.25" max="3" step="0.05" aria-label="Speed"><span class="val" data-val="dancers.${k}.speed"></span></div></div>
    <div class="row"><label for="dancerFlip${k}">Mirror</label><label class="switch"><input type="checkbox" id="dancerFlip${k}" data-switch="dancers.${k}.flip"><span class="knob"></span></label></div>
    <div class="row"><label for="dancerShadow${k}">Shadow</label><label class="switch"><input type="checkbox" id="dancerShadow${k}" data-switch="dancers.${k}.shadow"><span class="knob"></span></label></div>`;
  const name = card.querySelector('.dancer-name');
  name.value = m ? m.name : '';
  name.addEventListener('change', () => { const v = name.value.trim(); if (v && m && v !== m.name) renameSprite(d, v); else name.value = m ? m.name : ''; });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') name.blur(); e.stopPropagation(); });
  name.addEventListener('focus', () => name.select());
  card.querySelector('.dancer-meta').textContent = m ? `${m.frames} ${m.frames === 1 ? 'frame' : 'frames'} · ${(m.loop / 1000).toFixed(1)} s · ${m.native.w} × ${m.native.h}${m.crisp ? ' · pixel art' : ''}` : 'Loading…';
  card.querySelector('.dancer-more').addEventListener('click', (e) => {
    const items = [{ label: 'Replace…', icon: 'image', action: () => openDancerSheet(d) }];
    if (m && m.keyable) items.push({ label: 'Knock out the background', checked: !!m.key, action: () => rebuildSprite(d, { key: !m.key }) });
    if (m) items.push({ label: 'Crisp pixels', checked: !!m.crisp, action: () => rebuildSprite(d, { crisp: !m.crisp }) });
    if (m && m.kinds && m.kinds.includes('image') && m.frames > 1) items.push({ label: 'Faster frames', icon: 'arrow', action: () => rebuildSprite(d, { fps: Math.min(60, Math.round(m.fps * 1.5)) }) }, { label: 'Slower frames', icon: 'reset', action: () => rebuildSprite(d, { fps: Math.max(1, Math.round(m.fps / 1.5)) }) });
    items.push('-', { label: 'Reset settings', icon: 'reset', action: () => { Object.assign(d, DANCER_DEFAULTS); renderDancers(); invalidate(); toast(`“${m ? m.name : 'Dancer'}”: size, tempo, mirror and shadow are back to the defaults.`); } });
    items.push({ label: 'Remove dancer', icon: 'close', danger: true, action: () => removeDancer(d.id) });
    menu.open(e.currentTarget, items);
  });
  bindPlaces(card.querySelector('.places'), `dancers.${k}.place`);
  for (const seg of $$('[data-seg]', card)) bindSeg(seg);
  for (const r of $$('[data-range]', card)) bindRange(r);
  for (const sw of $$('[data-switch]', card)) bindSwitch(sw);
  card.querySelector('.dancer-speed').hidden = d.tempo !== 'natural';
  if (d.sprite) dancerThumbs.push({ canvas: card.querySelector('canvas'), dancer: d });
  return card;
}
function bindPlaces(box, path) { // a grid of pictogram radios bound to a state path
  const buttons = $$('button', box);
  const apply = () => { const v = getPath(state, path); buttons.forEach((b) => { b.setAttribute('role', 'radio'); b.setAttribute('aria-checked', String(v != null && b.dataset.value === v)); }); };
  buttons.forEach((b) => b.addEventListener('click', () => { if (getPath(state, path) === b.dataset.value || getPath(state, path) == null) return; setPath(state, path, b.dataset.value); apply(); onChange(path); }));
  box._apply = apply;
  apply();
}
function renderDancers() {
  dancerThumbs.length = 0;
  dancerUI.list.innerHTML = '';
  state.dancers.forEach((d, k) => dancerUI.list.append(dancerCard(d, k)));
  const any = state.dancers.length > 0;
  const badge = $('#dancersBadge'); badge.hidden = !any; badge.textContent = String(state.dancers.length);
  dancerUI.empty.hidden = any;
  dancerUI.addRow.hidden = !any || state.dancers.length >= MAX_DANCERS;
  dancerUI.rules.hidden = !any;
  updateDanceUI();
  animateThumbs();
}
const SENS_WORDS = ['Only the liveliest', 'Picky', 'Balanced', 'Easy-going', 'Nearly every track'];
const DANCE_HINTS = {
  auto: 'Liner listens to each track for a steady pulse, bass and loudness. Lively tracks get the dancers; calm ones stay as they are. Any track can be overridden in the review.',
  always: 'The dancers appear on every track. Single tracks can still be switched off in the review.',
};
const TEMPO_HINTS = {
  instep: 'Follows the track’s beats one by one: the loop spans whole beats and its poses land on them, so every dancer in step moves together, and keeps up when the tempo breathes.',
  beat: 'Runs the loop at the track’s average tempo from the start of the song. Over a long track the steps can drift away from the beat.',
  natural: 'Plays the loop at its own pace, times the speed below.',
};
function updateDanceUI() {
  if (!state.dancers.length) return;
  const auto = state.dance.mode !== 'always';
  dancerUI.sensRow.hidden = !auto;
  dancerUI.hint.textContent = DANCE_HINTS[auto ? 'auto' : 'always'];
  const songs = state.songs.filter((s) => !s.uploading && !s.error);
  let on = 0, pending = 0;
  for (const s of songs) { const a = dancerActive(s, state.dance); if (a === true) on++; else if (a === null) pending++; }
  dancerUI.summary.textContent = !songs.length ? 'Add songs to see where they appear.' : `On ${on} of ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}${pending ? ` · listening to ${pending}…` : ''}`;
  for (const c of $$('.dancer-card')) { const d = state.dancers.find((x) => x.id === c.dataset.id); const sp = c.querySelector('.dancer-speed'); if (d && sp) sp.hidden = d.tempo !== 'natural'; const th = c.querySelector('.dancer-tempo-hint'); if (d && th) th.textContent = TEMPO_HINTS[d.tempo] || TEMPO_HINTS.instep; const hint = c.querySelector('.dancer-hint'); if (d && hint) hint.hidden = d.place !== 'custom'; }
}
function animateThumbs() { // the cards' thumbnails play the loop while the Dancers tab is showing
  cancelAnimationFrame(thumbRaf);
  if (!dancerThumbs.length || currentTab !== 'dancers' || document.hidden) return;
  let lastThumb = 0;
  const step = (ts) => {
    if (ts - lastThumb < 1000 / 24) { thumbRaf = requestAnimationFrame(step); return; } // 24 draws a second is plenty for a thumbnail
    lastThumb = ts;
    const now = performance.now() / 1000;
    for (const { canvas, dancer } of dancerThumbs) {
      const sp = dancer.sprite; if (!sp) continue;
      const m = sp.meta, loop = Math.max(0.05, m.loop / 1000);
      const fi = frameAtPhase(m, (now % loop) / loop);
      const x = canvas.getContext('2d');
      x.clearRect(0, 0, canvas.width, canvas.height);
      const pad = 10, maxW = canvas.width - 2 * pad, maxH = canvas.height - 2 * pad;
      let s = Math.min(maxW / m.cell.w, maxH / m.cell.h);
      if (m.crisp) s = s >= 1 ? Math.floor(s) : s;
      const w = m.cell.w * s, h = m.cell.h * s;
      x.imageSmoothingEnabled = !m.crisp;
      x.save(); if (dancer.flip) { x.translate(canvas.width, 0); x.scale(-1, 1); }
      x.drawImage(sp.image, (fi % m.cols) * m.cell.w, Math.floor(fi / m.cols) * m.cell.h, m.cell.w, m.cell.h, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
      x.restore();
    }
    thumbRaf = requestAnimationFrame(step);
  };
  thumbRaf = requestAnimationFrame(step);
}
document.addEventListener('visibilitychange', animateThumbs);

// add-a-dancer sheet: drop or browse files, or pick a dancer added before
const dancerSheet = { root: $('#dancerSheet'), title: $('#dancerTitle'), drop: $('#dancerDrop'), browse: $('#dancerBrowse'), input: $('#dancerInput'), progress: $('#dancerProgress'), bar: $('#dancerBar'), text: $('#dancerProgressText'), lib: $('#spriteLib'), grid: $('#spriteGrid'), close: $('#dancerClose') };
let dancerSheetOpen = false, dancerSheetCloseTimer = null, dancerReplace = null, dancerBusy = false;
function openDancerSheet(replace = null) {
  if (job) return toast('Wait for the export to finish first.');
  if (!replace && state.dancers.length >= MAX_DANCERS) return toast(`Up to ${MAX_DANCERS} dancers per mix.`);
  dancerReplace = replace; dancerSheetOpen = true;
  dancerSheet.title.textContent = replace ? 'Replace the dancer' : 'Add a dancer';
  dancerSheet.progress.hidden = true;
  clearTimeout(dancerSheetCloseTimer);
  dancerSheet.root.hidden = false;
  requestAnimationFrame(() => dancerSheet.root.classList.add('is-open'));
  refreshSpriteLibrary();
}
function closeDancerSheet() {
  if (dancerBusy) return;
  dancerSheetOpen = false; dancerReplace = null;
  dancerSheet.root.classList.remove('is-open');
  clearTimeout(dancerSheetCloseTimer);
  dancerSheetCloseTimer = setTimeout(() => { dancerSheet.root.hidden = true; }, 200);
}
function spriteUsedElsewhere(spriteId) {
  for (const m of readMixIndex()) { if (m.id === currentMixId) continue; try { const st = JSON.parse(localStorage.getItem(MIX_KEY(m.id))); if (st && Array.isArray(st.dancers) && st.dancers.some((d) => d.spriteId === spriteId)) return true; } catch { /* ignore */ } }
  return false;
}
async function refreshSpriteLibrary() {
  let list = [];
  try { list = (await api.json('/api/sprites')).filter((s) => s.ready); } catch { /* offline */ }
  dancerSheet.grid.innerHTML = '';
  dancerSheet.lib.hidden = !list.length;
  for (const s of list) {
    const tile = el('button', 'sprite-tile');
    tile.type = 'button';
    tile.innerHTML = `<span class="sprite-img"><img alt="" draggable="false"></span><b></b><span class="sprite-sub"></span><span class="sprite-del" role="button" aria-label="Delete from the library" data-tip="Delete from the library">${icon('close')}</span>`;
    const img = tile.querySelector('img'); img.src = `/api/sprites/${s.id}/thumb.png?v=${s.version}`; img.classList.toggle('is-crisp', !!s.crisp);
    tile.querySelector('b').textContent = s.name;
    tile.querySelector('.sprite-sub').textContent = `${s.frames} ${s.frames === 1 ? 'frame' : 'frames'} · ${(s.loop / 1000).toFixed(1)} s`;
    tile.addEventListener('click', async (e) => {
      if (e.target.closest('.sprite-del')) {
        if (state.dancers.some((d) => d.spriteId === s.id) || spriteUsedElsewhere(s.id)) return toast('This dancer is in a mix. Remove it there first.');
        try { await api.json(`/api/sprites/${s.id}`, { method: 'DELETE' }); spriteCache.delete(s.id); tile.remove(); if (!dancerSheet.grid.children.length) dancerSheet.lib.hidden = true; } catch (err) { toast(err.message, { error: true }); }
        return;
      }
      const replace = dancerReplace;
      closeDancerSheet();
      await addDancer(s.id, replace);
    });
    dancerSheet.grid.append(tile);
  }
}
function setDancerProgress(frac, text) { dancerSheet.progress.hidden = false; dancerSheet.bar.parentElement.classList.toggle('is-indeterminate', frac == null); dancerSheet.bar.style.transform = `scaleX(${frac == null ? 1 : clamp01(frac).toFixed(3)})`; dancerSheet.text.textContent = text; }
async function addDancerFromFiles(files, replace = dancerReplace) {
  const list = [...files].filter(isSpriteFile).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  if (!list.length) return toast('Drop a GIF, an animated PNG, a short video or some images.', { error: true });
  if (dancerBusy) return;
  if (!dancerSheetOpen) openDancerSheet(replace);
  dancerBusy = true;
  dancerSheet.drop.classList.add('is-busy');
  const base = list[0].name.replace(/\.[^.]+$/, '').replace(/[_-]?\d+$/, '').replace(/[_]+/g, ' ').trim() || 'Dancer';
  const name = list.length === 1 ? base : `${base} (${list.length} images)`;
  let sprite = null;
  try {
    setDancerProgress(0, 'Uploading…');
    sprite = await api.json('/api/sprites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const totalBytes = list.reduce((a, f) => a + f.size, 0);
    let doneBytes = 0;
    for (const f of list) {
      await api.upload(`/api/sprites/${sprite.id}/source`, f, (p) => setDancerProgress((doneBytes + p * f.size) / totalBytes, list.length === 1 ? 'Uploading…' : `Uploading ${list.indexOf(f) + 1} of ${list.length}…`));
      doneBytes += f.size;
    }
    setDancerProgress(null, 'Preparing the frames…');
    await api.json(`/api/sprites/${sprite.id}/build`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fps: 8 }) });
    dancerBusy = false;
    closeDancerSheet();
    await addDancer(sprite.id, replace);
  } catch (e) {
    if (sprite) api.json(`/api/sprites/${sprite.id}`, { method: 'DELETE' }).catch(() => {});
    toast(e.message, { error: true, duration: 7000 });
    dancerSheet.progress.hidden = true;
  } finally { dancerBusy = false; dancerSheet.drop.classList.remove('is-busy'); }
}
dancerSheet.browse.addEventListener('click', () => dancerSheet.input.click());
dancerSheet.input.addEventListener('change', (e) => { addDancerFromFiles(e.target.files); e.target.value = ''; });
dancerSheet.drop.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); dancerSheet.drop.classList.add('is-over'); });
dancerSheet.drop.addEventListener('dragleave', () => dancerSheet.drop.classList.remove('is-over'));
dancerSheet.drop.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); dancerSheet.drop.classList.remove('is-over'); addDancerFromFiles(e.dataTransfer.files); });
dancerSheet.close.addEventListener('click', closeDancerSheet);
dancerSheet.root.addEventListener('pointerdown', (e) => { if (e.target === dancerSheet.root) closeDancerSheet(); });
$('#dancerAddBtn').addEventListener('click', () => openDancerSheet());
for (const b of $$('.pane-reset')) b.addEventListener('click', () => resetPane(b.dataset.pane));
$('#dancerAddBtn2').addEventListener('click', () => openDancerSheet());
$('#danceReview').addEventListener('click', () => openDanceSheet());
// the Dancers pane accepts drops of sprites directly
for (const zone of [dancerUI.empty, dancerUI.list]) {
  zone.addEventListener('dragover', (e) => { if (hasImage(e.dataTransfer) || [...(e.dataTransfer.items || [])].some((it) => it.type.startsWith('video/'))) { e.preventDefault(); e.stopPropagation(); zone.classList.add('is-over'); } });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', (e) => { zone.classList.remove('is-over'); const files = [...e.dataTransfer.files].filter(isSpriteFile); if (files.length) { e.preventDefault(); e.stopPropagation(); addDancerFromFiles(files, null); } });
}

// review sheet: which tracks get the dancers, and why
const danceSheet = { root: $('#danceSheet'), list: $('#danceList'), count: $('#danceCount'), done: $('#danceDone') };
let danceOpen = false, danceCloseTimer = null;
function openDanceSheet() {
  danceOpen = true;
  clearTimeout(danceCloseTimer);
  danceSheet.root.hidden = false;
  renderDanceRows();
  requestAnimationFrame(() => { danceSheet.root.classList.add('is-open'); renderDanceRows(); });
  ensureAnalyses(true);
}
function closeDanceSheet() {
  danceOpen = false;
  danceSheet.root.classList.remove('is-open');
  clearTimeout(danceCloseTimer);
  danceCloseTimer = setTimeout(() => { danceSheet.root.hidden = true; }, 200);
}
function renderDanceRows() {
  const songs = state.songs.filter((s) => !s.uploading);
  danceSheet.list.innerHTML = '';
  let on = 0, pending = 0;
  for (const s of songs) {
    const a = s.analysis, active = dancerActive(s, state.dance);
    if (active === true) on++; else if (active === null) pending++;
    const row = el('div', 'dance-row');
    row.classList.toggle('is-on', active === true);
    row.innerHTML = `<div class="dance-thumb"></div><div class="dance-info"><b></b><span class="dance-sub"></span></div><div class="dance-energy"><div class="meter"><i></i></div><span class="dance-label"></span></div><div class="seg seg-sm dance-seg" role="radiogroup" aria-label="Dancers on this track"><button type="button" data-value="auto">Auto</button><button type="button" data-value="on">On</button><button type="button" data-value="off">Off</button><span class="seg-thumb"></span></div>`;
    const th = row.querySelector('.dance-thumb');
    if (s.image instanceof HTMLImageElement) { const img = new Image(); img.src = s.image.src; img.alt = ''; th.append(img); }
    else if (s.image) { const c = document.createElement('canvas'); c.width = c.height = 80; c.getContext('2d').drawImage(s.image, 0, 0, 80, 80); th.append(c); }
    row.querySelector('b').textContent = s.title || 'Untitled';
    row.querySelector('.dance-sub').textContent = s.artist || s.album || '';
    row.querySelector('.meter').style.setProperty('--p', `${a ? Math.round(a.score * 100) : 0}%`);
    const label = row.querySelector('.dance-label');
    label.textContent = s.error ? 'Could not be read' : a ? `${a.label} · ${Math.round(a.bpm)} BPM` : s.ready ? 'Listening…' : 'Preparing…';
    label.dataset.level = a ? a.label.toLowerCase() : '';
    if (a) label.title = `Pulse ${Math.round(a.parts.beat * 100)}% · onsets ${Math.round(a.parts.drive * 100)}% · bass ${Math.round(a.parts.bass * 100)}% · loudness ${Math.round(a.parts.loud * 100)}% · score ${Math.round(a.score * 100)}%${Array.isArray(a.beats) ? ` · ${a.beats.length} beats tracked, ${Math.round((a.beatConf || 0) * 100)}% sure` : ''}`;
    const seg = row.querySelector('.dance-seg');
    const value = () => s.dancer === 'on' || s.dancer === 'off' ? s.dancer : 'auto';
    $$('button', seg).forEach((b) => b.addEventListener('click', () => { const v = b.dataset.value; if (v === value()) return; s.dancer = v === 'auto' ? undefined : v; paintSeg(seg, value()); invalidate(); renderDanceRows(); }));
    danceSheet.list.append(row);
    paintSeg(seg, value(), false);
  }
  if (!songs.length) danceSheet.list.append(el('div', 'link-empty', 'Add songs first.'));
  danceSheet.count.textContent = songs.length ? `On ${on} of ${songs.length} ${songs.length === 1 ? 'track' : 'tracks'}${pending ? ` · listening to ${pending}…` : ''} · threshold ${Math.round(danceThreshold(state.dance.sensitivity) * 100)}%` : '';
  $('#danceAllAuto').hidden = !songs.some((s) => s.dancer === 'on' || s.dancer === 'off');
}
danceSheet.done.addEventListener('click', closeDanceSheet);
$('#danceAllAuto').addEventListener('click', () => { const before = state.songs.filter((s) => s.dancer === 'on' || s.dancer === 'off').map((s) => [s, s.dancer]); if (!before.length) return; for (const s of state.songs) s.dancer = undefined; invalidate(); renderDanceRows(); toast('Every track follows Auto again.', { duration: 6000, action: { label: 'Undo', run: () => { for (const [s, v] of before) s.dancer = v; invalidate(); if (danceOpen) renderDanceRows(); } } }); });
danceSheet.root.addEventListener('pointerdown', (e) => { if (e.target === danceSheet.root) closeDanceSheet(); });

// ---------------------------------------------------------------- frequency visualizer
const spectrumJobs = new Map(), spectrumRetryAt = new Map();
let spectrumWarned = false;
function ensureSpectra() { // each ready song's band levels, fetched once (the server keeps the file)
  if (state.viz.style !== 'off') {
    for (const s of state.songs) {
      if (!s.ready || s.error || s.uploading || s.spectrum || spectrumJobs.has(s.id) || (spectrumRetryAt.get(s.id) || 0) > Date.now()) continue;
      const id = s.id;
      const p = fetch(`/api/songs/${id}/spectrum?v=1`).then(async (r) => { if (!r.ok) throw Object.assign(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`), { status: r.status }); return parseSpectrum(await r.arrayBuffer()); })
        .then((sp) => { const song = songById(id); if (song) { song.spectrum = sp; invalidate(); } })
        .catch((e) => {
          spectrumRetryAt.set(id, Date.now() + 15000);
          console.warn('spectrum failed for', s.title, e.message);
          if (e.status === 404 && !spectrumWarned) { spectrumWarned = true; toast('The visualizer needs the current Liner server, and the one running is older. Restart it, then reload this page.', { error: true, duration: 12000 }); }
        })
        .finally(() => spectrumJobs.delete(id));
      spectrumJobs.set(id, p);
    }
  }
  return Promise.all([...spectrumJobs.values()]);
}
function vizPlaceIcon(id) {
  const frame = '<rect class="pframe" x="1" y="1" width="42" height="26" rx="3"/>';
  const art = (x, y, s) => `<rect class="part" x="${x}" y="${y}" width="${s}" height="${s}" rx="1.2"/>`;
  const lines = (x, w, ys) => ys.map((y) => `<path class="pline" d="M${x} ${y}h${w}"/>`).join('');
  const bars = (x, y, w, h, cls = 'pbars') => { const hs = [0.45, 0.9, 0.65, 1, 0.5, 0.8, 0.35]; const n = w > 20 ? 7 : 5, bw = w / n; return `<g class="${cls}">${hs.slice(0, n).map((f, i) => `<rect x="${(x + i * bw + bw * 0.15).toFixed(1)}" y="${(y + h - h * f).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(h * f).toFixed(1)}" rx="0.6"/>`).join('')}</g>`; };
  let body = '';
  switch (id) {
    case 'under-art': body = art(6, 4, 9) + bars(5.5, 16, 10, 7) + lines(22, 16, [7, 12, 17, 22]); break;
    case 'on-art': body = art(6, 7, 10) + bars(7.2, 11.5, 7.6, 4.5) + lines(22, 16, [7, 12, 17, 22]); break;
    case 'bottom': body = art(6, 5, 9) + lines(22, 16, [6, 10, 14]) + bars(4, 19, 36, 6); break;
    case 'top': body = bars(4, 3, 36, 6) + art(6, 13, 9) + lines(22, 16, [14, 18, 22]); break;
    case 'behind': body = bars(3, 8, 38, 18, 'pbars pbars-faint') + art(6, 6, 9) + lines(22, 16, [7, 12, 17, 22]); break;
    default: body = art(6, 6, 9) + lines(22, 16, [7, 12, 17, 22]) + '<rect class="pdash" x="15" y="12" width="14" height="10" rx="1.5"/>' + bars(16.5, 13.5, 11, 7);
  }
  return `<svg viewBox="0 0 44 28" aria-hidden="true">${frame}${body}</svg>`;
}
$('#vizPlaces').innerHTML = VIZ_PLACES.map((p) => `<button type="button" data-value="${p.id}" data-tip="${p.label}" aria-label="${p.label}">${vizPlaceIcon(p.id)}</button>`).join('');
const VIZ_HINTS = {
  'under-art': 'Sits under the artwork; the artwork gives up a little height for it.',
  'on-art': 'Drawn over the lower part of the artwork, on a soft shade.',
  bottom: 'A strip along the bottom edge; the list and artwork move up.',
  top: 'A strip along the top edge; everything else moves down.',
  behind: 'Rises faintly from the bottom edge behind everything else.',
  custom: 'Drag it in the preview to put it anywhere. Width and height below.',
};
function updateVizUI() {
  const v = state.viz, on = v.style !== 'off';
  $('#vizOptions').hidden = !on;
  if (!on) return;
  $('#vizWidthRow').hidden = v.place !== 'custom';
  $('#vizMirrorRow').hidden = v.style === 'bands';
  $('#vizLabelsRow').hidden = v.style === 'bands' || v.place === 'behind';
  $('#vizLabelSizeRow').hidden = v.style === 'bands' || v.place === 'behind' || !v.labels;
  $('#vizGuidesRow').hidden = v.style === 'bands' || v.place === 'behind';
  $('#vizHint').textContent = VIZ_HINTS[v.place] || '';
  updateScrollFades();
}
// ---------------------------------------------------------------- captions and logo
const captionUI = { list: $('#captionList'), add: $('#captionAdd') };
function renderCaptions() {
  captionUI.list.innerHTML = '';
  state.captions.forEach((c, k) => {
    const row = el('div', 'caption');
    row.dataset.id = c.id;
    row.innerHTML = `
      <div class="caption-line"><input class="input caption-text" type="text" placeholder="Your caption" spellcheck="false" autocomplete="off" maxlength="120" aria-label="Caption text"><button class="btn btn-icon btn-sm caption-remove" aria-label="Remove caption" data-tip="Remove">${icon('close')}</button></div>
      <div class="row"><label>Size</label><div class="range-wrap"><input type="range" data-range="captions.${k}.size" min="0.012" max="0.2" step="0.002" aria-label="Size"><span class="val" data-val="captions.${k}.size"></span></div></div>
      <div class="row"><label id="capColor${k}">Style</label><div class="caption-style"><div class="seg seg-sm" data-seg="captions.${k}.color" role="radiogroup" aria-labelledby="capColor${k}"><button type="button" data-value="white">White</button><button type="button" data-value="album">Album</button><span class="seg-thumb"></span></div><label class="switch" data-tip="Bold"><input type="checkbox" data-switch="captions.${k}.bold" aria-label="Bold"><span class="knob"></span></label></div></div>
      <div class="row"><label>Opacity</label><div class="range-wrap"><input type="range" data-range="captions.${k}.opacity" min="0.05" max="1" step="0.01" aria-label="Opacity"><span class="val" data-val="captions.${k}.opacity"></span></div></div>`;
    const text = row.querySelector('.caption-text');
    text.value = c.text;
    text.addEventListener('input', () => { c.text = text.value; invalidate(); });
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') text.blur(); e.stopPropagation(); });
    row.querySelector('.caption-remove').addEventListener('click', () => { const i = state.captions.indexOf(c); if (i < 0) return; state.captions.splice(i, 1); renderCaptions(); invalidate(); toast('Caption removed.', { duration: 5000, action: { label: 'Undo', run: () => { state.captions.splice(Math.min(i, state.captions.length), 0, c); renderCaptions(); invalidate(); } } }); });
    for (const seg of $$('[data-seg]', row)) bindSeg(seg);
    for (const rg of $$('[data-range]', row)) bindRange(rg);
    for (const sw of $$('[data-switch]', row)) bindSwitch(sw);
    captionUI.list.append(row);
  });
  $('#captionHint').hidden = !state.captions.length;
  captionUI.add.hidden = state.captions.length >= 6;
  updateScrollFades();
}
captionUI.add.addEventListener('click', () => {
  if (state.captions.length >= 6) return;
  const r = preview.renderer, spot = r ? r.freeSpot(420, 40) : null; // about the size of a short caption
  state.captions.push({ id: Math.random().toString(36).slice(2, 10), text: '', x: spot ? spot.x : 0.5, y: spot ? spot.y : 0.9, size: 0.032, color: 'white', bold: false, opacity: 0.92 });
  renderCaptions(); invalidate();
  const input = captionUI.list.lastElementChild && captionUI.list.lastElementChild.querySelector('.caption-text');
  if (input) input.focus();
});
const logoUI = { empty: $('#logoEmpty'), current: $('#logoCurrent'), thumb: $('#logoThumb'), name: $('#logoName'), options: $('#logoOptions'), input: $('#logoInput'), drop: $('#logoDrop'), browse: $('#logoBrowse'), remove: $('#logoRemove'), places: $('#logoPlaces') };
const LOGO_PLACES = [{ id: 'top-left', label: 'Top left' }, { id: 'top-right', label: 'Top right' }, { id: 'bottom-left', label: 'Bottom left' }, { id: 'bottom-right', label: 'Bottom right' }, { id: 'custom', label: 'Anywhere: drag it in the preview' }];
function logoPlaceIcon(id) {
  const frame = '<rect class="pframe" x="1" y="1" width="42" height="26" rx="3"/>';
  const art = '<rect class="part" x="6" y="8" width="9" height="9" rx="1.2"/>', lines = [8, 13, 18].map((y) => `<path class="pline" d="M22 ${y}h14"/>`).join('');
  const mark = (x, y) => `<rect class="pdot-sq" x="${x}" y="${y}" width="6" height="4" rx="1"/>`;
  const at = { 'top-left': mark(4, 3.5), 'top-right': mark(34, 3.5), 'bottom-left': mark(4, 20.5), 'bottom-right': mark(34, 20.5), custom: '<rect class="pdash" x="16" y="18" width="10" height="7" rx="1.5"/>' + mark(18, 19.5) }[id] || '';
  return `<svg viewBox="0 0 44 28" aria-hidden="true">${frame}${art}${lines}${at}</svg>`;
}
logoUI.places.innerHTML = LOGO_PLACES.map((p) => `<button type="button" data-value="${p.id}" data-tip="${p.label}" aria-label="${p.label}">${logoPlaceIcon(p.id)}</button>`).join('');
function renderLogoUI() {
  const lg = state.logo, has = !!lg.id;
  logoUI.empty.hidden = has; logoUI.current.hidden = !has; logoUI.options.hidden = !has;
  if (has) { logoUI.thumb.src = `/api/logos/${lg.id}.png`; logoUI.name.textContent = lg.name || 'Logo'; }
  $('#logoHint').textContent = lg.place === 'custom' ? 'Drag it in the preview to put it anywhere.' : 'Sits in a corner, clear of the margins. Drag it in the preview to put it anywhere.';
  for (const pl of $$('.places')) pl._apply && pl._apply();
  updateScrollFades();
}
async function setLogo(file) {
  if (!file || !(file.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|heic|tiff?)$/i.test(file.name))) return toast('Drop an image to use it as the logo.', { error: true });
  logoUI.drop.classList.add('is-busy');
  try {
    const meta = await api.upload('/api/logos', file);
    const old = state.logo.id;
    state.logo.id = meta.id; state.logo.name = meta.name; state.logo.image = null;
    if (!old && state.logo.place !== 'custom' && preview.renderer) { // first logo: the emptiest corner
      const r = preview.renderer, h = Math.round(state.logo.size * 1080), w = h * ((meta.w || 1) / (meta.h || 1)), inset = r.layout.M * 0.45;
      const corners = { 'top-left': [inset + w / 2, 40 + h / 2], 'top-right': [r.Wu - inset - w / 2, 40 + h / 2], 'bottom-left': [inset + w / 2, r.Hu - 40 - h / 2], 'bottom-right': [r.Wu - inset - w / 2, r.Hu - 40 - h / 2] };
      const best = r.freeSpot(w, h, Object.values(corners));
      const name = best && Object.keys(corners).find((k) => Math.abs(corners[k][0] / r.Wu - best.x) < 1e-6 && Math.abs(corners[k][1] / r.Hu - best.y) < 1e-6);
      if (name) state.logo.place = name;
    }
    renderLogoUI();
    await hydrateLogo();
    if (old && old !== meta.id) api.json(`/api/logos/${old}`, { method: 'DELETE' }).catch(() => {});
    invalidate();
    toast(`“${meta.name}” is the logo.`);
  } catch (e) { toast(e.message, { error: true }); }
  finally { logoUI.drop.classList.remove('is-busy'); }
}
logoUI.browse.addEventListener('click', () => logoUI.input.click());
logoUI.input.addEventListener('change', (e) => { setLogo(e.target.files[0]); e.target.value = ''; });
logoUI.drop.addEventListener('dragover', (e) => { if (hasImage(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); logoUI.drop.classList.add('is-over'); } });
logoUI.drop.addEventListener('dragleave', () => logoUI.drop.classList.remove('is-over'));
logoUI.drop.addEventListener('drop', (e) => { logoUI.drop.classList.remove('is-over'); const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/')); if (f) { e.preventDefault(); e.stopPropagation(); setLogo(f); } });
logoUI.remove.addEventListener('click', () => {
  const lg = state.logo, had = { id: lg.id, name: lg.name, image: lg.image };
  if (!had.id) return;
  lg.id = null; lg.name = ''; lg.image = null; renderLogoUI(); invalidate();
  toast('Logo removed.', { duration: 6000, action: { label: 'Undo', run: () => { Object.assign(state.logo, had); renderLogoUI(); invalidate(); }, expire: () => api.json(`/api/logos/${had.id}`, { method: 'DELETE' }).catch(() => {}) } });
});

// ---------------------------------------------------------------- videos: the mix's background video and the songs' own
const videoUI = { block: $('#videoBlock'), empty: $('#videoEmpty'), current: $('#videoCurrent'), thumb: $('#videoThumb'), name: $('#videoName'), meta: $('#videoMeta'), input: $('#videoInput'), drop: $('#videoDrop'), browse: $('#videoBrowse'), remove: $('#videoRemove'), options: $('#videoOptions'), status: $('#videoStatus'), motionHint: $('#motionHint') };
const videoMetas = new Map(); // id → Promise<meta>
function videoMeta(id, fresh = false) {
  if (fresh) videoMetas.delete(id);
  if (!videoMetas.has(id)) videoMetas.set(id, api.json(`/api/backgrounds/${id}`).catch((e) => { videoMetas.delete(id); throw e; }));
  return videoMetas.get(id);
}
const hasVideo = (dt) => dt && [...(dt.items || [])].some((it) => it.kind === 'file' && (it.type.startsWith('video/') || it.type === 'image/gif'));
const isVideoFile = (f) => f && (f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm|mkv|avi|gif|mpg|mpeg|ts|m2ts|wmv|ogv)$/i.test(f.name));
const videoLabel = (m) => `${m.w} × ${m.h} · ${m.fps} fps · ${formatTime(m.duration)}`;
// The preview's videos come from the same frame-exact decoder the export uses (h264.js), so the preview shows the
// very frame the export will draw at any time. One decoder per video the playhead is near; the others are closed
// and reopened on demand. Entries also hold the server's description of the video for the editor's cards.
const previewVideos = new Map(); // id → { meta, src: H264Source | null }
const previewProvider = {
  meta: (id) => { const v = previewVideos.get(id); return v && v.meta && v.meta.ready ? v.meta : null; },
  frame: (id) => { const v = previewVideos.get(id); return v && v.src ? v.src.current : null; },
};
const videoErrors = new Map(); // id → why the server could not prepare it (so a song's row does not pretend it has a video)
// what a song's video choice amounts to right now: off, ready, preparing, error, or missing (nothing chosen or dropped yet)
function songVideoState(s) {
  if (!s.videoUse || s.videoUse === 'off') return { status: 'off', id: null };
  if (s.videoPick !== 'other') {
    if (!s.videoSource) return { status: 'missing', id: null };
    const st = s.ownVideoStatus || 'none';
    return st === 'ready' && s.ownVideo ? { status: 'ready', id: s.ownVideo } : st === 'preparing' ? { status: 'preparing', id: null } : st === 'error' ? { status: 'error', id: null, error: s.ownVideoError } : { status: 'missing', id: null };
  }
  if (!s.videoId) return { status: 'missing', id: null };
  if (videoErrors.has(s.videoId)) return { status: 'error', id: null, error: videoErrors.get(s.videoId) };
  const v = previewVideos.get(s.videoId);
  return v && v.meta && v.meta.ready ? { status: 'ready', id: s.videoId } : { status: 'preparing', id: null };
}
function videoIdsInUse(st = state) {
  const ids = new Set();
  if (st.look.style === 'video' && st.look.videoId) ids.add(st.look.videoId);
  for (const s of st.songs) { const id = songVideoId(s); if (id) ids.add(id); }
  return [...ids];
}
function dropPreviewVideo(id) {
  const v = previewVideos.get(id); if (!v) return;
  if (v.src) v.src.close();
  previewVideos.delete(id);
}
async function ensurePreviewVideo(id) {
  if (previewVideos.has(id)) return previewVideos.get(id);
  const entry = { meta: null, src: null }; previewVideos.set(id, entry);
  try {
    let meta = await videoMeta(id);
    while (!meta.ready && !meta.error) { // the server is still transcoding it
      if (id === state.look.videoId) renderVideoUI(meta);
      await new Promise((r) => setTimeout(r, 1000));
      if (!previewVideos.has(id)) return null;
      meta = await videoMeta(id, true);
    }
    if (meta.error) throw new Error(meta.error);
    if (!previewVideos.has(id)) return null;
    entry.meta = meta;
    videoErrors.delete(id);
    if (id === state.look.videoId) renderVideoUI(meta);
    if (songSheetSong && songOpen) renderSongSheet();
    renderTracks();
    invalidate();
    return entry;
  } catch (e) {
    previewVideos.delete(id);
    const gone = /Unknown video/.test(e.message);
    if (!gone) videoErrors.set(id, e.message);
    if (state.look.videoId === id) {
      toast(gone ? 'The background video is no longer in the cache. Drop it again.' : `The background video could not be prepared: ${e.message}`, { error: true });
      if (gone) { state.look.videoId = null; state.look.videoName = ''; }
      renderVideoUI();
    }
    for (const s of state.songs) if (s.videoPick === 'other' && s.videoId === id) {
      if (gone) { s.videoId = null; s.videoName = ''; }
      else toast(`“${s.title || 'A song'}”: its video could not be prepared. ${e.message}`, { error: true, duration: 8000 });
    }
    if (songSheetSong && songOpen) renderSongSheet();
    renderTracks();
    invalidate();
    return null;
  }
}
// loads every video the mix uses (the mix's background, the songs' own or chosen videos) and lets go of the rest
function hydrateVideo() {
  const ids = videoIdsInUse();
  for (const id of [...previewVideos.keys()]) if (!ids.includes(id)) dropPreviewVideo(id);
  videoWindowKey = '';
  if (!ids.includes(state.look.videoId)) renderVideoUI();
  return Promise.all(ids.map(ensurePreviewVideo));
}
// the videos worth keeping a decoder for: the mix's background and those of the song at the playhead and its neighbours
function videoWindowIds() {
  const ids = new Set();
  if (state.look.style === 'video' && state.look.videoId) ids.add(state.look.videoId);
  const r = preview.renderer, n = r ? r.songs.length : 0;
  if (!n) { for (const s of state.songs) { const id = songVideoId(s); if (id) ids.add(id); } return ids; }
  const i = r.timeline.indexAt(player.t);
  for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) { const id = songVideoId(r.songs[k]); if (id) ids.add(id); }
  return ids;
}
let warnedDecoder = false;
function wakeVideo(id, entry) {
  if (!entry.meta || entry.src) return;
  if (!HAS_DECODER) { if (!warnedDecoder) { warnedDecoder = true; toast('This browser cannot decode video backgrounds (it has no WebCodecs), so the preview shows a plain colour there. Chrome or Edge can.', { error: true, duration: 10000 }); } return; }
  entry.src = new H264Source(`/api/backgrounds/${id}/stream.h264?v=${entry.meta.version}`, entry.meta); }
function parkVideo(entry) { if (!entry.src) return; entry.src.close(); entry.src = null; }
let videoWindowKey = '';
function parkFarVideos() {
  const keep = videoWindowIds(), key = [...keep].sort().join(',') + '|' + previewVideos.size;
  if (key === videoWindowKey) return;
  videoWindowKey = key;
  for (const [id, v] of previewVideos) { if (!keep.has(id)) parkVideo(v); }
}
// true when every video the frame at t needs already has that exact frame decoded (it is then drawn at once)
function videoFramesReady(t) {
  const r = preview.renderer; if (!r) return true;
  return r.videoNeeds(t).every((need) => { const v = previewVideos.get(need.id); return !v || !v.meta || !!(v.src && v.src.takeReady(videoFrameIndex(v.meta, need.vt))); });
}
// while playing: have the next output frame's video frames decoded before they are asked for, keeping the one on screen
function primeVideoFrames(t) {
  const r = preview.renderer; if (!r) return;
  for (const need of r.videoNeeds(t)) { const v = previewVideos.get(need.id); if (v && v.src) v.src.frameAt(videoFrameIndex(v.meta, need.vt), 1).catch(() => {}); }
}
const renderStats = { sync: 0, waited: 0 };
// decodes, for every video the frame at t needs, the exact frame the export would draw there
async function prepareVideoFrames(t) {
  const r = preview.renderer; if (!r) return;
  parkFarVideos();
  await Promise.all(r.videoNeeds(t).map(async (need) => {
    const v = previewVideos.get(need.id); if (!v || !v.meta) return;
    if (!v.src) wakeVideo(need.id, v);
    try { await v.src.frameAt(videoFrameIndex(v.meta, need.vt)); } catch (e) { if (!v.src || v.src.error) { parkVideo(v); } }
  }));
}
function renderVideoUI(meta) {
  const look = state.look, isVideo = look.style === 'video', has = !!look.videoId;
  videoUI.block.hidden = !isVideo;
  videoUI.motionHint.hidden = !isVideo;
  videoUI.motionHint.textContent = (+look.motion || 0) === 0 ? 'Still holds one frame of the video.' : +look.motion < 1 ? 'Slow plays the video at half speed.' : 'The video plays at its own speed, on a loop.';
  if (isVideo) {
    videoUI.empty.hidden = has; videoUI.current.hidden = !has; videoUI.options.hidden = !has;
    if (has) {
      const v = previewVideos.get(look.videoId), m = meta || (v && v.meta) || null;
      videoUI.name.textContent = look.videoName || 'Video';
      const poster = m && m.ready ? `/api/backgrounds/${look.videoId}/poster.jpg?v=${m.version}` : '';
      if (videoUI.thumb.getAttribute('src') !== poster) { if (poster) videoUI.thumb.src = poster; else videoUI.thumb.removeAttribute('src'); }
      videoUI.meta.textContent = m ? (m.error ? m.error : m.ready ? videoLabel(m) : 'Preparing…') : 'Loading…';
      videoUI.current.classList.toggle('is-busy', !!(m && !m.ready && !m.error));
      videoUI.current.classList.toggle('is-error', !!(m && m.error));
    }
  }
  updateScrollFades();
}
// a video stays in the store while any mix (this one included) still points at it
function videoInUse(id, except = null) {
  const uses = (st, mine) => (st.look && st.look.videoId === id) || (st.songs || []).some((s) => s !== except && (s.videoId === id || (mine && s.ownVideo === id)));
  if (uses(state, true)) return true;
  for (const m of readMixIndex()) { if (m.id === currentMixId) continue; try { if (uses(JSON.parse(localStorage.getItem(MIX_KEY(m.id))), false)) return true; } catch { /* ignore */ } }
  return false;
}
const dropVideo = (id) => { if (id && !videoInUse(id)) api.json(`/api/backgrounds/${id}`, { method: 'DELETE' }).catch(() => {}); };
// uploads a video into the store; the server keeps preparing it after this resolves (`status` shows the upload's progress)
async function uploadVideo(file, status) {
  const meta = await api.upload('/api/backgrounds', file, (f) => status(`Uploading… ${Math.round(f * 100)}%`));
  videoMetas.set(meta.id, Promise.resolve(meta));
  return meta;
}
async function setVideo(file) {
  if (!isVideoFile(file)) return toast('Drop a video file to use it as the background.', { error: true });
  videoUI.drop.classList.add('is-busy'); videoUI.status.textContent = 'Uploading…';
  try {
    const meta = await uploadVideo(file, (txt) => { videoUI.status.textContent = txt; });
    const old = state.look.videoId;
    state.look.videoId = meta.id; state.look.videoName = meta.name;
    if (!old && !(state.look.dim > 0)) { state.look.dim = 0.2; syncControls(); } // a first video: a touch of darkening keeps the type readable
    renderVideoUI(meta);
    invalidate();
    if (old && old !== meta.id) dropVideo(old);
    await hydrateVideo();
    if (state.look.videoId === meta.id && previewVideos.has(meta.id)) toast(`“${meta.name}” plays behind the mix.`);
  } catch (e) { toast(e.message, { error: true }); }
  finally { videoUI.drop.classList.remove('is-busy'); videoUI.status.textContent = ''; }
}
videoUI.browse.addEventListener('click', () => videoUI.input.click());
videoUI.input.addEventListener('change', (e) => { setVideo(e.target.files[0]); e.target.value = ''; });
videoUI.drop.addEventListener('dragover', (e) => { if (hasVideo(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); videoUI.drop.classList.add('is-over'); } });
videoUI.drop.addEventListener('dragleave', () => videoUI.drop.classList.remove('is-over'));
videoUI.drop.addEventListener('drop', (e) => { videoUI.drop.classList.remove('is-over'); const f = [...e.dataTransfer.files].find(isVideoFile); if (f) { e.preventDefault(); e.stopPropagation(); setVideo(f); } });
videoUI.remove.addEventListener('click', () => {
  const look = state.look, had = { videoId: look.videoId, videoName: look.videoName };
  if (!had.videoId) return;
  look.videoId = null; look.videoName = ''; hydrateVideo(); renderVideoUI(); invalidate();
  toast('Background video removed.', { duration: 6000, action: { label: 'Undo', run: () => { Object.assign(state.look, had); renderVideoUI(); hydrateVideo(); invalidate(); }, expire: () => dropVideo(had.videoId) } });
});

// the Background group's "Per song" button: pick a song to give it its own background or video
const songChoiceLabel = (s) => {
  const vs = songVideoState(s);
  const v = vs.status !== 'off' ? { background: 'video behind', art: 'video in the artwork', both: 'video behind and in the artwork' }[s.videoUse] + (vs.status === 'ready' ? '' : vs.status === 'preparing' ? ' (being prepared)' : vs.status === 'error' ? ' (failed)' : ' (no video yet)') : null;
  const bg = s.bg && s.bg.style ? { aurora: 'Aurora', cover: 'Cover', ink: 'Ink' }[s.bg.style] : null;
  return v || bg || 'same as the mix';
};
$('#perSongBtn').addEventListener('click', (e) => {
  const songs = state.songs.filter((s) => !s.error);
  if (!songs.length) return toast('Add songs first.');
  const items = songs.map((s) => ({ label: `${s.title || 'Untitled'} · ${songChoiceLabel(s)}`, icon: songVideoState(s).status === 'ready' ? 'video' : 'music', action: () => openSongSheet(s) }));
  menu.open(e.currentTarget, items);
});

// ---------------------------------------------------------------- saving and loading mixes (a safeguard beside the automatic saves)
const mixUI = {
  save: { root: $('#saveMixSheet'), here: $('#saveMixHere'), herePath: $('#saveMixHerePath'), elsewhere: $('#saveMixElse'), status: $('#saveMixStatus'), cancel: $('#saveMixCancel') },
  load: { root: $('#loadMixSheet'), list: $('#loadMixList'), elsewhere: $('#loadMixElse'), status: $('#loadMixStatus'), cancel: $('#loadMixCancel') },
};
let saveMixOpen = false, loadMixOpen = false;
const showSheet = (root) => { root.hidden = false; requestAnimationFrame(() => root.classList.add('is-open')); };
const hideSheet = (root) => { root.classList.remove('is-open'); setTimeout(() => { root.hidden = true; }, 200); };
const postJson = (url, body) => api.json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
function openSaveMix() {
  if (job) return toast('Wait for the export to finish first.');
  if (!caps.server) return toast('The Liner server is not reachable.', { error: true });
  saveNow();
  mixUI.save.herePath.textContent = caps.server.mixesDir || 'Liner/Mixes';
  mixUI.save.status.textContent = '';
  saveMixOpen = true; showSheet(mixUI.save.root);
}
function closeSaveMix() { saveMixOpen = false; hideSheet(mixUI.save.root); }
async function doSaveMix(where) {
  mixUI.save.status.textContent = where === 'ask' ? 'Choose a folder in the window that just opened…' : 'Saving…';
  mixUI.save.root.classList.add('is-busy');
  try {
    const r = await postJson('/api/mixes/save', { state: persistable(), title: state.title || 'Untitled mix', where });
    if (r.cancelled) { mixUI.save.status.textContent = ''; return; }
    closeSaveMix();
    toast(`Saved “${state.title || 'Untitled mix'}” (${r.sizeText}).`, { duration: 8000, action: { label: 'Reveal', run: () => api.reveal(r.path) } });
    for (const w of r.warnings || []) toast(w, { error: true, duration: 9000 });
  } catch (e) { mixUI.save.status.textContent = e.message; }
  finally { mixUI.save.root.classList.remove('is-busy'); }
}
mixUI.save.here.addEventListener('click', () => doSaveMix('app'));
mixUI.save.elsewhere.addEventListener('click', () => doSaveMix('ask'));
mixUI.save.cancel.addEventListener('click', closeSaveMix);
mixUI.save.root.addEventListener('click', (e) => { if (e.target === mixUI.save.root && !mixUI.save.root.classList.contains('is-busy')) closeSaveMix(); });
function openLoadMix() {
  if (job) return toast('Wait for the export to finish first.');
  if (!caps.server) return toast('The Liner server is not reachable.', { error: true });
  mixUI.load.status.textContent = '';
  loadMixOpen = true; showSheet(mixUI.load.root);
  renderSavedMixes();
}
function closeLoadMix() { loadMixOpen = false; hideSheet(mixUI.load.root); }
async function renderSavedMixes() {
  const list = mixUI.load.list;
  list.innerHTML = ''; list.append(el('div', 'link-empty', 'Looking…'));
  try {
    const items = await api.json('/api/mixes');
    list.innerHTML = '';
    if (!items.length) list.append(el('div', 'link-empty', 'Nothing saved in Liner’s Mixes folder yet. The mixes in the menu live in the browser’s own storage; Save mix… puts a copy of one here.'));
    for (const m of items) {
      const row = el('button', 'mix-row', '<b></b><span></span>'); row.type = 'button';
      row.querySelector('b').textContent = m.title || m.name;
      row.querySelector('span').textContent = `${m.savedAt ? new Date(m.savedAt).toLocaleString() : ''} · ${m.songs} ${m.songs === 1 ? 'song' : 'songs'} · ${fmtBytes(m.bytes)}`;
      row.addEventListener('click', () => doLoadMix({ path: m.path }));
      list.append(row);
    }
  } catch (e) { list.innerHTML = ''; list.append(el('div', 'link-empty', e.message)); }
}
async function doLoadMix(what) {
  mixUI.load.status.textContent = what.where === 'ask' ? 'Choose a folder in the window that just opened…' : 'Loading…';
  mixUI.load.root.classList.add('is-busy');
  try {
    const r = await postJson('/api/mixes/load', what);
    if (r.cancelled) { mixUI.load.status.textContent = ''; return; }
    closeLoadMix();
    const title = r.title || (r.state && r.state.title) || 'Untitled mix';
    createMix(r.state, { title });
    toast(`Loaded “${title}”${r.savedAt ? ` (saved ${new Date(r.savedAt).toLocaleDateString()})` : ''}.`);
    for (const w of r.warnings || []) toast(w, { error: true, duration: 9000 });
  } catch (e) { mixUI.load.status.textContent = e.message; }
  finally { mixUI.load.root.classList.remove('is-busy'); }
}
mixUI.load.elsewhere.addEventListener('click', () => doLoadMix({ where: 'ask' }));
mixUI.load.cancel.addEventListener('click', closeLoadMix);
mixUI.load.root.addEventListener('click', (e) => { if (e.target === mixUI.load.root && !mixUI.load.root.classList.contains('is-busy')) closeLoadMix(); });

// ---------------------------------------------------------------- ordering the songs
const SORTS = {
  title: { label: 'Sort by title', key: (s) => (s.title || '').toLowerCase() },
  artist: { label: 'Sort by artist', key: (s) => (s.artist || '').toLowerCase() },
  length: { label: 'Sort by length', key: (s) => songLength(s) },
  tempo: { label: 'Sort by tempo', key: (s) => (s.analysis ? s.analysis.bpm : Infinity), needsAnalysis: true },
  energy: { label: 'Sort by energy', key: (s) => (s.analysis ? -s.analysis.score : Infinity), needsAnalysis: true },
};
async function reorderSongs(how) {
  if (state.songs.length < 2) return;
  const before = state.songs.map((s) => s.id).join();
  if (how === 'reverse') state.songs.reverse();
  else if (how === 'shuffle') { for (let i = state.songs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [state.songs[i], state.songs[j]] = [state.songs[j], state.songs[i]]; } }
  else {
    const sort = SORTS[how]; if (!sort) return;
    if (sort.needsAnalysis && state.songs.some((s) => s.ready && !s.error && !s.analysis)) { toast('Listening to the tracks first…'); await ensureAnalyses(true); }
    const keyed = state.songs.map((s, i) => ({ s, i, k: sort.key(s) }));
    keyed.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i));
    state.songs = keyed.map((x) => x.s);
  }
  if (state.songs.map((s) => s.id).join() === before) return toast('The order is already like that.');
  renderTracks(); invalidate();
  toast(how === 'reverse' ? 'Order reversed.' : how === 'shuffle' ? 'Shuffled.' : `${SORTS[how].label.replace('Sort by', 'Sorted by')}.`);
}
$('#orderBtn').addEventListener('click', (e) => {
  const items = Object.entries(SORTS).map(([id, sort]) => ({ label: sort.label, icon: 'music', action: () => reorderSongs(id) }));
  items.push('-', { label: 'Reverse the order', icon: 'reset', action: () => reorderSongs('reverse') }, { label: 'Shuffle', icon: 'sparkles', action: () => reorderSongs('shuffle') });
  menu.open(e.currentTarget, items);
});

// ---------------------------------------------------------------- precise trims: the sound's own edges, and the beats
$('#trimSilenceBtn').addEventListener('click', async () => {
  const s = trimSong; if (!s) return;
  try {
    const w = s.waveform || (s.waveform = await api.json(`/api/songs/${s.id}/waveform`));
    const peaks = w.peaks || [], full = w.duration || s.duration || 0, n = peaks.length;
    if (!n || !full) return toast('No waveform for this song yet.');
    const floor = Math.max(0.006, Math.max(...peaks) * 0.012); // about −40 dB below the song's own peak
    let first = peaks.findIndex((p) => p > floor), last = n - 1; while (last > 0 && peaks[last] <= floor) last--;
    if (first < 0) return toast('This song is silent all through.');
    const start = Math.max(0, (first / n) * full - 0.05), end = Math.min(full, ((last + 1) / n) * full + 0.1);
    setTrimRange(start, end);
    toast(`Cut to where the sound is: ${formatTime(start)} to ${formatTime(end)}.`);
  } catch (e) { toast(e.message, { error: true }); }
});
$('#trimBeatsBtn').addEventListener('click', async () => {
  const s = trimSong; if (!s) return;
  try {
    const a = s.analysis && s.analysis.beats ? s.analysis : (s.analysis = await api.json(`/api/songs/${s.id}/analysis`));
    const beats = (a && a.beats) || [];
    if (beats.length < 4 || !((a.beatConf || 0) >= 0.12)) return toast('No steady pulse was found in this song.');
    const nearest = (t) => beats.reduce((best, b) => (Math.abs(b - t) < Math.abs(best - t) ? b : best), beats[0]);
    const start = nearest(trimSel.start), end = Math.max(nearest(trimSel.end), start + MIN_KEEP);
    setTrimRange(start, end);
    toast(`Start and end are on beats (${Math.round(a.bpm)} BPM).`);
  } catch (e) { toast(e.message, { error: true }); }
});

// ---------------------------------------------------------------- a song's video and background (Song settings… in a song's menu)
const songUI = { volume: $('#songVolume'), volumeVal: $('#songVolumeVal'), root: $('#songSheet'), thumb: $('#songSheetThumb'), song: $('#songSheetSong'), sub: $('#songSheetSub'), use: $('#songVideoUse'), hint: $('#songVideoHint'), optOwn: $('#songOptOwn'), optOther: $('#songOptOther'), ownStatus: $('#songOwnStatus'), ownPrepare: $('#songOwnPrepare'), other: $('#songOther'), empty: $('#songVideoEmpty'), drop: $('#songVideoDrop'), browse: $('#songVideoBrowse'), status: $('#songVideoStatus'), current: $('#songVideoCurrent'), curThumb: $('#songVideoThumb'), curName: $('#songVideoName'), curMeta: $('#songVideoMeta'), remove: $('#songVideoRemove'), input: $('#songVideoInput'), blurRow: $('#songBlurRow'), blur: $('#songVideoBlur'), blurVal: $('#songVideoBlurVal'), bg: $('#songBg'), bgHint: $('#songBgHint'), done: $('#songSheetDone') };
let songSheetSong = null, songOpen = false, songCloseTimer = null, songPollTimer = null;
const USE_HINTS = { off: 'Only the song’s sound is used; the artwork and the mix’s background show as usual.', background: 'The video plays behind everything while this song is on.', art: 'The video plays where the artwork sits, cropped to the square.', both: 'The video plays behind everything and where the artwork sits.' };
const STYLE_NAMES = { aurora: 'Aurora', cover: 'Cover', ink: 'Ink', video: 'the mix’s video' };
function openSongSheet(song) {
  if (job) return toast('Wait for the export to finish first.');
  songSheetSong = song; songOpen = true;
  if (!song.videoSource && song.videoPick !== 'other') song.videoPick = 'other'; // nothing of its own to pick
  clearTimeout(songCloseTimer);
  songUI.root.hidden = false;
  renderSongSheet(); // after the sheet is shown, so the segmented controls can measure their buttons
  requestAnimationFrame(() => { songUI.root.classList.add('is-open'); renderSongSheet(); });
  refreshSongVideo(song);
}
function closeSongSheet() {
  const s = songSheetSong;
  songOpen = false; songSheetSong = null;
  if (!(s && s.ownVideoStatus === 'preparing' && s.videoUse !== 'off')) clearTimeout(songPollTimer); // keep polling for a video the mix is waiting on
  songUI.root.classList.remove('is-open');
  clearTimeout(songCloseTimer); songCloseTimer = setTimeout(() => { songUI.root.hidden = true; }, 200);
}
// the song's latest server state (its own video may be being prepared), polled while that is under way
async function refreshSongVideo(song) {
  clearTimeout(songPollTimer);
  const before = song.ownVideoStatus;
  try { syncVideoFields(song, await api.song(song.id)); } catch { /* keep what we know */ }
  if (songSheetSong === song) renderSongSheet();
  if (song.ownVideoStatus !== before) { hydrateVideo(); invalidate(); updateRow(song); if (song.ownVideoStatus === 'ready' && song.videoUse !== 'off') toast(`“${song.title || 'The song'}”: its video is ready.`); else if (song.ownVideoStatus === 'error') toast(song.ownVideoError || 'The video could not be prepared.', { error: true }); }
  if (song.ownVideoStatus === 'preparing' && (songSheetSong === song || song.videoUse !== 'off')) songPollTimer = setTimeout(() => refreshSongVideo(song), 1500);
}
function renderSongSheet() {
  const s = songSheetSong; if (!s) return;
  songUI.song.textContent = s.title || 'Untitled'; songUI.sub.textContent = s.artist || s.album || '';
  const vol = +s.volume || 0; songUI.volume.value = vol; songUI.volume.style.setProperty('--p', `${((vol + 12) / 18) * 100}%`); songUI.volumeVal.textContent = `${vol > 0 ? '+' : ''}${vol} dB`;
  songUI.thumb.innerHTML = '';
  if (s.image) { const c = document.createElement('canvas'); c.width = c.height = 96; c.getContext('2d').drawImage(s.image, 0, 0, 96, 96); songUI.thumb.append(c); }
  const use = s.videoUse || 'off';
  // the two choices, always on show: the song's own video (greyed out when it has none) and another video
  const canOwn = !!s.videoSource, pick = s.videoPick === 'other' || !canOwn ? 'other' : 'own', on = use !== 'off';
  songUI.optOwn.classList.toggle('is-disabled', !canOwn); songUI.optOwn.setAttribute('aria-disabled', String(!canOwn));
  songUI.optOwn.classList.toggle('is-selected', on && pick === 'own'); songUI.optOwn.setAttribute('aria-checked', String(on && pick === 'own'));
  songUI.optOther.classList.toggle('is-selected', on && pick === 'other'); songUI.optOther.setAttribute('aria-checked', String(on && pick === 'other'));
  const st = s.ownVideoStatus || 'none', link = s.videoSource === 'link';
  songUI.ownStatus.textContent = !canOwn ? 'This song did not come from a video file or a link.' : st === 'ready' ? 'Ready: the video this song came with.' : st === 'preparing' ? (link ? 'Fetching the video from the link and preparing it…' : 'Preparing the video…') : st === 'error' ? (s.ownVideoError || 'The video could not be prepared.') : (link ? 'The video behind the link, fetched (up to 1080p) when you choose it.' : 'The picture of the file it came from, prepared when you choose it.');
  songUI.ownPrepare.hidden = !(canOwn && st === 'error');
  songUI.optOwn.classList.toggle('is-busy', canOwn && st === 'preparing'); songUI.optOwn.classList.toggle('is-error', canOwn && st === 'error');
  // the other video's drop zone or card, under the cards while that is the choice
  songUI.other.hidden = !(on && pick === 'other');
  const has = !!s.videoId, v = has ? previewVideos.get(s.videoId) : null, m = v && v.meta, failed = has ? videoErrors.get(s.videoId) : null;
  songUI.empty.hidden = has; songUI.current.hidden = !has;
  if (has) {
    songUI.curName.textContent = s.videoName || 'Video';
    const poster = m && m.ready ? `/api/backgrounds/${s.videoId}/poster.jpg?v=${m.version}` : '';
    if (songUI.curThumb.getAttribute('src') !== poster) { if (poster) songUI.curThumb.src = poster; else songUI.curThumb.removeAttribute('src'); }
    songUI.curMeta.textContent = failed ? `Could not be prepared: ${failed} Drop another file.` : m ? (m.error ? m.error : m.ready ? videoLabel(m) : 'Preparing…') : 'Loading…';
    songUI.current.classList.toggle('is-error', !!failed || !!(m && m.error));
    songUI.current.classList.toggle('is-busy', !failed && !!(m && !m.ready && !m.error));
  }
  // where it shows, with the blur for the background placement
  paintSeg(songUI.use, use, false);
  const vs = songVideoState(s);
  songUI.hint.textContent = !on ? USE_HINTS.off : vs.status === 'error' ? 'That video could not be prepared, so the song shows as audio only for now.' : (pick === 'other' && !has) ? 'Drop a video above to see it here.' : vs.status !== 'ready' ? `${USE_HINTS[use]} It appears once the video is ready.` : USE_HINTS[use];
  const behind = use === 'background' || use === 'both';
  songUI.blurRow.hidden = !behind;
  const blur = s.videoBlur == null ? +state.look.videoBlur || 0 : s.videoBlur;
  songUI.blur.value = blur; songUI.blur.style.setProperty('--p', `${blur * 100}%`); songUI.blurVal.textContent = `${Math.round(blur * 100)}%`;
  const bg = s.bg && s.bg.style ? s.bg.style : 'mix';
  paintSeg(songUI.bg, behind ? 'mix' : bg, false);
  for (const b of $$('button', songUI.bg)) b.disabled = behind;
  songUI.bgHint.textContent = behind ? 'The video is this song’s background.' : bg === 'mix' ? `This song uses the mix’s background (${STYLE_NAMES[state.look.style] || state.look.style}).` : `Only this song gets the ${STYLE_NAMES[bg]} background; it fades in as the song starts.`;
}
const songSheetChanged = (s) => { renderSongSheet(); hydrateVideo(); invalidate(); updateRow(s); };
for (const b of $$('button', songUI.use)) b.addEventListener('click', () => {
  const s = songSheetSong; if (!s) return;
  s.videoUse = b.dataset.value;
  if (s.videoUse !== 'off' && s.videoPick !== 'other' && s.videoSource && s.ownVideoStatus !== 'ready' && s.ownVideoStatus !== 'preparing') prepareOwnVideo(s);
  songSheetChanged(s);
});
// choosing a video makes it the song's background straight away (the placement below can change that)
function chooseSongVideo(value) {
  const s = songSheetSong; if (!s) return;
  if (value === 'own' && !s.videoSource) return;
  s.videoPick = value;
  if (!s.videoUse || s.videoUse === 'off') s.videoUse = 'background';
  if (value === 'own' && s.ownVideoStatus !== 'ready' && s.ownVideoStatus !== 'preparing') prepareOwnVideo(s);
  songSheetChanged(s);
}
for (const opt of [songUI.optOwn, songUI.optOther]) {
  opt.addEventListener('click', (e) => { if (e.target.closest('button')) return; chooseSongVideo(opt.dataset.value); });
  opt.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseSongVideo(opt.dataset.value); } });
}
for (const b of $$('button', songUI.bg)) b.addEventListener('click', () => { const s = songSheetSong; if (!s || b.disabled) return; s.bg = b.dataset.value === 'mix' ? null : { style: b.dataset.value }; renderSongSheet(); invalidate(); });
songUI.volume.addEventListener('input', () => { const s = songSheetSong; if (!s) return; s.volume = clamp(+songUI.volume.value, -12, 6); renderSongSheet(); syncAudio(true); invalidate(); });
songUI.volume.addEventListener('dblclick', () => { const s = songSheetSong; if (!s) return; s.volume = 0; renderSongSheet(); syncAudio(true); invalidate(); });
songUI.ownPrepare.addEventListener('click', () => { const s = songSheetSong; if (!s) return; s.videoPick = 'own'; if (!s.videoUse || s.videoUse === 'off') s.videoUse = 'background'; prepareOwnVideo(s); songSheetChanged(s); });
songUI.blur.addEventListener('input', () => { const s = songSheetSong; if (!s) return; s.videoBlur = +songUI.blur.value; songUI.blur.style.setProperty('--p', `${s.videoBlur * 100}%`); songUI.blurVal.textContent = `${Math.round(s.videoBlur * 100)}%`; invalidate(); });
songUI.blur.addEventListener('dblclick', () => { const s = songSheetSong; if (!s) return; s.videoBlur = null; renderSongSheet(); invalidate(); });
// asks the server for the song's own video: the picture of the file it came from, or the video behind its link
async function prepareOwnVideo(song) {
  if (!song.videoSource) return;
  try { syncVideoFields(song, await api.json(`/api/songs/${song.id}/video`, { method: 'POST' })); }
  catch (e) { return toast(e.message, { error: true }); }
  if (songSheetSong === song) renderSongSheet();
  refreshSongVideo(song);
}
async function setSongVideo(file) {
  const s = songSheetSong; if (!s) return;
  if (!isVideoFile(file)) return toast('Drop a video file.', { error: true });
  songUI.drop.classList.add('is-busy'); songUI.status.textContent = 'Uploading…';
  try {
    const meta = await uploadVideo(file, (txt) => { songUI.status.textContent = txt; });
    const old = s.videoId;
    s.videoId = meta.id; s.videoName = meta.name; s.videoPick = 'other';
    if (!s.videoUse || s.videoUse === 'off') s.videoUse = 'background';
    songSheetChanged(s);
    if (old && old !== meta.id) dropVideo(old);
    await hydrateVideo();
    if (songSheetSong === s) renderSongSheet();
  } catch (e) { toast(e.message, { error: true }); }
  finally { songUI.drop.classList.remove('is-busy'); songUI.status.textContent = ''; }
}
songUI.browse.addEventListener('click', () => songUI.input.click());
songUI.input.addEventListener('change', (e) => { setSongVideo(e.target.files[0]); e.target.value = ''; });
songUI.drop.addEventListener('dragover', (e) => { if (hasVideo(e.dataTransfer)) { e.preventDefault(); e.stopPropagation(); songUI.drop.classList.add('is-over'); } });
songUI.drop.addEventListener('dragleave', () => songUI.drop.classList.remove('is-over'));
songUI.drop.addEventListener('drop', (e) => { songUI.drop.classList.remove('is-over'); const f = [...e.dataTransfer.files].find(isVideoFile); if (f) { e.preventDefault(); e.stopPropagation(); setSongVideo(f); } });
songUI.remove.addEventListener('click', () => { const s = songSheetSong; if (!s || !s.videoId) return; const old = s.videoId; s.videoId = null; s.videoName = ''; songSheetChanged(s); dropVideo(old); });
songUI.done.addEventListener('click', closeSongSheet);
songUI.root.addEventListener('click', (e) => { if (e.target === songUI.root) closeSongSheet(); });

// drag the visualizer, a dancer, a caption or the logo anywhere in the preview: picking one up from a preset spot turns it into a free one
function previewHit(e) {
  const r = preview.renderer; if (!r) return null;
  const rect = preview.canvas.getBoundingClientRect();
  const ux = ((e.clientX - rect.left) / rect.width) * r.Wu, uy = ((e.clientY - rect.top) / rect.height) * r.Hu;
  const inside = (b) => b && ux >= b.x && ux <= b.x + b.w && uy >= b.y && uy <= b.y + b.h;
  const caps2 = r.captionBoxes || [];
  for (let k = caps2.length - 1; k >= 0; k--) if (inside(caps2[k])) return { kind: 'caption', caption: r.captions[k], b: { ...caps2[k] }, rect };
  if (r.logo && inside(r.logoBox)) return { kind: 'logo', b: { ...r.logoBox }, rect };
  const boxes = r.dancerBoxes || [];
  for (let k = boxes.length - 1; k >= 0; k--) if (inside(boxes[k])) return { kind: 'dancer', dancer: r.dancers[k], b: { ...boxes[k] }, rect };
  if (r.viz && inside(r.layout.viz)) return { kind: 'viz', b: { ...r.layout.viz }, rect };
  return null;
}
// a click (without a drag) selects an element in the preview; the arrow keys then nudge it, Esc lets go
function boxOfSelected() {
  const r = preview.renderer; if (!r || !selected) return null;
  if (selected.kind === 'viz') return r.viz ? r.layout.viz : null;
  if (selected.kind === 'logo') return r.logoBox || null;
  if (selected.kind === 'dancer') { const k = r.dancers.indexOf(selected.ref); return k >= 0 && r.dancerBoxes ? r.dancerBoxes[k] : null; }
  if (selected.kind === 'caption') { const k = r.captions.indexOf(selected.ref); return k >= 0 && r.captionBoxes ? r.captionBoxes[k] : null; }
  return null;
}
function isSelectedHit(hit) { return !!selected && !!hit && hit.kind === selected.kind && (selected.kind === 'dancer' ? hit.dancer === selected.ref : selected.kind === 'caption' ? hit.caption === selected.ref : true); }
function showSelectedHandle() { const b = boxOfSelected(); if (b) showVizHandle({ b, rect: preview.canvas.getBoundingClientRect(), selected: true }); else showVizHandle(null); }
function selectElement(hit) {
  if (!hit && !selected) return;
  selected = hit ? { kind: hit.kind, ref: hit.kind === 'dancer' ? hit.dancer : hit.kind === 'caption' ? hit.caption : null } : null;
  showSelectedHandle();
}
document.addEventListener('pointerdown', (e) => { if (selected && !e.target.closest('#stageFrame, .panel-inspector, .menu')) selectElement(null); });
function nudgeSelected(key, step) {
  const r = preview.renderer; if (!r || !selected) return;
  const dx = (key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0) / r.Wu, dy = (key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0) / r.Hu;
  if (selected.kind === 'viz') {
    const b = r.layout.viz; if (!b) return;
    if (state.viz.place !== 'custom') { const labels = state.viz.labels !== false && state.viz.style !== 'bands' && state.viz.place !== 'behind'; state.viz.size = clamp((b.h - (labels ? vizLabelH(state.viz.labelSize) : 0)) / 1080, VIZ_SIZE.min, VIZ_SIZE.max); state.viz.w = clamp(b.w / r.Wu, 0.1, 1); state.viz.place = 'custom'; state.viz.x = b.x / r.Wu; state.viz.y = b.y / r.Hu; for (const pl of $$('.places')) pl._apply && pl._apply(); updateVizUI(); }
    state.viz.x = clamp(state.viz.x + dx, 0, 1 - b.w / r.Wu); state.viz.y = clamp(state.viz.y + dy, 0, 1 - b.h / r.Hu);
  } else if (selected.kind === 'logo') {
    const b = r.logoBox; if (!b) return;
    if (state.logo.place !== 'custom') { state.logo.place = 'custom'; state.logo.x = (b.x + b.w / 2) / r.Wu; state.logo.y = (b.y + b.h / 2) / r.Hu; renderLogoUI(); }
    state.logo.x = clamp(state.logo.x + dx, 0, 1); state.logo.y = clamp(state.logo.y + dy, 0, 1);
  } else if (selected.kind === 'dancer') {
    const d = selected.ref, k = r.dancers.indexOf(d), b = k >= 0 && r.dancerBoxes ? r.dancerBoxes[k] : null; if (!b) return;
    if (d.place !== 'custom') { d.place = 'custom'; d.size = clamp(b.h / 1080, DANCE_SIZE.min, DANCE_SIZE.max); d.x = (b.x + b.w / 2) / r.Wu; d.y = (b.y + b.h) / r.Hu; for (const pl of $$('.places')) pl._apply && pl._apply(); updateDanceUI(); }
    d.x = clamp(d.x + dx, 0, 1); d.y = clamp(d.y + dy, 0, 1);
  } else if (selected.kind === 'caption') {
    const c = selected.ref; c.x = clamp(c.x + dx, 0, 1); c.y = clamp(c.y + dy, 0, 1);
  }
  r.setProject(state); render();
  showSelectedHandle();
  invalidate();
}
// guides: a dragged element snaps to the frame's centre lines and margins
const snapLines = { v: $('#snapV'), h: $('#snapH') };
function snapTo(r, box, centreX, centreY) {
  const M = r.layout.M, T = 10;
  const cands = { x: [[r.Wu / 2, 'c'], [M + box.w / 2, 'l'], [r.Wu - M - box.w / 2, 'r']], y: [[r.Hu / 2, 'c'], [M + box.h / 2, 't'], [r.Hu - M - box.h / 2, 'b']] };
  let sx = null, sy = null;
  for (const [v] of cands.x) if (Math.abs(centreX - v) <= T) { centreX = v; sx = v; break; }
  for (const [v] of cands.y) if (Math.abs(centreY - v) <= T) { centreY = v; sy = v; break; }
  return { cx: centreX, cy: centreY, sx, sy };
}
function showSnap(r, rect, sx, sy, box) {
  const v = snapLines.v, h = snapLines.h;
  if (sx != null) { const gx = sx === r.Wu / 2 ? sx : sx < r.Wu / 2 ? sx - box.w / 2 : sx + box.w / 2; v.style.left = `${(gx / r.Wu * rect.width).toFixed(1)}px`; v.hidden = false; } else v.hidden = true;
  if (sy != null) { const gy = sy === r.Hu / 2 ? sy : sy < r.Hu / 2 ? sy - box.h / 2 : sy + box.h / 2; h.style.top = `${(gy / r.Hu * rect.height).toFixed(1)}px`; h.hidden = false; } else h.hidden = true;
}
preview.canvas.addEventListener('pointermove', (e) => { if (vizDrag) return; const hit = previewHit(e); preview.canvas.classList.toggle('is-grab', !!hit); if (hit) showVizHandle(hit); else showSelectedHandle(); });
preview.canvas.addEventListener('pointerleave', () => { if (!vizDrag) { preview.canvas.classList.remove('is-grab'); showSelectedHandle(); } });
preview.canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = previewHit(e); if (!hit) { if (selected) selectElement(null); return; }
  e.preventDefault();
  try { preview.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
  const r = preview.renderer;
  vizDrag = { x0: e.clientX, y0: e.clientY, hit, box: { ...hit.b }, rect: hit.rect, moved: false };
  const move = (ev) => {
    if (!vizDrag) return;
    if (!vizDrag.moved && Math.hypot(ev.clientX - vizDrag.x0, ev.clientY - vizDrag.y0) < 3) return;
    const dx = ((ev.clientX - vizDrag.x0) / vizDrag.rect.width) * r.Wu, dy = ((ev.clientY - vizDrag.y0) / vizDrag.rect.height) * r.Hu;
    if (hit.kind === 'caption') {
      const c = hit.caption, b = vizDrag.box;
      if (!vizDrag.moved) { vizDrag.moved = true; preview.canvas.classList.add('is-grabbing'); }
      const sn = snapTo(r, b, b.x + b.w / 2 + dx, b.y + b.h / 2 + dy);
      c.x = clamp(sn.cx / r.Wu, 0, 1); c.y = clamp(sn.cy / r.Hu, 0, 1);
      r.setProject(state); render();
      const nb = r.captionBoxes && r.captionBoxes[r.captions.indexOf(c)];
      if (nb) showVizHandle({ b: nb, rect: vizDrag.rect });
      showSnap(r, vizDrag.rect, sn.sx, sn.sy, b);
      return;
    }
    if (hit.kind === 'logo') {
      const lg = state.logo, b = vizDrag.box;
      if (!vizDrag.moved) { vizDrag.moved = true; preview.canvas.classList.add('is-grabbing'); if (lg.place !== 'custom') { lg.place = 'custom'; renderLogoUI(); } }
      const sn = snapTo(r, b, b.x + b.w / 2 + dx, b.y + b.h / 2 + dy);
      lg.x = clamp(sn.cx / r.Wu, 0, 1); lg.y = clamp(sn.cy / r.Hu, 0, 1);
      r.setProject(state); render();
      if (r.logoBox) showVizHandle({ b: r.logoBox, rect: vizDrag.rect });
      showSnap(r, vizDrag.rect, sn.sx, sn.sy, b);
      return;
    }
    if (hit.kind === 'dancer') {
      const d = hit.dancer, k = state.dancers.indexOf(d);
      if (!vizDrag.moved) {
        vizDrag.moved = true; preview.canvas.classList.add('is-grabbing');
        if (d.place !== 'custom') { d.place = 'custom'; d.size = clamp(vizDrag.box.h / 1080, DANCE_SIZE.min, DANCE_SIZE.max); } // keep the size it had where it stood
      }
      const b = vizDrag.box;
      const sn = snapTo(r, b, b.x + b.w / 2 + dx, b.y + b.h / 2 + dy);
      d.x = clamp(sn.cx / r.Wu, 0, 1); d.y = clamp((sn.cy + b.h / 2) / r.Hu, 0, 1);
      r.setProject(state); render();
      const nb = r.dancerBoxes && r.dancerBoxes[r.dancers.indexOf(d)];
      if (nb) showVizHandle({ b: nb, rect: vizDrag.rect });
      showSnap(r, vizDrag.rect, sn.sx, sn.sy, b);
      if (k >= 0) { const card = $$('.dancer-card')[k]; if (card) { const pl = card.querySelector('.places'); pl && pl._apply && pl._apply(); const sz = card.querySelector('[data-range$=".size"]'); if (sz) { sz.value = d.size; sz.dispatchEvent(new Event('paint')); } } }
      updateDanceUI();
      return;
    }
    if (!vizDrag.moved) {
      vizDrag.moved = true; preview.canvas.classList.add('is-grabbing');
      if (state.viz.place !== 'custom') { // keep the box's current size and let it go free
        const labels = state.viz.labels !== false && state.viz.style !== 'bands' && state.viz.place !== 'behind';
        state.viz.size = clamp((vizDrag.box.h - (labels ? vizLabelH(state.viz.labelSize) : 0)) / 1080, VIZ_SIZE.min, VIZ_SIZE.max);
        state.viz.w = clamp(vizDrag.box.w / r.Wu, 0.1, 1);
        state.viz.place = 'custom';
        for (const pl of $$('.places')) pl._apply && pl._apply();
        for (const rg of $$('[data-range]')) if (rg.dataset.range === 'viz.size' || rg.dataset.range === 'viz.w') { rg.value = getPath(state, rg.dataset.range); rg.dispatchEvent(new Event('paint')); }
        updateVizUI();
      }
    }
    const vb = vizDrag.box, sn = snapTo(r, vb, vb.x + vb.w / 2 + dx, vb.y + vb.h / 2 + dy);
    state.viz.x = clamp((sn.cx - vb.w / 2) / r.Wu, 0, 1 - vb.w / r.Wu);
    state.viz.y = clamp((sn.cy - vb.h / 2) / r.Hu, 0, 1 - vb.h / r.Hu);
    r.setProject(state);
    render();
    showVizHandle({ b: r.layout.viz, rect: vizDrag.rect });
    showSnap(r, vizDrag.rect, sn.sx, sn.sy, vb);
  };
  const up = () => {
    preview.canvas.removeEventListener('pointermove', move); preview.canvas.removeEventListener('pointerup', up); preview.canvas.removeEventListener('pointercancel', up);
    preview.canvas.classList.remove('is-grabbing');
    snapLines.v.hidden = true; snapLines.h.hidden = true;
    if (vizDrag && vizDrag.moved) invalidate();
    selectElement(hit); // a click selects; after a drag the element stays selected for nudging
    vizDrag = null;
  };
  preview.canvas.addEventListener('pointermove', move); preview.canvas.addEventListener('pointerup', up); preview.canvas.addEventListener('pointercancel', up);
});

// ---------------------------------------------------------------- polish: folding groups, scroll fades, preview affordances
// defaults: what a setting goes back to, and which settings each inspector group owns
const DANCER_DEFAULTS = { size: DANCE_SIZE.def, flip: false, shadow: true, tempo: 'instep', speed: 1 };
const CAPTION_DEFAULTS = { size: 0.032, opacity: 0.92, bold: false, color: 'white' };
function defaultFor(path) {
  let m = path.match(/^dancers\.\d+\.(\w+)$/);
  if (m) return DANCER_DEFAULTS[m[1]];
  m = path.match(/^captions\.\d+\.(\w+)$/);
  if (m) return CAPTION_DEFAULTS[m[1]];
  return getPath(defaultState(), path);
}
const GROUP_PATHS = {
  composition: ['look.balance'],
  background: ['look.style', 'look.videoId', 'look.videoName', 'look.videoBlur', 'look.motion', 'look.dim', 'look.grain'],
  artwork: ['look.corners', 'look.side', 'look.glow'],
  typeface: ['look.font'],
  text: ['look.showTitle', 'subtitle', 'look.showMeta', 'look.showNowPlaying', 'look.marquee', 'look.eyebrow', 'look.showNext', 'look.timeMode', 'look.showClock', 'look.progress'],
  captions: [], logo: ['logo.place', 'logo.size', 'logo.opacity', 'logo.x', 'logo.y'],
  'track list': ['look.rows', 'look.density', 'look.accent', 'look.marker', 'look.showIndex', 'look.showThumbs', 'look.showDurations', 'look.showProgress'],
  vizGroup: ['viz.style', 'viz.place', 'viz.size', 'viz.w', 'viz.x', 'viz.y', 'viz.color', 'viz.level', 'viz.labels', 'viz.labelSize', 'viz.guides', 'viz.mirror'],
  dancers: [], // the dancers' own settings; handled specially below
  timing: ['timing.lead', 'timing.gap', 'timing.crossfade', 'timing.tail'],
  danceRules: ['dance.mode', 'dance.sensitivity'],
  resolution: ['output.preset', 'output.width', 'output.height'],
  'frame rate': ['output.fps'],
  video: ['output.codec', 'output.quality'],
  audio: ['output.audio', 'audio.bass', 'audio.gain'],
  file: ['output.fileName'],
};
const GROUP_NAMES = { vizGroup: 'Visualizer', danceRules: 'When they appear', captions: 'Captions', logo: 'Logo' };
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-9 : (a ?? '') === (b ?? ''));
const DANCER_FIELDS = Object.keys(DANCER_DEFAULTS);
function groupDirty(key) {
  const paths = GROUP_PATHS[key]; if (!paths) return false;
  if (key === 'danceRules' && state.songs.some((s) => s.dancer === 'on' || s.dancer === 'off')) return true;
  if (key === 'dancers') return state.dancers.some((d) => d.place === 'custom' || DANCER_FIELDS.some((f) => !same(d[f], DANCER_DEFAULTS[f])));
  if (key === 'captions') return state.captions.length > 0;
  return paths.some((p) => !same(getPath(state, p), defaultFor(p)));
}
// snapshot / restore of one group's settings, used by the group, tab and global resets
function captureGroup(key) {
  const paths = GROUP_PATHS[key] || [];
  return { key, captions: key === 'captions' ? state.captions.map((c) => ({ ...c })) : [], values: paths.map((p) => [p, getPath(state, p)]), overrides: key === 'danceRules' ? state.songs.filter((s) => s.dancer === 'on' || s.dancer === 'off').map((s) => [s, s.dancer]) : [], dancers: key === 'dancers' ? state.dancers.map((d) => [d, { place: d.place, ...Object.fromEntries(DANCER_FIELDS.map((f) => [f, d[f]])) }]) : [] };
}
function applyGroup(key, snap) { // snap = null → the defaults
  const paths = GROUP_PATHS[key] || [];
  for (const p of paths) setPath(state, p, snap ? snap.values.find((v) => v[0] === p)[1] : defaultFor(p));
  if (key === 'danceRules') { for (const s of state.songs) s.dancer = undefined; if (snap) for (const [s, v] of snap.overrides) s.dancer = v; }
  if (key === 'captions') { state.captions = snap ? snap.captions.map((c) => ({ ...c })) : []; renderCaptions(); }
  if (key === 'logo') renderLogoUI();
  if (key === 'dancers') {
    if (snap) { for (const [d, v] of snap.dancers) Object.assign(d, v); }
    else { const used = new Set(); for (const d of state.dancers) { Object.assign(d, DANCER_DEFAULTS); d.place = (DANCE_PLACES.find((pl) => pl.id !== 'custom' && !used.has(pl.id)) || DANCE_PLACES[0]).id; used.add(d.place); } }
    renderDancers();
  }
}
function finishReset(keys) {
  syncControls();
  for (const key of keys) for (const p of GROUP_PATHS[key] || []) onChange(p);
  if (keys.includes('background')) hydrateVideo();
  if (danceOpen) renderDanceRows();
  invalidate();
}
const groupResets = new Map(); // key -> button
function updateResetButtons() { for (const [key, btn] of groupResets) btn.closest('.group').classList.toggle('is-dirty', groupDirty(key)); }
function resetGroups(keys, label) {
  keys = keys.filter((k) => GROUP_PATHS[k]);
  if (!keys.length) return;
  const snaps = keys.map(captureGroup);
  for (const k of keys) applyGroup(k, null);
  finishReset(keys);
  toast(`${label}: back to the defaults.`, { duration: 6000, action: { label: 'Undo', run: () => { snaps.forEach((snap) => applyGroup(snap.key, snap)); finishReset(keys); } } });
}
const groupLabel = (key) => GROUP_NAMES[key] || key.replace(/^./, (c) => c.toUpperCase());
function resetGroup(key) { resetGroups([key], groupLabel(key)); }
const paneGroupKeys = (pane) => [...groupResets.keys()].filter((k) => { const b = groupResets.get(k); return b && b.closest('.tab-pane') && b.closest('.tab-pane').dataset.pane === pane; });
function resetPane(pane) { resetGroups(paneGroupKeys(pane), { look: 'Look', dancers: 'Dancers', output: 'Output' }[pane] || pane); }
function resetEverything() { resetGroups([...groupResets.keys()], 'Every setting'); }
// every inspector group folds from its title; the state is remembered per group
const FOLD_KEY = 'liner.folds';
function initGroups() {
  let folds = {};
  try { folds = JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; } catch { /* fresh */ }
  for (const group of $$('.panel-inspector .group')) {
    const title = group.querySelector(':scope > .group-title');
    if (!title || group.querySelector(':scope > .group-body')) continue;
    const key = group.id || title.textContent.trim().toLowerCase();
    const body = el('div', 'group-body'), inner = el('div', 'group-inner');
    body.append(inner);
    for (const node of [...group.childNodes]) if (node !== title) inner.append(node);
    group.append(body);
    const text = title.textContent.trim();
    title.textContent = '';
    const btn = el('button', 'group-toggle', '<span></span>');
    btn.type = 'button'; btn.querySelector('span').textContent = text;
    title.append(btn);
    if (GROUP_PATHS[key]) { // a reset that shows only while something in the group differs from its default
      const reset = el('button', 'group-reset', icon('reset'));
      reset.type = 'button'; reset.setAttribute('aria-label', 'Reset to defaults'); reset.dataset.tip = 'Reset to defaults';
      reset.addEventListener('click', () => resetGroup(key));
      title.append(reset);
      groupResets.set(key, reset);
    }
    const fold = el('button', 'group-fold', icon('chevron'));
    fold.type = 'button'; fold.setAttribute('aria-label', 'Fold');
    title.append(fold);
    const set = (collapsed, persist = true) => {
      group.classList.toggle('is-collapsed', collapsed);
      btn.setAttribute('aria-expanded', String(!collapsed)); fold.setAttribute('aria-expanded', String(!collapsed));
      if (persist) { folds[key] = collapsed; localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); }
      if (!collapsed) requestAnimationFrame(refreshSegs);
    };
    for (const b of [btn, fold]) b.addEventListener('click', () => set(!group.classList.contains('is-collapsed')));
    body.addEventListener('transitionend', updateScrollFades);
    set(!!folds[key], false);
  }
}
// a soft fade at the top and bottom of a panel says there is more to scroll
const scrollers = [];
function updateScrollFades() {
  for (const sc of scrollers) {
    const panel = sc.closest('.panel'); if (!panel) continue;
    panel.classList.toggle('is-scrolled', sc.scrollTop > 2);
    panel.classList.toggle('is-more', sc.scrollTop + sc.clientHeight < sc.scrollHeight - 2);
  }
}
for (const sc of [$('.panel-inspector .panel-scroll'), $('#trackScroll')]) if (sc) { scrollers.push(sc); sc.addEventListener('scroll', updateScrollFades, { passive: true }); }
new ResizeObserver(updateScrollFades).observe(document.body);
// the visualizer shows a dashed outline and "Drag to move" when the pointer is over it
const vizHandle = $('#vizHandle');
function showVizHandle(hit) {
  if (!hit) { vizHandle.classList.remove('is-on'); return; }
  const r = preview.renderer, b = hit.b, rect = hit.rect, sel = !!hit.selected || isSelectedHit(hit);
  vizHandle.classList.toggle('is-selected', sel);
  vizHandle.querySelector('span').textContent = sel ? 'Arrow keys nudge · Esc' : 'Drag to move';
  const sx = rect.width / r.Wu, sy = rect.height / r.Hu;
  vizHandle.hidden = false;
  vizHandle.style.left = `${(b.x * sx).toFixed(1)}px`; vizHandle.style.top = `${(b.y * sy).toFixed(1)}px`;
  vizHandle.style.width = `${(b.w * sx).toFixed(1)}px`; vizHandle.style.height = `${(b.h * sy).toFixed(1)}px`;
  vizHandle.classList.add('is-on');
}
// double-click the preview to expand it, and again to come back
$('#preview').addEventListener('dblclick', (e) => { if (!previewHit(e)) toggleTheatre(); });

// ---------------------------------------------------------------- resizable panels
const PANELS_KEY = 'liner.panels', PANEL_DEFAULTS = { tracks: 316, inspector: 296 }, PANEL_RANGE = { tracks: [240, 460], inspector: [264, 440] };
let panelWidths = { ...PANEL_DEFAULTS };
try { panelWidths = { ...PANEL_DEFAULTS, ...(JSON.parse(localStorage.getItem(PANELS_KEY)) || {}) }; } catch { /* defaults */ }
function applyPanelWidths(persist = true) {
  for (const k of ['tracks', 'inspector']) { panelWidths[k] = clamp(Math.round(panelWidths[k]), PANEL_RANGE[k][0], PANEL_RANGE[k][1]); document.documentElement.style.setProperty(`--${k}-w`, `${panelWidths[k]}px`); }
  if (persist) localStorage.setItem(PANELS_KEY, JSON.stringify(panelWidths));
}
applyPanelWidths(false);
for (const h of $$('.resize-handle')) {
  const which = h.dataset.panel, sign = which === 'tracks' ? 1 : -1;
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); h.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = panelWidths[which];
    document.body.classList.add('is-resizing');
    const move = (ev) => { panelWidths[which] = w0 + sign * (ev.clientX - x0); applyPanelWidths(false); };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); document.body.classList.remove('is-resizing'); applyPanelWidths(true); refreshSegs(); };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
  h.addEventListener('dblclick', () => { panelWidths[which] = PANEL_DEFAULTS[which]; applyPanelWidths(true); refreshSegs(); });
}

// ---------------------------------------------------------------- global events
$('#addBtn').addEventListener('click', () => $('#fileInput').click());
$('#addBtn2').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files')) { dragDepth++; if (!hasImage(e.dataTransfer)) document.body.classList.add('is-dropping'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('is-dropping'); });
window.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
window.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; document.body.classList.remove('is-dropping'); if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
// ---------------------------------------------------------------- undo / redo
// Every settled change to the mix (what save() writes, so a slider drag settles into one step) becomes a step.
// Undo and redo swap the whole state for a neighbouring step and refresh everything that mirrors it; runtime
// things that live outside the saved state (decoded artwork, analyses, sprites, the server's cover) carry over.
const history = { past: [], future: [], current: null, mix: null, restoring: false };
const HISTORY_MAX = 150;
const historyUI = { undo: $('#undoBtn'), redo: $('#redoBtn') };
function historyRecord(json) {
  if (history.restoring) return;
  if (history.mix !== currentMixId) { history.past = []; history.future = []; history.current = json; history.mix = currentMixId; updateHistoryButtons(); return; }
  if (json === history.current) return;
  if (history.current != null) { history.past.push(history.current); if (history.past.length > HISTORY_MAX) history.past.shift(); }
  history.current = json; history.future = [];
  updateHistoryButtons();
}
function resetHistory() { history.past = []; history.future = []; history.current = null; history.mix = null; updateHistoryButtons(); }
function updateHistoryButtons() {
  const u = history.past.length ? describeChange(history.past[history.past.length - 1], history.current) : null;
  const r = history.future.length ? describeChange(history.current, history.future[history.future.length - 1]) : null;
  historyUI.undo.disabled = !u; historyUI.redo.disabled = !r;
  historyUI.undo.dataset.tip = u ? `Undo ${u} (${KEYS('⌘Z')})` : 'Nothing to undo';
  historyUI.redo.dataset.tip = r ? `Redo ${r} (${KEYS('⇧⌘Z')})` : 'Nothing to redo';
}
const RUNTIME_SONG_KEYS = ['image', 'palette', 'analysis', 'spectrum', 'waveform', 'analysisRetried', 'ready', 'error', 'duration', 'samples', 'uploading', 'cover', 'coverVersion', 'customCover', 'coverMode', 'coverInfo', 'midi', 'hasVideo', 'videoSource', 'ownVideo', 'ownVideoStatus', 'ownVideoError'];
function applySnapshot(json) {
  history.restoring = true;
  try {
    const next = normalizeState(JSON.parse(json));
    const oldSongs = new Map(state.songs.map((s) => [s.id, s]));
    for (const s of next.songs) { const o = oldSongs.get(s.id); if (o) for (const k of RUNTIME_SONG_KEYS) if (o[k] !== undefined) s[k] = o[k]; }
    const oldDancers = new Map(state.dancers.map((d) => [d.id, d]));
    for (const d of next.dancers) { const o = oldDancers.get(d.id); if (o && o.sprite) d.sprite = o.sprite; }
    if (next.logo && state.logo && next.logo.id === state.logo.id) next.logo.image = state.logo.image;
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, next);
    for (const id of [...pendingRemovals.keys()]) if (state.songs.some((s) => s.id === id)) pendingRemovals.delete(id); // a song put back is not removed from the cache after all
    for (const [, row] of rows) row.remove();
    rows.clear();
    if (selectedId && !state.songs.some((s) => s.id === selectedId)) selectedId = null;
    selectElement(null);
    renderTracks(); renderDancers(); renderCaptions(); renderLogoUI(); renderVideoUI(); syncControls();
    hydrateDancers(); hydrateLogo(); hydrateVideo();
    const missing = state.songs.filter((s) => !s.image);
    if (missing.length) Promise.all(missing.map(hydrateSong)).then(() => { if (state.songs.some((s) => !s.ready && !s.error)) watchReadiness(); invalidate(); });
    history.current = JSON.stringify(persistable()); // as the restored state serialises, so the next save is not mistaken for a new step
    invalidate();
  } finally { history.restoring = false; }
}
let historyToast = null; // one at a time: a run of undos replaces its note rather than stacking them
const noteHistory = (text) => { if (historyToast) historyToast.dismiss(); historyToast = toast(text, { duration: 1800 }); };
function undo() {
  if (!history.past.length) return;
  const was = history.current, json = history.past.pop();
  history.future.push(was);
  const label = describeChange(json, was);
  applySnapshot(json);
  updateHistoryButtons();
  noteHistory(`Undid ${label}.`);
}
function redo() {
  if (!history.future.length) return;
  const was = history.current, json = history.future.pop();
  history.past.push(was);
  const label = describeChange(was, json);
  applySnapshot(json);
  updateHistoryButtons();
  noteHistory(`Redid ${label}.`);
}
// a few words for what changed between two steps: the song or setting concerned
const PATH_LABELS = { 'look.style': 'the background style', 'look.videoId': 'the background video', 'look.videoName': 'the background video', 'look.videoBlur': 'the blur', 'look.balance': 'the composition', 'look.font': 'the typeface', 'logo.id': 'the logo', 'logo.name': 'the logo', 'logo.place': 'the logo position', 'logo.x': 'the logo position', 'logo.y': 'the logo position', 'viz.style': 'the visualizer', 'viz.place': 'the visualizer position', 'viz.x': 'the visualizer position', 'viz.y': 'the visualizer position', 'viz.w': 'the visualizer width', 'dance.mode': 'when the dancers appear', 'dance.sensitivity': 'the sensitivity', 'output.preset': 'the resolution', 'output.width': 'the size', 'output.height': 'the size', 'output.fps': 'the frame rate', 'output.codec': 'the video codec', 'output.quality': 'the quality', 'output.audio': 'the audio format', 'output.fileName': 'the file name', 'audio.bass': 'the bass', 'audio.gain': 'the bass strength', 'timing.lead': 'the lead-in', 'timing.gap': 'the gap', 'timing.crossfade': 'the crossfade', 'timing.tail': 'the tail', 'seed': 'the background' };
const SONG_FIELD_LABELS = { title: 'the title', artist: 'the artist', album: 'the album', trim: 'the trim', volume: 'the volume', dancer: 'the dancer rule', videoUse: 'the video', videoPick: 'the video', videoId: 'the video', videoName: 'the video', videoBlur: 'the video blur', bg: 'the background' };
function labelFor(path) {
  if (PATH_LABELS[path]) return PATH_LABELS[path];
  const el = $(`[data-range="${path}"], [data-seg="${path}"], [data-switch="${path}"]`);
  if (el) {
    const row = el.closest('.row'), lab = row && row.querySelector('label');
    if (lab && lab.textContent.trim()) return `the ${lab.textContent.trim().toLowerCase().replace(/[“”"]/g, '')}`;
    const head = el.closest('.group') && el.closest('.group').querySelector('.group-toggle, .group-title');
    if (head && head.textContent.trim()) return `the ${head.textContent.trim().toLowerCase()}`;
  }
  return `the ${path.split('.').pop().replace(/([A-Z])/g, ' $1').toLowerCase()}`;
}
const same2 = (x, y) => JSON.stringify(x) === JSON.stringify(y);
function describeChange(fromJson, toJson) {
  try {
    const a = JSON.parse(fromJson), b = JSON.parse(toJson);
    if (a.title !== b.title) return 'the mix title';
    if (a.subtitle !== b.subtitle) return 'the subtitle';
    const ai = a.songs.map((s) => s.id), bi = b.songs.map((s) => s.id);
    const added = b.songs.filter((s) => !ai.includes(s.id)), removed = a.songs.filter((s) => !bi.includes(s.id));
    if (added.length) return added.length === 1 ? `adding “${added[0].title || 'Untitled'}”` : `adding ${added.length} songs`;
    if (removed.length) return removed.length === 1 ? `removing “${removed[0].title || 'Untitled'}”` : `removing ${removed.length} songs`;
    if (ai.join() !== bi.join()) return 'reordering the songs';
    for (let i = 0; i < a.songs.length; i++) {
      const x = a.songs[i], y = b.songs[i];
      for (const k of Object.keys({ ...x, ...y })) if (!same2(x[k], y[k])) return `${SONG_FIELD_LABELS[k] || 'a setting'} of “${y.title || x.title || 'Untitled'}”`;
    }
    for (const [key, one] of [['dancers', 'a dancer'], ['captions', 'a caption']]) {
      if ((a[key] || []).length !== (b[key] || []).length) return (a[key] || []).length < (b[key] || []).length ? `adding ${one}` : `removing ${one}`;
      if (!same2(a[key], b[key])) return `${one.replace(/^a /, 'the ')}`;
    }
    for (const group of ['look', 'viz', 'timing', 'output', 'audio', 'dance', 'logo']) {
      const x = a[group] || {}, y = b[group] || {};
      for (const k of Object.keys({ ...x, ...y })) if (!same2(x[k], y[k])) return labelFor(`${group}.${k}`);
    }
    if (a.seed !== b.seed) return 'the background';
  } catch { /* fall through */ }
  return 'the last change';
}
historyUI.undo.addEventListener('click', undo);
historyUI.redo.addEventListener('click', redo);

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z') && tag !== 'input' && tag !== 'textarea' && !e.target.isContentEditable) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'e' || e.key === 'E') && tag !== 'input' && tag !== 'textarea') { e.preventDefault(); startExport(); return; }
  if (tag === 'input' || tag === 'select' || tag === 'textarea' || e.metaKey || e.ctrlKey || (e.altKey && !/^Arrow(Up|Down|Left|Right)$/.test(e.key))) return;
  if (selected && /^Arrow(Up|Down|Left|Right)$/.test(e.key) && !e.altKey) { e.preventDefault(); nudgeSelected(e.key, e.shiftKey ? 10 : 1); return; }
  if (selected && e.key === 'Escape') { selectElement(null); return; }
  if (trimOpen) {
    if (e.code === 'Space') { e.preventDefault(); trimPlayPause(); }
    else if (e.key === 'i' || e.key === 'I') trimUI.setStart.click();
    else if (e.key === 'o' || e.key === 'O') trimUI.setEnd.click();
    else if (e.key === 'Escape') closeTrimSheet();
    return;
  }
  if (e.code === 'Space') { e.preventDefault(); player.playing ? pause() : play(); }
  else if (e.key === 'ArrowLeft' && e.target !== scrub.el) { e.preventDefault(); seek(player.t - (e.shiftKey ? 30 : 5)); }
  else if (e.key === 'ArrowRight' && e.target !== scrub.el) { e.preventDefault(); seek(player.t + (e.shiftKey ? 30 : 5)); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const d = e.key === 'ArrowUp' ? -1 : 1;
    if (e.altKey) { moveSelected(d); return; }
    const i = selectedIndex();
    const j = i < 0 ? (d > 0 ? 0 : state.songs.length - 1) : clamp(i + d, 0, state.songs.length - 1);
    if (state.songs[j]) selectRow(state.songs[j].id);
  }
  else if (e.key === 'Enter') { const s = songById(selectedId); if (s && !s.error && !s.uploading) { const i = preview.renderer.songs.indexOf(s); if (i >= 0) { seek(preview.renderer.timeline.segs[i].start); if (!player.playing) play(); } } }
  else if (e.key === 'Backspace' || e.key === 'Delete') { if (selectedId) { e.preventDefault(); const i = selectedIndex(); removeSong(selectedId).then(() => { const n = state.songs[Math.min(i, state.songs.length - 1)]; if (n) selectRow(n.id); }); } }
  else if (e.key === 'm' || e.key === 'M') { playerVolume.muted = !playerVolume.muted; applyVolume(); syncAudio(false); }
  else if (e.key === 'f' || e.key === 'F') { toggleTheatre(); }
  else if (e.key === '?') { helpOpen ? closeHelp() : openHelp(); }
  else if (e.key === 'Home') { seek(0); }
  else if (e.key === ',' || e.key === '.') { e.preventDefault(); const fps = state.output.fps || 30; const frame = Math.floor(player.t * fps + 1e-6) + (e.key === '.' ? 1 : -1) * (e.shiftKey ? 10 : 1); if (player.playing) pause(); seek(Math.max(0, frame) / fps + 1e-6); }
  else if (e.key === 'Escape' && dancerSheetOpen) { closeDancerSheet(); }
  else if (e.key === 'Escape' && danceOpen) { closeDanceSheet(); }
  else if (e.key === 'Escape' && helpOpen) { closeHelp(); }
  else if (e.key === 'Escape' && saveMixOpen) { closeSaveMix(); }
  else if (e.key === 'Escape' && loadMixOpen) { closeLoadMix(); }
  else if (e.key === 'Escape' && songOpen) { closeSongSheet(); }
  else if (e.key === 'Escape' && artOpen) { closeArtSheet(); }
  else if (e.key === 'Escape' && linkOpen) { closeLinkSheet(); }
  else if (e.key === 'Escape' && job === null && !sheet.root.hidden) { closeSheet(); }
  else if (e.key === 'Escape' && document.body.classList.contains('is-theatre')) { toggleTheatre(false); }
});
new ResizeObserver(() => { fitPreview(); drawScrubber(); }).observe($('#stageFrame'));
window.addEventListener('resize', () => { refreshSegs(); if (danceOpen) renderDanceRows(); });

// ---------------------------------------------------------------- boot
(async function boot() {
  initGroups();
  initTabs(); initSegs(); initSwitches(); initRanges(); initSelects(); initText();
  bindPlaces($('#vizPlaces'), 'viz.place');
  bindPlaces($('#logoPlaces'), 'logo.place');
  updateVizUI();
  renderDancers();
  renderCaptions();
  renderLogoUI();
  $('#styleHint').textContent = STYLE_HINTS[state.look.style];
  onChange('output.audio');
  updateBassUI();
  applyVolume();
  fitPreview();
  renderTracks();
  // reconcile the saved project with the server's cache
  try {
    const list = await api.songs();
    const byId = new Map(list.map((m) => [m.id, m]));
    const missing = state.songs.filter((s) => !byId.has(s.id));
    if (missing.length) { state.songs = state.songs.filter((s) => byId.has(s.id)); toast(missing.length === 1 ? 'One song was missing from the cache and was removed.' : `${missing.length} songs were missing from the cache and were removed.`, { error: true }); }
    for (const s of state.songs) { const m = byId.get(s.id); Object.assign(s, { ready: m.ready, error: m.error, duration: m.duration, samples: m.samples, cover: m.cover, coverVersion: m.coverVersion, customCover: m.customCover, coverMode: m.coverMode, coverInfo: m.coverInfo, midi: m.midi || null, fileName: m.fileName }); syncVideoFields(s, m); }
  } catch { /* offline: keep local state */ }
  renderTracks();
  await Promise.all(state.songs.map(hydrateSong));
  if (state.songs.some((s) => !s.ready && !s.error)) watchReadiness();
  invalidate();
  updateTransport();
  localizeKeys();
  detectCaps();
  await hydrateDancers();
  hydrateVideo();
  await hydrateLogo();
})();
// The shortcut glyphs are written for a Mac; other systems read Ctrl, Alt, Shift and Backspace instead.
function localizeKeys() {
  $('#sheetReveal').textContent = IS_MAC ? 'Reveal in Finder' : IS_WIN ? 'Show in Explorer' : 'Show in folder';
  if (IS_MAC) return;
  for (const k of $$('#helpSheet kbd')) k.textContent = KEYS(k.textContent);
  for (const e of $$('[data-tip]')) e.dataset.tip = KEYS(e.dataset.tip);
}
// everything the page knows, for poking at it from the console (window.liner.state, window.liner.seek(30)…)
window.liner = { state, addFiles, seek, play, pause, invalidate, preview, player, renderTracks, hydrateSong, startExport, openArtSheet, findCoversForAll, openTrimSheet, switchMix, createMix, deleteMix, readMixIndex, get currentMixId() { return currentMixId; }, selectRow, removeSong, undoRemoval, toggleTheatre, syncControls, addDancer, removeDancer, openDancerSheet, openDanceSheet, addDancerFromFiles, ensureAnalyses, renderDancers, hydrateDancers, selectTab, loadSprite, ensureSpectra, updateVizUI, renderCaptions, renderLogoUI, setLogo, hydrateLogo, ensureWaveforms, setVideo, hydrateVideo, videoMeta, renderVideoUI, openSongSheet, closeSongSheet, prepareOwnVideo, previewVideos, prepareVideoFrames, videoFramesReady, renderStats, songVideoState, videoErrors, updateRow, undo, redo, history, saveNow, reorderSongs, syncAudio, audioGraph, openSaveMix, openLoadMix, doSaveMix, doLoadMix };
