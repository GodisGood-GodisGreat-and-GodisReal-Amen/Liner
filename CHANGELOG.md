# Changelog

## 1.1.0 — 2026-10-05

- **MIDI files** (`.mid`, `.midi`, `.kar`, `.rmi`) can be added like any song. They are rendered to audio on import by the best synthesizer available: FluidSynth with a SoundFont, the General MIDI synthesizer built into macOS (through a small Swift helper compiled on first use), or a new built-in synthesizer with nothing to install. The notes are drawn as a piano-roll cover, the file's sequence name becomes the title, and the row carries a *MIDI* mark that names the synthesizer. `LINER_MIDI`, `LINER_SOUNDFONT` and `FLUIDSYNTH` choose and locate the renderers.

## 1.0.0 — 2026-10-04

First public release, in the public domain (The Unlicense).

- Songs from files (audio or the sound of a video), from YouTube and SoundCloud links through yt-dlp, with tags, embedded covers and a cover-art finder (Apple Music, Deezer, Cover Art Archive).
- Sample-exact trims with waveform, fades, trim-to-silence and snap-to-beats; per-song volume; equal-power crossfades; sorting by title, artist, length, tempo or energy.
- Aurora, Cover, Ink and Video backgrounds, with motion, darkening and grain; per-song backgrounds and a song's own video behind it or in the artwork's place.
- Text options (title, subtitle, counts, "Now playing", "Up next", mix clock, elapsed/left), typefaces, list styles, markers, captions and a logo, all placeable with snapping guides.
- Frequency visualizer (bars, bands, wave) computed on the server so the preview and the export match.
- Dancers from GIFs, animated images, short videos or stills, with automatic background knock-out, in-step beat following and an Auto mode that picks the lively tracks.
- Export at any size and frame rate, H.264 or HEVC through WebCodecs with two hardware encoders in parallel (ffmpeg fallback), AAC or Apple Lossless, three bass boosters.
- Mixes with autosave, undo and redo, portable Save/Load copies.
- A self-restarting server and a version handshake between the page and the server.
- For the release: the API refuses cross-origin requests, *Open* and *Reveal* only accept files inside `Exports/`, the file manager is used on Linux and Windows too, shortcut labels adapt to the platform, and a round of fixes from a code review (a leaked WebGL context after a cancelled export, a race between two decoders of the same background video, polling for a song's video stopping when its sheet closed, saved mixes copying every raw sprite source, and a handful of dead code).
