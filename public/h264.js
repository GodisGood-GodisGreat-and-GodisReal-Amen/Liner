// Frame-exact background video for the export. The server keeps each background as a raw H.264 Annex B stream:
// one access unit per frame, no B-frames, a keyframe every second at known byte offsets. H264Source fetches the
// stream from the keyframe before the first frame wanted, splits it into access units and decodes them in order
// with WebCodecs, handing out the VideoFrame for whichever frame index the renderer asks for next. It reads a
// little ahead to keep the hardware decoder busy and closes frames as soon as they are behind.

// Splits Annex B bytes into access units as they stream in. Once a unit holds a picture, the next access unit
// delimiter, parameter set or SEI, or a slice whose first_mb_in_slice is 0, starts the next unit (so leading
// non-picture NAL units stay with the picture that follows them, as ffprobe counts them). A NAL unit is only
// complete once the next start code shows up, so the tail is kept for later.
export class AnnexBSplitter {
  constructor() { this.buf = new Uint8Array(0); this.au = null; }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    const b = this.buf = merged, out = [], starts = [];
    for (let p = 0; p + 2 < b.length; p++) {
      if (b[p] === 0 && b[p + 1] === 0 && b[p + 2] === 1) { starts.push([p > 0 && b[p - 1] === 0 ? p - 1 : p, p + 3]); p += 2; }
    }
    for (let k = 0; k + 1 < starts.length; k++) this.take(b, starts[k][0], starts[k][1], starts[k + 1][0], out);
    this.buf = b.slice(starts.length ? starts[starts.length - 1][0] : 0);
    return out;
  }
  take(b, s, h, e, out) { // one NAL unit at [s, e) whose header byte is at h
    const type = b[h] & 0x1f, firstMb = (type === 1 || type === 5) && (b[h + 1] & 0x80) !== 0;
    const cur = this.au;
    if (cur && cur.slice && (type === 9 || type === 6 || type === 7 || type === 8 || ((type === 1 || type === 5) && firstMb))) out.push(this.finish()); // only a unit that already holds a picture is complete
    if (!this.au) this.au = { parts: [], slice: false, key: false };
    this.au.parts.push(b.slice(s, e));
    if (type === 1 || type === 5) this.au.slice = true;
    if (type === 5) this.au.key = true;
  }
  finish() {
    const au = this.au; this.au = null;
    let n = 0; for (const p of au.parts) n += p.length;
    const data = new Uint8Array(n); let o = 0; for (const p of au.parts) { data.set(p, o); o += p.length; }
    return { data, key: au.key };
  }
  end() { // the last NAL unit (no start code follows it) and the unit it completes
    const b = this.buf, out = [];
    const h = b.length > 4 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 1 ? 4 : b.length > 3 && b[0] === 0 && b[1] === 0 && b[2] === 1 ? 3 : -1;
    if (h > 0) this.take(b, 0, h, b.length, out);
    this.buf = new Uint8Array(0);
    if (this.au && this.au.slice) out.push(this.finish()); else this.au = null;
    return out;
  }
}

