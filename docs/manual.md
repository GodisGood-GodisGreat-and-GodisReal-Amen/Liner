# Liner user manual

Everything in the editor, in the order you meet it. Shortcuts are written for a Mac (⌘ ⌥ ⇧ ⌫); on Windows and Linux the same keys read Ctrl, Alt, Shift and Backspace, and the page shows them that way.

## Contents

1. [The window](#1-the-window)
2. [Adding songs](#2-adding-songs)
3. [The tracklist](#3-the-tracklist)
4. [Cover art](#4-cover-art)
5. [Trimming](#5-trimming)
6. [Song settings: volume and video](#6-song-settings-volume-and-video)
7. [Playback and the preview](#7-playback-and-the-preview)
8. [Mixes, saving, loading, undo](#8-mixes-saving-loading-undo)
9. [Look tab](#9-look-tab)
10. [Dancers tab](#10-dancers-tab)
11. [Output tab and exporting](#11-output-tab-and-exporting)
12. [Keyboard shortcuts](#12-keyboard-shortcuts)
13. [Files and folders](#13-files-and-folders)

## 1. The window

![The editor](images/editor.png)

- **Top bar.** The Liner mark, the **mix title** (type to name the mix), the **Mixes** button next to it (switch, create, duplicate, save, load, reset or delete mixes), **Undo** and **Redo**, the **keyboard** button (every shortcut) and **Export**.
- **Tracks** (left). The songs in order, with a count and the total length. The header has four buttons: **⋯** (sort, reverse, shuffle), **sparkles** (find cover art for every song), **link** (add from a link) and **+** (add files).
- **Preview** (middle). Exactly what the video will look like at the current time, with a transport underneath: play/pause, current time, scrubber, total length, volume, the output format chip, and an expand button.
- **Inspector** (right). Three tabs: **Look**, **Dancers**, **Output**.

Both panels can be resized by dragging their inner edge; double-click the edge to restore the default width. Every group in the inspector folds from its title and remembers whether it was folded.

## 2. Adding songs

**From files.** Drop audio files anywhere in the window, or click **+**. MP3, FLAC, WAV, AIFF, M4A, AAC, OGG, Opus, WMA, CAF and more are accepted, and so are video files (MP4, MOV, WebM, MKV…): the sound becomes the song and the picture can be used later as the song's own video (see [Song settings](#6-song-settings-volume-and-video)).

Title, artist and album come from the tags. A missing title falls back to the file name ("03 - Artist - Title.flac" is understood). An embedded cover is extracted; without one the song gets a generated tile in colours derived from its title.

**MIDI files** (`.mid`, `.midi`, `.kar`, `.rmi`) are accepted too. Because they hold notes rather than sound, Liner renders them to audio as the song is prepared: with FluidSynth and a SoundFont when both are installed, otherwise with the General MIDI synthesizer built into macOS, otherwise with its own built-in synthesizer. The row shows a small *MIDI* mark; its tooltip names the synthesizer. The sequence name inside the file becomes the title when there is one, and the notes are drawn as a **piano roll** that serves as the cover until you choose another (*Use the original art* brings the piano roll back). See [Getting started](getting-started.md#midi-files) for the synthesizers and how to get better sound.

Each song is decoded once on the server: a sample-exact 48 kHz 24-bit copy for the final soundtrack and a small preview for the browser. A row shows a spinner until that is done. The **Export** button stays dimmed until at least one song is ready.

**From a link.** Click the link button, or paste a YouTube or SoundCloud URL anywhere in the window (⌘V). Each song, playlist or set is fetched with `yt-dlp` at the best audio quality offered, decoded to 24-bit WAV into `Downloads/` with its artwork, and listed in the sheet with **Add** and delete buttons, so you choose what goes into the tracks. Paste several links, one per line, and press **Fetch** (⌘Enter in the text box). **Add all ready** adds everything that has finished. Downloaded files stay in `Downloads/` until you delete them from this sheet; adding one copies it into the cache. The sheet says so if `yt-dlp` is not installed.

Up to two links download at a time; the window title shows the progress so you can read it from another tab.

## 3. The tracklist

- **Reorder** by dragging the grip at the left of a row, or select a row and press ⌥↑ / ⌥↓.
- **Edit** the title or artist by clicking it. A song's menu has **Use the file's title and artist** to go back to the tags.
- **Select** a row by clicking it; ↑ ↓ move the selection, Enter plays from that song, ⌫ removes it (an **Undo** toast stays for a few seconds).
- **Play from here.** Hovering a row shows a play button in its number column.
- **Right-click** a row (or click its thumbnail) for its menu: *Cover art…*, *Trim…*, *Song settings…*, *Export only this song…*, *Use the original art* (when a custom cover is set), *Use the file's title and artist*, *Remove song*.
- **The film button** on a row shows the state of the song's own video: lit when it is ready, pulsing while it is being prepared, red when it could not be prepared. It opens Song settings.
- **The duration** shows a scissors mark when the song is trimmed and a small figure when dancers will appear on it.
- **Drop an image on a row** to use it as the cover.
- **Order the songs** (⋯ in the header): sort by title, artist, length, tempo or energy; reverse; shuffle. Tempo and energy come from the audio analysis and are available once it has run.

## 4. Cover art

Choose **Cover art…** from a thumbnail's menu. The sheet offers three ways:

- **Find automatically** searches Apple Music, Deezer and the Cover Art Archive (MusicBrainz) with the song's title, artist and album, downloads the candidates, ranks them by how well they match and by resolution, and shows real pixel sizes so you can pick. Edit the query and search again if the first results are off. No accounts or keys are needed.
- **Choose an image** takes any picture you drop or browse to.
- **No cover** uses the generated tile.

The **sparkle button** in the Tracks header runs the finder over every song that has no proper artwork yet (none, or only a video thumbnail from a link) and applies the confident matches. The thumbnail's tooltip says where the current cover came from ("Embedded in the file", "Thumbnail from the link", "Apple Music, 3000 × 3000"…).

## 5. Trimming

**Trim…** in a song's menu keeps only part of a song, a track cut from a concert, say.

- Drag the handles on the waveform, or type start and end times. **Start here (I)** and **End here (O)** set them at the playhead.
- **Play** (Space) auditions the kept part.
- **Trim silence** moves the cuts to where the sound starts and ends. **Snap to beats** moves each cut to the nearest detected beat.
- **Fade the cuts** adds short fades at both ends.
- **Reset** clears the trim; **Apply** keeps it.

The list, the preview and the export all use the trimmed part. Cuts are sample-exact.

## 6. Song settings: volume and video

**Song settings…** (the film button, the row's menu, or Look › Background › *Per song*) holds everything that applies to one song.

**Volume**: −12 to +6 dB, applied in the preview and the export. Double-click the slider for 0 dB.

**Video**: two cards are always shown.

- **This song's video**: the picture of the file the song came from, or the video behind the link it was downloaded from (fetched on request, up to 1080p). Greyed out when the song has neither. Choosing it prepares the video; the row's film button pulses meanwhile.
- **Another video**: drop or browse to any video; it starts with the song and loops.

Choosing a card makes the video the song's background straight away. Below, pick where it goes: **Audio only** (off), **Background** (behind everything, with an optional **Blur**), **Artwork** (in the artwork's place) or **Both**.

**Background for this song**: *Same as the mix*, or an Aurora, Cover or Ink background for just this song when the mix's style is not what it wants. A different background fades in as the song starts.

## 7. Playback and the preview

- **Play/Pause**: Space. **Seek**: ← → 5 s, ⇧← ⇧→ 30 s, Home to the start. `,` and `.` step one frame (⇧ for ten). While paused the time shows the frame within the second.
- **Scrubber**: drag it; hovering shows the time and the song under the pointer. The coloured sections are the songs.
- **Volume**: the slider and **M** for mute. The preview volume is remembered and does not affect the export.
- **Expand** (F, or double-click the preview) hides both panels around the preview; Esc or F brings them back.
- **Drag things in the preview.** The visualizer, each dancer, every caption and the logo can be picked up and moved. They snap to the frame's centre lines and margins with a guide line. Click one to select it, then the arrow keys nudge it a pixel (⇧ ten); Esc or a click elsewhere lets go. Dragging a visualizer, dancer or logo out of a preset place frees it ("Anywhere").
- **The preview is the export.** It draws at the time of the output frame the playhead is in, with the same decoded video frames and the same grain, so what you see is what the file will contain.

## 8. Mixes, saving, loading, undo

The **Mixes** button next to the title lists your mixes ("title · number of songs") and offers **New mix**, **Duplicate this mix**, **Save mix…**, **Load mix…**, **Reset every setting…** and **Delete this mix…**. Song files are shared between mixes and removed from disk only when no mix uses them.

Mixes save themselves as you work, in the browser's storage. **Save mix…** writes a portable copy as a safeguard: **In Liner's Mixes folder** (`Mixes/<title — date>/`), or on a Mac **Somewhere else…** through the system folder chooser. The copy holds `mix.json` and everything the mix uses: each song's original file and cover, the dancers' sprites, the logo and the videos. **Load mix…** lists the copies in `Mixes/` (or lets you pick a folder on a Mac); loading makes a new mix from the copy and brings back any song or video missing from the cache under its old identity.

**Undo and redo** (the two arrows, ⌘Z and ⇧⌘Z) step through every change: settings, songs added, removed or reordered, trims, captions, dancers, per-song video and background. A slider drag counts as one step; the arrows' tooltips say what the next step undoes or redoes. Each mix keeps its own history for the session.

**Resets.** A reset arrow appears in a group's title whenever one of its settings differs from the default and puts the whole group back (with an undo). Each tab ends with "Reset … to defaults". Double-click or ⌥-click a slider to reset just that one; click a slider's value to type an exact number (Enter keeps it, Esc cancels).

## 9. Look tab

**Presets.** Four starting points: **Midnight** (aurora, boxes, white marker), **Vinyl** (softened cover, serif, lines, album colour), **Studio** (ink, mono, compact, still) and **Neon** (aurora, album colour, glow, round corners). Everything below stays adjustable.

**Composition.** **Balanced** (the default) keeps the music and artwork in front when several extras are on: the logo, captions, labels and visualizer step back a little, the visualizer softens while dancers are on screen, captions get a soft backing over busy areas, extras arrive a beat after the main picture, and new captions and a new logo land in empty space. **As set** draws everything exactly as its sliders say.

**Background.**
- **Aurora**: flowing colour drawn from each song's artwork. **Cover**: the artwork itself, softened and darkened. **Ink**: a dark, quiet field with a hint of the album colour. **Video**: drop a video of your own; it plays on a loop behind everything, cover-fitted, with an optional **Blur**; its sound is ignored.
- **Motion**: Still, Slow or Normal. For a video it means a single held frame, half speed or normal speed.
- **Per song**: opens [Song settings](#6-song-settings-volume-and-video) for one song.
- **Darken** and **Grain**. Film grain costs bitrate; lower it if the file must be small.

**Artwork.** **Corners** (Sharp, Soft, Round), **Position** (Left or Right; the list moves to the other side) and a **Colour glow** behind the art.

**Typeface.** Sans, Serif or Mono, using the fonts on the viewer's system (SF Pro / New York / SF Mono on a Mac, Inter / Iowan Old Style / Menlo or their fallbacks elsewhere).

**Text.**
- **Mix title**, an optional **Subtitle**, and the **Track count and length** line at the head of the list.
- **Song title and artist** under the artwork, with **Scroll long text** for titles that do not fit.
- **"Now playing" label** above the song title.
- **Up next**: a small label pill and the following track's title and artist under the song time, present throughout and coming forward near the end of the song.
- **Mix clock**: a clock in a corner counting the whole video.
- **Song time**: Elapsed, Left or Both.
- **Progress**: a plain **Bar** or the song's own **Waveform**.

**Track list.** Rows as **Boxes**, **Lines** or **Plain**; **Density** Comfortable or Compact; marker and progress **Colour** in White or the Album's colour; **Marker** as an arrow or a triangle; and switches for **Numbers**, **Thumbnails**, **Durations** and the **Progress bar** on the current row.

**Captions.** Up to six. **Add a caption**, type the text, then drag it where you like in the preview. Each has a **Size**, a **Style** (White or Album colour, Bold) and an **Opacity**.

**Logo.** Drop a logo or watermark. Place it in one of the four corners or **Anywhere** (drag it), with a **Size** and an **Opacity**.

**Visualizer.**
- **Bars** (32 log-spaced bands from 40 Hz to 12 kHz), **Bands** (three meters: low, mid, high) or **Wave** (a smooth curve).
- Place it **Under the artwork**, **On the artwork**, **Along the bottom** or **Along the top** (the layout makes room), **Behind everything** (faint), or **Anywhere**.
- **Height**, **Width** (when free), **Colour** (White, Album, or a low-to-high Spectrum), **Level**, **Low · Mid · High labels** in a Small or Large size, faint **Region guides** where the regions meet, and a **Mirror** style.
- The levels are computed once on the server from each song's decoded audio at 60 frames per second with analyser-style ballistics and normalised per song, so a quiet recording fills the display like a loud one, and the preview and the export show exactly the same picture.

**Timing.** The silence **Intro** before the first song, the **Gap** between songs, the **Outro** after the last one, and a **Crossfade**: each song then starts that many seconds before the previous one ends (at most half of either song) and the two blend with equal-power curves in the preview and the export; the picture changes halfway through the blend and the gap is skipped.

## 10. Dancers tab

Dancers are animated sprites that dance on the video.

**Adding one.** **Add a dancer**, then drop a GIF, an animated PNG or WebP, a short video (up to 12 s) or a set of still images that play in order. The server turns it into one frame atlas with the original timings, knocks out a plain background automatically and keeps pixel art crisp. Sprites you added before stay in a library in the same sheet. Up to four dancers per mix.

**Each dancer's card.**
- A name, and a **⋯** menu: *Replace…*, *Knock out the background*, *Crisp pixels*, *Faster frames* / *Slower frames* (for sets of stills), *Reset settings*, *Remove dancer*.
- **Place**: *Under the artwork*, *Beside the artwork*, *Beside the list*, *Bottom corner*, *On the artwork*, *By the title*, or *Anywhere* (drag it in the preview). Over the artwork or the list a dancer gets a soft pool of shade and a dark halo so it reads on busy covers. For the preset places the layout makes room only while a dancer is on screen: the artwork and list ease into the roomier arrangement just before the first dancer pops in and ease back when the stretch ends.
- **Size**, **Mirror**, **Shadow**.
- **Tempo**: **In step** (the default) follows the track's beats one by one: the loop spans a whole number of beats, the frame where the motion settles into a pose lands on the beat, every dancer in step moves together, and the steps keep up when the tempo breathes, with a short glide onto the next song's beats at a change. **On the beat** runs the loop at the track's average tempo from the start of the song (it can drift over a long track). **Own pace** plays the sprite at its natural speed times a **Speed** setting.

**When they appear.** **Auto** listens to every track for a steady pulse, bass, onsets and loudness and gives each a liveliness score; tracks above the threshold (the **Sensitivity** slider, from *Only the liveliest* to *Nearly every track*) get the dancers, who pop in when the track's audio starts and leave before it ends. **Every track** shows them throughout. **Review tracks…** lists every track with its score, label (Lively / Steady / Calm) and detected BPM, and lets you force any track On or Off; **All back to Auto** clears the overrides.

## 11. Output tab and exporting

- **Resolution**: 720p, 1080p, 1440p, 4K, or **Custom…** with a width and height. 8K is possible with HEVC when the hardware encoder accepts it; H.264 tops out at level 6.2.
- **Frame rate**: 24, 25, 30 or 60.
- **Video**: **H.264** or **HEVC** (dimmed when neither the browser nor FFmpeg can encode it), and a **Quality** of Standard, High or Maximum. The bitrate follows the size, frame rate and quality (about 12 Mb/s for 1080p30 High, 50 Mb/s for 4K30).
- **Audio**: **AAC 320 kb/s** or **Lossless** (Apple Lossless, which plays in QuickTime, VLC and on YouTube).
- **Bass**: **Off**; **Boost**, a plain low shelf (loud songs can clip); **Smart**, which lifts the low band through a crossover, compresses it gently and limits the result so nothing clips; **Smart 2**, which does no compression at all: it measures how much headroom each song needs for the lift, turns that song down by exactly that amount, applies the shelf and keeps only a safety limiter, so dynamics and tone stay as recorded (the file plays a little quieter). The **Strength** slider sets the lift. All are audible in the preview.
- **File**: the file name (the mix title by default). The **Estimated size** and the **Encoder** in use ("GPU, in the browser" or "ffmpeg on this computer") are shown underneath.

**Export** (⌘E) renders every frame in the page, encodes it on the GPU through WebCodecs (two hardware encoders work on the two halves of the video at once) and streams the result to the server, which joins the soundtrack and writes the MP4 to `Exports/`. The sheet shows the frames as they are encoded, the progress and the phases; **Cancel** stops it. When it is done, **Open** plays the file and **Reveal** shows it in Finder, Explorer or your file manager. The window title carries the progress so it reads from another tab. A song's menu can **Export only that song**.

## 12. Keyboard shortcuts

Press **?** or the keyboard button in the top bar for this list inside the app.

| Playback | |
| --- | --- |
| Space | Play or pause |
| ← → | Seek 5 s; with ⇧ 30 s |
| Home | Back to the start |
| , . | One frame back or forward; with ⇧ ten frames |
| M | Mute the preview |

| Tracks | |
| --- | --- |
| ↑ ↓ | Select the previous or next song |
| ⌥ ↑ ↓ | Move the selected song |
| Enter | Play the selected song |
| ⌫ | Remove the selected song (with undo) |
| ⌘ V | Paste a YouTube or SoundCloud link |
| I, O | In the trimmer: set the start or end at the playhead |

| Preview | |
| --- | --- |
| F | Expand or restore the preview |
| Double-click | On the preview: expand or restore it |
| Drag | The visualizer, dancers, captions and the logo, anywhere; they snap to the centre and the margins |
| Click | Select one of them, then ↑ ↓ ← → nudge it a pixel, ⇧ ten |

| Editor | |
| --- | --- |
| Double-click | On a slider: back to its default (⌥-click does the same); on a panel edge: default width |
| Click a value | Type an exact number for any slider |
| ⌘ Z | Undo the last change; with ⇧ redo it |
| ⌘ E | Export |
| Esc | Close a sheet, let go of a selection, or leave the expanded preview |
| ? | The shortcut list |

## 13. Files and folders

| Where | What |
| --- | --- |
| `Exports/` | finished videos |
| `Downloads/` | WAVs and thumbnails fetched from links |
| `Mixes/` | portable copies written by *Save mix…* |
| `.cache/songs/<id>/` | a song's original file, `meta.json`, decoded PCM, preview, covers, waveform and spectrum (and `render.wav` for a MIDI file) |
| `.cache/sprites/<id>/` | a dancer's sources, frame atlas and thumbnail |
| `.cache/backgrounds/<id>/` | a background video, its decoder stream and poster |
| `.cache/logos/`, `.cache/art/` | logos and cover-art candidates |
| the browser's local storage | the mixes themselves |

Removing a song in the app deletes its files from the cache once no mix uses it. Deleting `.cache/` starts clean.
