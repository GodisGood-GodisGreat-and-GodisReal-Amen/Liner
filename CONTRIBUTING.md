# Contributing

Thanks for looking under the hood. Liner is small on purpose: four server modules, four browser files, no build step and no dependencies. Keep it that way where you can.

## Running from source

```bash
git clone https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Liner.git
cd Liner
npm start
```

`npm start` runs the supervisor: edit `server.mjs`, `analysis.mjs`, `sprites.mjs` or `backgrounds.mjs` and the server restarts itself once the file parses and nothing is exporting. Browser files (`public/`) are served fresh on every reload; the server appends `?v=<version>` to their URLs so a stale copy is never used.

`npm run check` syntax-checks every file. There is no test suite yet; the checks that matter are visual and audible, so run the app and look.

## Layout

| File | What it is |
| --- | --- |
| `server.mjs` | the HTTP server: routes, song ingestion, renders, mixes, the cover-art finder, the supervisor |
| `analysis.mjs` | liveliness, tempo, beats and the visualizer's spectrum, in a worker thread |
| `sprites.mjs` | dancer atlases from GIFs, animations, videos or stills |
| `backgrounds.mjs` | background videos (transcode, raw stream, poster) |
| `midi.mjs` | MIDI files: parser, the renderer chain (FluidSynth, macOS, built-in synthesizer in a worker), piano-roll covers |
| `tools/midi-render.swift` | the macOS MIDI renderer, compiled by `midi.mjs` on first use |
| `public/index.html` | the page: every control is declared here with `data-seg`, `data-range`, `data-switch` attributes bound by `app.js` |
| `public/app.js` | state, undo history, the player, every sheet, the export driver |
| `public/renderer.js` | the frame: WebGL background, Canvas 2D everything else, layout and timeline |
| `public/h264.js` | frame-exact decoding of background videos with WebCodecs |
| `public/styles.css` | the look of the editor |
| `tools/logo.py` | regenerates the Liner mark (`favicon.svg` and the `#i-liner` symbol) |

[How it works](docs/architecture.md) explains the pipeline.

## Conventions

- **Plain JavaScript, ES modules, no transpiling.** Target the current Chromium; feature-check anything newer than Chrome 110 or missing from Safari (see the `'letterSpacing' in ctx` pattern).
- **Everything the frame draws must be a pure function of the time**, so that the preview and the export stay identical. No per-frame state in the renderer.
- **Audio is sample-exact on the server.** Never resample or trim in the browser.
- **Comments say why, in plain words.** The code base reads like prose on purpose; keep that voice.
- **Bump `APP_VERSION`** in both `server.mjs` and `public/app.js` with every release, and `ANALYSIS_VERSION` / `SPECTRUM_VERSION` / `SPRITE_VERSION` when their outputs change so caches are rebuilt. A MIDI song keeps its rendered audio; delete the song and add it again to hear a changed synthesizer.
- **The server listens on the loopback interface and refuses cross-origin requests.** Keep every subprocess on `execFile`/`spawn` with argument arrays, and keep ids hex-only.
- Match the existing style: two-space indent, single quotes, semicolons, one statement per line unless it is a short guard.

## Debugging

- `window.liner` in the browser console exposes the state and most functions (`liner.state`, `liner.seek(30)`, `liner.startExport()`).
- The export logs its mode, part count and timing with `console.info`.
- Set `state.output.parts = 1` from the console to force a single encoder when comparing speeds.
- The server prints every failure with a timestamp; `ffmpeg` errors are cut to their last line.

## Pull requests

Keep them focused, describe what changed in the user's terms, and add a line to `CHANGELOG.md`. Screenshots or a short clip help for anything visual.

Liner is public domain under [The Unlicense](LICENSE). By contributing, you dedicate your contribution to the public domain on the same terms.