export class H264Source {
  constructor(url, meta) {
    this.url = url; this.meta = meta;
    this.frames = new Map(); this.decoder = null; this.reader = null; this.splitter = null; this.queue = [];
    this.eof = false; this.flushed = false; this.feedIndex = 0; this.lowest = 0; this.wantIndex = 0; this.lookahead = 3;
    this.waiters = []; this.error = null; this.current = null; this.currentIndex = -1;
  }
  keyBefore(index) { // [frameIndex, byteOffset] of the last keyframe at or before index
    const k = this.meta.key; let lo = 0, hi = k.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (k[mid][0] <= index) lo = mid; else hi = mid - 1; }
    return k[lo] || [0, 0];
  }
  open(index) { // one open at a time: a second caller waits for the first instead of cancelling its stream
    if (!this.opening) this.opening = this.reopen(index).finally(() => { this.opening = null; });
    return this.opening;
  }
  async reopen(index) {
    this.closeStream();
    const [kIndex, pos] = this.keyBefore(index);
    const res = await fetch(this.url, { headers: { Range: `bytes=${pos}-` }, cache: 'no-store' });
    if (!(res.ok || res.status === 206) || !res.body) throw new Error(`The background video could not be read (${res.status}).`);
    this.reader = res.body.getReader(); this.splitter = new AnnexBSplitter(); this.queue = [];
    this.eof = false; this.flushed = false; this.feedIndex = kIndex; this.lowest = kIndex; this.lookahead = 3; this.error = null;
    this.decoder = new VideoDecoder({ output: (f) => this.onFrame(f), error: (e) => { this.error = e; this.wake(); } });
    this.decoder.configure({ codec: this.meta.codec || 'avc1.64001F', codedWidth: this.meta.w, codedHeight: this.meta.h, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  }
  closeStream() {
    if (this.reader) { this.reader.cancel().catch(() => {}); this.reader = null; }
    if (this.decoder) { try { if (this.decoder.state !== 'closed') this.decoder.close(); } catch { /* already closed */ } this.decoder = null; }
    for (const f of this.frames.values()) f.close();
    this.frames.clear(); this.current = null; this.currentIndex = -1;
  }
  onFrame(f) {
    const idx = Math.round((f.timestamp * this.meta.fps) / 1e6);
    if (idx < this.wantIndex) f.close();
    else { const old = this.frames.get(idx); if (old) old.close(); this.frames.set(idx, f); }
    this.wake();
  }
  wake() { const w = this.waiters; this.waiters = []; for (const r of w) r(); }
  async nextAU() {
    while (!this.queue.length) {
      if (this.eof) return null;
      const { value, done } = await this.reader.read();
      if (done) { this.eof = true; this.queue.push(...this.splitter.end()); break; }
      this.queue.push(...this.splitter.push(value));
    }
    return this.queue.shift() || null;
  }
  // The frame for `index` when it is already decoded, made current at once; null when it would have to wait.
  takeReady(index) {
    if (index === this.currentIndex && this.current) return this.current;
    const f = this.frames.get(index);
    if (!f) return null;
    this.wantIndex = index;
    for (const [k, g] of this.frames) if (k < index) { g.close(); this.frames.delete(k); }
    this.current = f; this.currentIndex = index;
    return f;
  }
  // The VideoFrame for frame `index`. Frames are decoded in order from the nearest keyframe; going backwards (the
  // loop wrapping) or jumping far ahead starts again at the keyframe before the wanted frame. `keep` leaves that
  // many frames before `index` in place (a preview priming the next frame keeps the one on screen).
  async frameAt(index, keep = 0) {
    if (index === this.currentIndex && this.current) return this.current;
    // any step backwards (the loop wrapping) decodes again from the keyframe before; a second pass covers an open
    // that another caller started for a different place
    for (let pass = 0; pass < 2 && (!this.decoder || index < this.currentIndex - keep || index < this.lowest || this.keyBefore(index)[0] > this.feedIndex); pass++) await this.open(index);
    if (this.error) throw this.error;
    this.wantIndex = index - keep;
    for (const [k, f] of this.frames) if (k < index - keep) { f.close(); this.frames.delete(k); }
    let waits = 0;
    while (!this.frames.has(index)) {
      if (this.error) throw this.error;
      if (!this.eof && this.feedIndex <= index + this.lookahead) {
        const au = await this.nextAU();
        if (au) {
          this.decoder.decode(new EncodedVideoChunk({ type: au.key ? 'key' : 'delta', timestamp: Math.round((this.feedIndex * 1e6) / this.meta.fps), data: au.data }));
          this.feedIndex++;
          if (this.decoder.decodeQueueSize > 12) { const dec = this.decoder; await new Promise((r) => { const h = () => { dec.removeEventListener('dequeue', h); r(); }; dec.addEventListener('dequeue', h); setTimeout(h, 50); }); }
          continue;
        }
      }
      if (this.eof && !this.flushed) { this.flushed = true; await this.decoder.flush().catch(() => {}); continue; }
      if (this.eof && this.feedIndex <= index) throw new Error('The background video is shorter than expected.');
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, 40); });
      if (++waits % 4 === 0 && this.lookahead < 24) this.lookahead *= 2; // the decoder holds more frames back than expected: read further ahead
      if (waits > 400) throw new Error('The background video stopped decoding.');
    }
    this.current = this.frames.get(index); this.currentIndex = index;
    return this.current;
  }
  close() { this.closeStream(); }
}
