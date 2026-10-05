# How Liner works

A map of the code for anyone who wants to change it.

## The shape of it

```
browser (public/)                           server (Node, zero dependencies)
┌────────────────────────────────┐          ┌──────────────────────────────────────┐
│ app.js      state, UI, player, │  HTTP    │ server.mjs   routes, songs, renders, │
│             export driver      │ ◄──────► │              mixes, cover-art finder │
│ renderer.js every frame:       │          │ analysis.mjs liveliness, beats,      │
│             WebGL bg + Canvas  │          │              spectrum (worker thread) │
│ h264.js     frame-exact video  │          │ sprites.mjs  dancer atlases          │
│             decoding (WebCodecs)│         │ backgrounds.mjs video backgrounds    │
│                                │          │ midi.mjs     MIDI parsing, rendering,│
│                                │          │              piano-roll covers       │
└────────────────────────────────┘          └──────────────┬───────────────────────┘
                                                           │ execFile / spawn
                                        ffmpeg · ffprobe · yt-dlp · fluidsynth · swiftc
```

Two rules shape everything:

1. **Every frame is a pure function of the time.** `renderer.js` draws frame *n* of the output from the project state and *n* alone, with nothing carried over between frames. The preview draws exactly the frame the playhead is in; the export draws frames 0…N−1 in order. They cannot disagree.
2. **The server owns the audio.** Songs are decoded once to 48 kHz 24-bit PCM. Trims, fades, gains, gaps and crossfades are applied by sample index when the soundtrack is assembled, so a boundary at 14.000 s is at sample 672 000, not "about there".

## Ingesting a song

`POST /api/songs` streams the file into `.cache/songs/<id>/source.<ext>`, then:

