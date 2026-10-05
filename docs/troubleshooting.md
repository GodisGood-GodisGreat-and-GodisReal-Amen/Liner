# Troubleshooting

**"The Liner server is not reachable."** The page is open but `node server.mjs` is not running, or it runs on another port. Start it and reload; check the terminal for the `http://localhost:8865` line.

**The terminal says `ffmpeg not found`.** Install FFmpeg (see [Getting started](getting-started.md#installing-ffmpeg)) or point Liner at it: `FFMPEG=/path/to/ffmpeg FFPROBE=/path/to/ffprobe npm start`.

**`video - / -` in the start-up line.** FFmpeg has no H.264/HEVC encoder. On a Mac any Homebrew build has VideoToolbox; on Linux or Windows the build needs `libx264` (and `libx265` for HEVC). With a Chromium browser the export still works, because the page encodes on the GPU; only the ffmpeg fallback and background-video preparation need a server-side encoder.

**The page and the server disagree about their versions.** After an update, a toast says which side is older: reload the page, or stop the server (Ctrl-C) and start it again. The supervisor normally restarts the server by itself when the code changes.

**"The page is from an older version…" keeps appearing.** The browser is holding an old copy of the page. Reload with the cache bypassed (⇧⌘R / Ctrl+F5).

**A song stays on its spinner or shows an error.** FFmpeg could not decode the file. The terminal prints the reason ("decode failed for …"). Try converting the file with FFmpeg by hand; DRM-protected files cannot be decoded.

**Export is dimmed.** No song is ready yet, or every song failed to decode.

**HEVC is dimmed.** Neither the browser nor FFmpeg can encode HEVC at this size. Chrome on a Mac and most Windows machines with recent GPUs can; otherwise use H.264.

**The export fails with an ffmpeg message.** The last line of ffmpeg's output is shown in the sheet and in the terminal. Common causes: the disk is full; the output size is larger than the hardware encoder accepts (try H.264 at a smaller size, or HEVC for 8K); a background video could not be decoded.

**The preview stutters but the export is fine.** The preview draws at your display's rate; a very large preview (expanded, on a 5K display) with 4K output, video backgrounds and dancers can exceed what the GPU draws in time. Shrink the window or the preview; the export is unaffected.

**Video backgrounds show a plain colour in the preview.** The browser has no WebCodecs `VideoDecoder` (Safari, Firefox). Use Chrome, Edge or another Chromium browser.

**"Add from a link" says yt-dlp is not installed.** Install it (`brew install yt-dlp`, `pip install yt-dlp` or `winget install yt-dlp.yt-dlp`) and restart Liner, or set `YTDLP=/path/to/yt-dlp`. If a download fails, update yt-dlp first: sites change often.

**A MIDI file sounds thin or wrong.** Liner used its built-in synthesizer or the macOS one. For real instrument sounds install FluidSynth and a General MIDI SoundFont (see [Getting started](getting-started.md#midi-files)); the row's *MIDI* mark says which synthesizer rendered the song. Re-add the file after installing them. `LINER_MIDI=builtin` forces the built-in one if the macOS synthesizer misbehaves.

**"The MIDI file has no notes."** The file only holds tempo or text events, or every note is on a channel the file never sounds. Open it in a sequencer to check.

**A MIDI file is rejected or silent on macOS and the terminal mentions swiftc.** The Xcode Command Line Tools are missing or broken (`xcode-select --install`); until then Liner falls back to its built-in synthesizer automatically.

**The cover-art finder returns nothing.** The query is built from the title, artist and album; edit it in the sheet (artist and song, without "feat." or "official video") and search again. The finder needs internet access to itunes.apple.com, api.deezer.com, musicbrainz.org and coverartarchive.org.

**Dancers do not appear.** In *Auto* mode they only appear on tracks whose liveliness is above the Sensitivity threshold; open *Review tracks…* to see the scores or force a track On, or choose *Every track*. Dancers also pop in only once a track's audio starts, so the intro and the first second of a song are empty by design.

**The in-step dancers look off the beat.** The beat tracker needs a reasonably regular pulse; *Review tracks…* shows the detected BPM. For rubato music choose *Own pace*.

**A mix is gone after clearing the browser's storage.** Mixes live in the browser's local storage. *Save mix…* writes a portable copy into `Mixes/` that *Load mix…* restores, songs included. Make one for anything you care about.

**The cache is large.** `.cache/songs` holds a decoded copy of every song (about 17 MB per minute). Removing songs in the app deletes their files once no mix uses them; deleting `.cache/` entirely starts clean (load a saved mix afterwards).

**The port is in use.** Another Liner (or something else) listens on 8865. Stop it, or run `PORT=8866 npm start` and open that port.

**Something else.** Open the browser's developer console: Liner prints the export's progress and any error there, and `window.liner` exposes the page's state for inspection. The server prints every failure to its terminal with the time. Please include both when reporting a problem.
