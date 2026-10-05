# Getting started

This guide takes you from nothing to your first exported mix video.

## 1. Requirements

| What | Why | Check |
| --- | --- | --- |
| **Node.js 18 or newer** | runs the local server | `node --version` |
| **FFmpeg** (`ffmpeg` and `ffprobe`) | decodes songs, builds sprites, writes the final MP4 | `ffmpeg -version` |
| **yt-dlp** (optional) | the *Add from a link* feature | `yt-dlp --version` |
| **FluidSynth + a SoundFont** (optional) | the best sound for MIDI files; without them Liner uses the macOS synthesizer or its own | `fluidsynth --version` |
| **A Chromium browser** | Chrome, Edge, Brave, Arc… for GPU encoding and video backgrounds | |

### Installing FFmpeg

- **macOS** (Homebrew): `brew install ffmpeg` (add `yt-dlp` to the same command for links).
- **Ubuntu / Debian**: `sudo apt install ffmpeg` and, for links, `pip install yt-dlp` or `pipx install yt-dlp`.
- **Fedora**: `sudo dnf install ffmpeg` (RPM Fusion), `pip install yt-dlp`.
- **Windows**: `winget install Gyan.FFmpeg` and `winget install yt-dlp.yt-dlp`, then open a new terminal so the PATH is refreshed.

FFmpeg 5.1 or newer is required (Liner uses `-fps_mode`, the `setts` bitstream filter and the `acrossover` audio filter). A current Homebrew, apt or winget build is fine. For HEVC export on Linux or Windows the build needs `libx265`; H.264 needs `libx264` (both are in the usual builds). On a Mac, FFmpeg uses the VideoToolbox hardware encoders and Apple's AAC/ALAC codecs automatically.

## 2. Get the code

```bash
git clone https://github.com/GodisGood-GodisGreat-and-GodisReal-Amen/Liner.git
cd Liner
```

There is no `npm install` step: Liner has no dependencies.

## 3. Start it

```bash
npm start
```

(or `node server.mjs`). The terminal prints something like:

```
Liner 1.0.0 · http://localhost:8865  (ffmpeg 8.0.1; video h264_videotoolbox / hevc_videotoolbox; audio aac_at / alac_at)
Exports → /path/to/Liner/Exports
Downloads → /path/to/Liner/Downloads (yt-dlp 2026.08.19)
```

The line tells you which encoders were found. `video - / -` means FFmpeg has no H.264 or HEVC encoder, and `audio - / -` means no AAC encoder; see [Troubleshooting](troubleshooting.md).

Open **http://localhost:8865** in your browser. Keep the terminal open while you work; **Ctrl-C** stops the server.

The command runs a small supervisor that restarts the server whenever one of its source files changes on disk (after the file parses and once no export or download is in flight), so updating the code never needs a manual restart. `LINER_NO_SUPERVISOR=1 node server.mjs` (or `npm run start:plain`) runs the server directly.

### MIDI files

A `.mid` file holds notes, not sound, so Liner renders it to audio when you add it. It picks the best synthesizer it finds, in this order:

1. **FluidSynth with a SoundFont**, when both are installed. Install FluidSynth (`brew install fluid-synth`, `sudo apt install fluidsynth`, `winget install FluidSynth.FluidSynth`) and put a General MIDI SoundFont (`.sf2` or `.sf3`, such as *FluidR3_GM* or *GeneralUser GS*) in a `soundfonts/` folder next to the code, or point `LINER_SOUNDFONT` at it. Debian and Ubuntu's `fluid-soundfont-gm` package installs one where Liner looks.
2. **The General MIDI synthesizer built into macOS** (the instrument bank QuickTime uses). Liner compiles a small helper from `tools/midi-render.swift` the first time, which needs the Xcode Command Line Tools that Homebrew already requires.
3. **Liner's own synthesizer**, which needs nothing at all and runs everywhere.

`LINER_MIDI=builtin` (or `coreaudio`, `fluidsynth`) forces one of them. The song's row carries a small *MIDI* mark whose tooltip says which synthesizer was used; its cover is a piano roll of the notes until you choose another.

Three small MIDI files to try are in `docs/demo/` (a band piece with a tempo change, a sparse piano piece, a chiptune run).

## 4. Your first mix

1. **Add songs.** Drag audio files anywhere into the window, or click **+** in the Tracks header. Titles, artists and covers come from the tags. You can also drop a video file: its sound becomes the song.
2. **Tidy the list.** Drag the grip at the left of a row to reorder. Click a title or artist to edit it. Click a thumbnail for *Cover art…* if a song has none, or press the sparkle button in the Tracks header to find artwork for every song at once.
3. **Name the mix.** Type a title in the top bar. It appears at the head of the tracklist in the video.
4. **Press play.** The preview plays with sound. Space toggles playback, ← → seek 5 s, clicking a row jumps to that song.
5. **Pick a look.** In the Look tab, try the four presets, then a background style (Aurora, Cover, Ink or Video) and a visualizer.
6. **Choose the output.** In the Output tab pick a resolution (720p to 4K, or custom), frame rate, codec and audio format. The estimated file size updates as you go.
7. **Export.** Press **Export** (⌘E or Ctrl+E). A sheet shows the progress and the frames as they are encoded. When it is done, **Open** plays the file and **Reveal** shows it in your file manager. The file is in `Exports/`.

A two-minute 1080p30 mix takes about 15 seconds on an Apple-silicon Mac; 4K takes roughly four times longer.

## 5. Where things go

All of these live next to the code and are ignored by Git:

| Folder | Contents |
| --- | --- |
| `Exports/` | the finished MP4 files |
| `Downloads/` | audio fetched from links (24-bit WAV plus the thumbnail), kept until you delete it from the link sheet |
| `Mixes/` | copies written by *Save mix…*, each a folder with `mix.json` and every file the mix uses |
| `.cache/` | the working data: decoded songs, covers, spectra, sprite atlases, background videos, art-finder results |

Your mixes themselves (the song order, every setting, trims, captions, dancers) live in the browser's local storage for `localhost:8865`. They save themselves as you work. *Save mix…* writes a portable copy into `Mixes/`; *Load mix…* brings one back, together with any song or video missing from the cache. Deleting `.cache/` starts Liner clean (songs disappear from the mixes; load a saved copy to restore them).

## 6. Updating

```bash
git pull
```

If the server was running, the supervisor restarts it. Reload the page afterwards; if the page and the server disagree about their versions, a notice says which one to refresh.

## 7. Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8865` | the port the server listens on (always on `127.0.0.1`) |
| `FFMPEG`, `FFPROBE` | `ffmpeg`, `ffprobe` | paths to the binaries when they are not on the PATH |
| `YTDLP` | `yt-dlp` | path to yt-dlp; Liner also looks in `/opt/homebrew/bin`, `/usr/local/bin` and `~/.local/bin` |
| `LINER_NO_SUPERVISOR` | unset | `1` runs the server without the auto-restarting supervisor |
| `LINER_MIDI` | unset | `fluidsynth`, `coreaudio` or `builtin`: which synthesizer renders MIDI files (the best available otherwise) |
| `LINER_SOUNDFONT` | unset | path to the `.sf2`/`.sf3` SoundFont for FluidSynth (otherwise `soundfonts/` next to the code and the usual system folders are searched) |
| `FLUIDSYNTH` | `fluidsynth` | path to the FluidSynth binary |

Example: `PORT=9000 FFMPEG=/opt/ffmpeg/bin/ffmpeg npm start`.

## Next

The [user manual](manual.md) covers every control. [How it works](architecture.md) explains the pipeline if you want to change something.