1. `ffprobe` reads the tags and finds an attached picture or a real video track.
2. The picture (or a thumbnail passed with a download) is converted to `cover-embedded.png` and copied to `cover.png` (the one in use).
3. One `ffmpeg` pass writes `pcm.raw` (s24le stereo 48 kHz) and `preview.m4a` (AAC 160 kb/s, for the browser's `<audio>`).
4. `meta.json` records everything; `exactDuration = samples / 48000`.

Decodes are serialised through one promise chain so a big drop does not fork twenty ffmpegs. Later, on demand, the song also gets `waveform-1200.json` (peak envelope for the trimmer and the waveform progress bar), `spectrum-v1.bin` (the visualizer's band levels) and an `analysis` entry in `meta.json` (liveliness, tempo, beats), all computed from `pcm.raw`.

## MIDI files (`midi.mjs`)

A file that starts with `MThd` (or has a MIDI extension) takes a different path through `ingestPath`: `parseMidi` reads the Standard MIDI File (formats 0, 1 and 2, running status, the tempo map, SMPTE divisions, sequence and track names, karaoke `@T` titles) into a time-stamped event list and the notes with their lengths, and the song is registered at once with the parsed length and title. The decode queue then renders it to `render.wav` with the first renderer that succeeds:

- **FluidSynth** (`fluidsynth -niq -F …` with the SoundFont found in `soundfonts/`, `LINER_SOUNDFONT` or the usual system folders), then peak-normalised with ffmpeg.
- **CoreAudio** on macOS: `tools/midi-render.swift` is compiled with `swiftc` into `.cache/tools/` (keyed by a hash of the source) and drives `AVAudioSequencer` into Apple's DLS General MIDI synthesizer in the engine's offline manual-rendering mode, trims the tail and normalises to −1 dBFS.
- **Built-in**: a worker thread runs the synthesizer at the bottom of `midi.mjs`. Every General MIDI program is a pair of wavetable spectra (bright and dark, generated additively and mip-levelled so high notes do not alias) that each voice crossfades between over time, with an ADSR envelope, optional vibrato and unison detuning; drums are procedural (swept sines, shaped noise); a small Schroeder reverb sits on a send bus; the mix is written as float to a scratch file and converted to a 24-bit WAV normalised to −1 dBFS.

After rendering, `drawPianoRoll` paints the notes (one colour per channel, drums in a lane underneath, octave and bar lines) into a 1400 px cover through ffmpeg's rawvideo input, and the normal decode continues from `render.wav`. The song's `meta.midi` records which renderer was used; `/api/health` reports the renderers available.

## Analysis (`analysis.mjs`)

Runs in a `worker_threads` Worker so the server keeps serving.

- **Liveliness**: the PCM is reduced to 12 kHz mono and analysed with a 512-point FFT: loudness, bass share, spectral-flux onsets and a tempo by autocorrelation combine into a 0–1 score and a label (Lively / Steady / Calm). The beats themselves come from dynamic programming over the onset envelope (Ellis-style beat tracking), refined to sub-frame peaks; `beatConf` says how regular they are.
- **Spectrum**: 24 kHz mono, a 1024-point FFT every 1/60 s, 32 log-spaced bands from 40 Hz to 12 kHz with a 3.5 dB/octave tilt, per-song normalisation, instant rise and a steady fall, written as a small binary file with an `LSPC` header. The renderer interpolates between frames for any time.

`ANALYSIS_VERSION` and `SPECTRUM_VERSION` are stored with the results; bump them when the maths changes and stale results are recomputed.

## Dancers (`sprites.mjs`)

A sprite is a GIF, APNG, WebP, a short video or a set of stills. `ffmpeg` extracts the frames with their original timings (`-fps_mode passthrough`, timestamps from `ffprobe`), keys out a plain background with `colorkey`, scales with premultiplied alpha and tiles everything into `atlas.png` plus `sprite.json` (frame rectangles and durations). The renderer draws the frame for any time with one `drawImage`. The page reads each sprite's frames once to find its *accents*, the frames where the motion settles into a pose, so an in-step dancer lands them on the beats.

## Video backgrounds (`backgrounds.mjs` + `public/h264.js`)

A dropped video is transcoded once into an H.264 MP4 at up to 1080p with no B-frames and a keyframe every second, for the preview's `<video>`, and the same frames are written out as a raw Annex B stream with a keyframe byte index. `h264.js` fetches that stream from the nearest keyframe (a Range request) and decodes it frame by frame with WebCodecs `VideoDecoder`, so the frame drawn for any time is the same one in the preview and the export. A song's own video (the picture track of the file it came from, or the video behind its link, fetched with `yt-dlp`) becomes an entry in the same store.

## Rendering (`public/renderer.js`)

`Renderer(width, height, canvas?)` holds a WebGL1 context for the background (one shader with the Aurora, Cover and Ink styles, driven by the current and previous songs' palettes and the time) and a Canvas 2D context for everything else. `setProject(state)` builds the **timeline** (each song's start, end and crossfade, the intro, gaps and outro) and the per-song **palette** (`extractPalette` on the cover). `layoutFor(t)` computes where the artwork, list, visualizer and dancers go at time *t*, including the eased transitions when dancers arrive or leave. `draw(t, frame)` paints the frame.

## Export (`public/app.js`)

1. `POST /api/render/start` with the output settings and the song list (ids, trimmed ranges, gains); the server answers with a render id and starts encoding the soundtrack in parallel.
2. The page probes `VideoEncoder.isConfigSupported` for H.264 or HEVC at that size. If it is supported, the video is split into two halves and two `Renderer`s with two hardware encoders work in lockstep (each half starts with a keyframe), and the Annex B bitstream is posted in chunks to `/api/render/:rid/chunk?part=n`. Length-prefixed output (some browsers ignore the `annexb` request) is converted on the fly. Without WebCodecs, raw RGBA frames are posted instead and the server runs `ffmpeg` with `libx264` or VideoToolbox.
3. `POST /api/render/:rid/finish`: the server stamps constant-frame-rate timestamps on the bitstream (`setts`), adds BT.709 colour tags, concatenates the parts, muxes them with the finished soundtrack into `Exports/<name>.mp4` and reports the size.

The soundtrack is built by `feedPcm`: lead silence, each song's trimmed range with its fades and gain, the gaps or the equal-power crossfades, the tail, piped into `ffmpeg` with the chosen bass filter and encoded with `aac_at`/`aac` at 320 kb/s or `alac`. Audio filters are always prefixed with `aformat=sample_fmts=fltp` because an `s24le` input would otherwise negotiate integer processing that clips before the limiter.

## Mixes

The mix (song order, every setting, trims, captions, dancers) lives in the browser's local storage under `liner.*` keys, one entry per mix, and is saved after every change. `POST /api/mixes/save` writes a portable folder with `mix.json` (`format: 'liner-mix'`) and copies of every file the mix uses; `POST /api/mixes/load` restores one, re-registering songs under their old ids so nothing has to be re-matched.

## Versions and the supervisor

`APP_VERSION` is defined in both `server.mjs` and `public/app.js` and must match. The server rewrites the page's `src` and `href` URLs with `?v=<version>` so a browser never reuses a stale script, and the page compares the two versions at start and says which side is older.

`node server.mjs` runs a supervisor process that spawns the real server (with `LINER_CHILD=1`) and restarts it when one of the four `.mjs` modules changes on disk, after `node --check` passes and once `/api/health` reports nothing is busy. A crash loop backs off from 1 to 10 s. `LINER_NO_SUPERVISOR=1` runs the server directly.

## Security model

The server listens on `127.0.0.1` only. State-changing requests (`POST`, `PATCH`, `DELETE`) must come from the page itself: a request carrying an `Origin` or `Sec-Fetch-Site` header from another site is refused with 403, which stops a web page you happen to have open from driving your local Liner. Every subprocess is started with an argument array (`execFile`/`spawn`, never a shell); ids in routes are hex-only and looked up in maps; static files are confined to `public/`; *Open* and *Reveal* accept only files inside `Exports/`. Loading a saved mix from a folder you choose trusts that folder's `mix.json`. Do not bind the server to other interfaces: there is no authentication.

## Cache layout

```
.cache/
  songs/<id>/        source.<ext>  meta.json  pcm.raw  preview.m4a  cover.png  cover-embedded.png
                     waveform-1200.json  spectrum-v1.bin  render.wav (a MIDI file's audio)
  tools/             the compiled macOS MIDI renderer
  sprites/<id>/      sprite.json  src/  atlas.png  thumb.png
  backgrounds/<id>/  meta.json  video.mp4  stream.h264  poster.jpg
  logos/<id>.png     + <id>.json
  art/<hash>.png     + <hash>.json      cover-art candidates
  renders/<rid>/     a render in progress (wiped at start)
  downloads.json     the yt-dlp job registry
Exports/   Downloads/   Mixes/
```

## HTTP API

All responses are JSON unless noted. Ids are hex strings.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | capabilities, version, platform, busy flag, folder paths |
| GET / POST | `/api/songs` | list songs / upload one (body = file, `X-File-Name` header) |
| GET / DELETE | `/api/songs/:id` | a song's metadata / remove it |
| POST | `/api/songs/:id/video` | prepare the song's own video |
| GET / POST / DELETE | `/api/songs/:id/cover` | cover PNG / set a custom cover / back to the embedded one |
| POST | `/api/songs/:id/cover/use`, `/cover/none` | apply a found candidate / no cover |
| GET | `/api/songs/:id/headroom?gain=` | peak measurement for Smart 2 bass |
| GET | `/api/songs/:id/waveform`, `/preview.m4a`, `/analysis`, `/spectrum` | derived data |
| POST | `/api/art/search` | cover-art search `{title, artist, album}` |
| GET | `/api/art/:id` | a cached candidate image |
| GET / POST | `/api/logos`; DELETE `/api/logos/:id`; GET `/api/logos/:id.png` | logos |
| GET / POST | `/api/sprites`; GET / PATCH / DELETE `/api/sprites/:id` | dancers |
| POST | `/api/sprites/:id/source`, `/build` | add a frame or file / build the atlas |
| GET | `/api/sprites/:id/atlas.png`, `/thumb.png` | images |
| GET / POST | `/api/backgrounds`; GET / DELETE `/api/backgrounds/:id` | background videos |
| GET | `/api/backgrounds/:id/video.mp4`, `/stream.h264`, `/poster.jpg` | media (Range requests) |
| GET | `/api/links` | yt-dlp jobs |
| POST | `/api/links/resolve`, `/api/links/download` | look up links / queue downloads |
| GET | `/api/links/:id/thumb`; POST `/api/links/:id/add`, `/cancel`; DELETE `/api/links/:id` | a download |
| POST | `/api/render/start`, `/api/render/:rid/chunk?part=`, `/finish`, `/cancel`; GET `/status` | an export |
| GET | `/api/mixes`; POST `/api/mixes/save`, `/api/mixes/load` | saved mixes |
| POST | `/api/open`, `/api/reveal` | open or reveal a file in `Exports/` |
| GET | `/`, `/*.js`, `/*` | the page (with versioned URLs) and static files |

## Measured on an Apple-silicon Mac

| | |
| --- | --- |
| 1080p30 render + hardware H.264 encode | about 300 frames per second (a 2-minute mix in 13 s) |
| 4K30 | about 60–110 frames per second |
| Drawing alone at 1080p | 0.7 ms per frame; the encoder is the bottleneck |
| Two encoders instead of one | about 35 % faster; a third gains nothing |
