/* =========================================================
   Gapless playback for Jerry Tapes.

   The whole show is streamed into ONE <audio> element through Media Source Extensions,
   so the browser sees a single continuous recording and never stops between songs.
   Each MP3 is fetched in byte ranges, cut on frame boundaries, and appended back to back.
   The silence the MP3 encoder adds to the start and end of every file (described by the
   LAME header) is trimmed with the SourceBuffer's append window, so segues like
   Scarlet > Fire join sample for sample.

   Timeline: each track is a "segment" placed on the media timeline at `start`.
   Jumping to another song, or seeking outside what's buffered, starts a new run of
   segments further along the timeline (old data is removed), so stale audio never plays.
   ========================================================= */
(() => {
  "use strict";

  const FIRST_CHUNK = 128 * 1024; // first request per track: header + a few seconds, so playback starts fast
  const CHUNK = 512 * 1024; //       later requests (about 20 s of a typical VBR MP3)
  const AHEAD = 60; //               seconds to keep buffered ahead of the playhead
  const BEHIND = 15; //              seconds to keep behind it (for small backward seeks)
  const HOLD_FRAMES = 8; //          frames held back from each append, so the track's last append can be trimmed
  const DECODER_DELAY = 529; //      samples an MP3 decoder adds, on top of the encoder delay in the LAME header
  // MediaSource duration while songs are still being added. Not Infinity: that makes the stream "live",
  // and then Chrome won't seek past what's buffered, which a jump to another song needs to do.
  const OPEN_DURATION = 1e6;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------
  // MP3 parsing
  // ---------------------------------------------------------
  const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
  const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
  const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

  // MPEG audio Layer III frame header at b[p], or null
  function frameAt(b, p) {
    if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
    const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3;
    const bri = b[p + 2] >> 4, sri = (b[p + 2] >> 2) & 3, pad = (b[p + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null;
    const v1 = ver === 3, sr = RATES[ver][sri];
    const mono = b[p + 3] >> 6 === 3;
    return {
      sr,
      len: Math.floor(((v1 ? 144000 : 72000) * (v1 ? KBPS_V1 : KBPS_V2)[bri]) / sr) + pad,
      spf: v1 ? 1152 : 576, // samples per frame
      side: v1 ? (mono ? 17 : 32) : mono ? 9 : 17, // side-info size, to find a Xing header
      key: ((b[p + 1] & 0xfe) << 8) | (b[p + 2] & 0x0c), // version, layer and sample rate: constant within a file
    };
  }

  // first position >= from where two consecutive frames match `key` (any key if null)
  function findSync(b, from, key) {
    for (let p = from; p + 4 <= b.length; p++) {
      const h = frameAt(b, p);
      if (!h || (key != null && h.key !== key)) continue;
      const n = frameAt(b, p + h.len);
      if (n && n.key === h.key) return p;
    }
    return -1;
  }

  // Walk whole frames in `data`. Returns the byte spans to append and where the unappended rest begins.
  // Unless this is the end of the file, the last HOLD_FRAMES frames (and any partial frame) are kept back.
  function walkFrames(data, key, eof) {
    const spans = [];
    let p = 0;
    while (p < data.length) {
      const h = frameAt(data, p);
      if (h && h.key === key) {
        if (p + h.len > data.length) break; // partial frame: finish it with the next chunk
        spans.push([p, p + h.len]);
        p += h.len;
        continue;
      }
      // lost sync (a tag or junk): skip to the next real frame
      const q = findSync(data, p + 1, key);
      if (q < 0) { p = eof ? data.length : Math.max(p, data.length - 4096); break; }
      p = q;
    }
    let restAt = p;
    if (!eof) {
      const keep = spans.splice(Math.max(0, spans.length - HOLD_FRAMES));
      if (keep.length) restAt = keep[0][0];
    }
    return { spans, restAt };
  }

  function joinSpans(data, spans) {
    if (!spans.length) return null;
    let contiguous = true;
    for (let k = 1; k < spans.length; k++) if (spans[k][0] !== spans[k - 1][1]) { contiguous = false; break; }
    if (contiguous) return data.subarray(spans[0][0], spans[spans.length - 1][1]);
    const out = new Uint8Array(spans.reduce((n, [s, e]) => n + e - s, 0));
    let o = 0;
    for (const [s, e] of spans) { out.set(data.subarray(s, e), o); o += e - s; }
    return out;
  }

  function concat(a, b) {
    if (!a || !a.length) return b;
    const c = new Uint8Array(a.length + b.length);
    c.set(a);
    c.set(b, a.length);
    return c;
  }

  // Parse the start of a file: skip ID3v2, find the first frame, and read the Xing/Info + LAME header
  // if present. If `more` (the file goes on past b) and the audio starts beyond b, returns { need: offset }.
  function parseHead(b, more) {
    let p = 0;
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) { // "ID3"
      p = 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f));
      if (b[5] & 0x10) p += 10; // footer
    }
    if (more && p + 8192 > b.length) return { need: p };
    const first = findSync(b, p, null);
    if (first < 0) throw new Error("not an MP3 stream");
    const h = frameAt(b, first);
    const info = { sr: h.sr, spf: h.spf, key: h.key, dataStart: first, front: 0, back: 0, frames: 0, toc: null, tocBase: first, tocBytes: 0 };

    const at = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    let x = first + 4 + h.side;
    if (at(x) === "Xing" || at(x) === "Info") {
      const flags = u32(x + 4);
      x += 8;
      if (flags & 1) { info.frames = u32(x); x += 4; }
      if (flags & 2) { info.tocBytes = u32(x); x += 4; }
      if (flags & 4) { info.toc = b.slice(x, x + 100); x += 100; }
      if (flags & 8) x += 4;
      const enc = String.fromCharCode(...b.subarray(x, x + 4));
      if (/^(LAME|Lavc|Lavf|L3.9)/.test(enc)) {
        const delay = (b[x + 21] << 4) | (b[x + 22] >> 4);
        const pad = ((b[x + 22] & 0x0f) << 8) | b[x + 23];
        if (delay > 0 || pad > 0) {
          info.front = delay + DECODER_DELAY;
          info.back = Math.max(0, pad - DECODER_DELAY);
        }
      }
      info.dataStart = first + h.len; // the Xing frame is silent: don't play it
    } else if (at(first + 36) === "VBRI") {
      info.dataStart = first + h.len;
    }
    return info;
  }

  // ---------------------------------------------------------
  // the stream
  // ---------------------------------------------------------
  class GaplessStream {
    static supported() {
      return !!(window.MediaSource && MediaSource.isTypeSupported && MediaSource.isTypeSupported("audio/mpeg"));
    }

    constructor(audio) {
      this.audio = audio;
      this.tracks = [];
      this.segs = []; //       [{ i, start, t0, end }] for the current run, in timeline order
      this.pending = null; //  { i, t } asked for but not on the timeline yet
      this.gen = 0; //         bumped to cancel the running feeder
      this.ms = null;
      this.sb = null;
      this.ctrl = null;
      this.appended = false; // anything appended in the current run?
      this.info = new Map(); // track url -> parsed header
      this.resolved = new Map(); // track url -> datanode url after archive.org's redirect
      this.onfail = null; //   (error, appendedAnything) => void
    }

    // attach a new tape
    load(tracks) {
      this.unload();
      this.tracks = tracks;
      const ms = new MediaSource();
      this.ms = ms;
      this.url = URL.createObjectURL(ms);
      this.ready = new Promise((resolve) => {
        ms.addEventListener("sourceopen", () => {
          if (this.ms !== ms) return;
          this.sb = ms.addSourceBuffer("audio/mpeg");
          ms.duration = OPEN_DURATION; // see OPEN_DURATION; endOfStream() sets the real length at the end
          resolve();
        }, { once: true });
      });
      this.audio.src = this.url;
    }

    unload() {
      this.gen++;
      if (this.ctrl) this.ctrl.abort();
      this.segs = [];
      this.pending = null;
      if (this.ms) {
        this.ms = null;
        this.sb = null;
        URL.revokeObjectURL(this.url);
        this.audio.removeAttribute("src");
        this.audio.load();
      }
    }

    // where the playhead is, as a track index and a time within that track
    position() {
      if (!this.segs.length) return this.pending || { i: 0, t: 0 };
      const ct = this.audio.currentTime;
      let s = this.segs[0];
      for (const x of this.segs) { if (x.start <= ct + 0.0005) s = x; else break; }
      return { i: s.i, t: Math.max(0, ct - s.start + s.t0) };
    }

    // seek within track i (the current one): use what's buffered if possible, otherwise restart there
    seek(i, t) {
      const s = this.segs.find((x) => x.i === i);
      if (s && t >= s.t0) {
        const m = s.start + t - s.t0;
        if ((s.end == null || m < s.end) && this.isBuffered(m)) { this.audio.currentTime = m; return; }
      }
      this.cue(i, t);
    }

    isBuffered(m) {
      const r = this.sb && this.sb.buffered;
      if (!r) return false;
      for (let k = 0; k < r.length; k++) if (r.start(k) <= m && m < r.end(k) - 0.25) return true;
      return false;
    }

    bufferedEnd() {
      const r = this.sb && this.sb.buffered;
      return r && r.length ? r.end(r.length - 1) : 0;
    }

    // start playing from track i at time t: a new run of segments, after everything that's on the timeline now
    async cue(i, t = 0) {
      const gen = ++this.gen;
      if (this.ctrl) this.ctrl.abort();
      const ctrl = (this.ctrl = new AbortController());
      const last = this.segs.length ? this.segs[this.segs.length - 1] : null;
      const start = Math.ceil(Math.max(this.audio.currentTime || 0, this.bufferedEnd(), last ? last.start : 0)) + 1;
      this.pending = { i, t };
      this.segs = [];
      this.appended = false;
      // park the playhead on empty timeline right away, so the old song stops now
      if (this.ms && this.ms.readyState === "open") this.audio.currentTime = start;

      await this.ready;
      if (gen !== this.gen) return;
      try {
        await this.idle();
        if (gen !== this.gen) return;
        if (this.ms.readyState === "open") this.sb.abort();
        if (this.sb.buffered.length) { // removing reopens an ended MediaSource
          this.sb.remove(0, start);
          await this.idle();
          if (gen !== this.gen) return;
        }
        if (this.ms.duration !== OPEN_DURATION) this.ms.duration = OPEN_DURATION;
        if (this.audio.currentTime !== start) this.audio.currentTime = start;
      } catch (err) {
        if (gen === this.gen) this.fail(err);
        return;
      }
      this.feed(gen, ctrl.signal, i, t, start);
    }

    fail(err) {
      if (this.onfail) this.onfail(err, this.appended);
    }

    idle() {
      const sb = this.sb;
      if (!sb || !sb.updating) return Promise.resolve();
      return new Promise((r) => sb.addEventListener("updateend", r, { once: true })).then(() => this.idle());
    }

    async fetchRange(track, from, to, signal) {
      const want = to - from + 1;
      for (let attempt = 0; ; attempt++) {
        const url = this.resolved.get(track.url) || track.url;
        try {
          const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` }, signal });
          if (res.status === 416) return new Uint8Array(0); // past the end
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (res.url) this.resolved.set(track.url, res.url);
          let b = new Uint8Array(await res.arrayBuffer());
          if (res.status === 200) b = b.subarray(from, from + want); // server ignored Range
          return b;
        } catch (err) {
          if (err.name === "AbortError" || attempt >= 3) throw err;
          this.resolved.delete(track.url); // the datanode may be gone; go back through archive.org
          await sleep(1000 * 2 ** attempt);
          if (signal.aborted) throw new DOMException("aborted", "AbortError");
        }
      }
    }

    // parsed header for a track, plus the bytes fetched to get it (only when freshly fetched)
    async header(track, signal) {
      if (this.info.has(track.url)) return { info: this.info.get(track.url), head: null };
      let head = await this.fetchRange(track, 0, FIRST_CHUNK - 1, signal);
      let info = parseHead(head, head.length >= FIRST_CHUNK);
      if (info.need != null) { // big ID3 tag: fetch from where the audio starts
        const more = await this.fetchRange(track, head.length, info.need + FIRST_CHUNK - 1, signal);
        head = concat(head, more);
        info = parseHead(head, false);
      }
      this.info.set(track.url, info);
      return { info, head };
    }

    // byte offset for time t in a track (Xing table of contents if there is one, otherwise proportional)
    byteFor(info, track, t) {
      const size = track.size || 0;
      const dur = info.frames ? (info.frames * info.spf) / info.sr : track.duration;
      if (!dur) return info.dataStart;
      const pct = Math.min(99.999, Math.max(0, (t / dur) * 100));
      if (info.toc && (info.tocBytes || size)) {
        const k = Math.floor(pct);
        const a = info.toc[k], b = k < 99 ? info.toc[k + 1] : 256;
        return Math.floor(info.tocBase + ((a + (b - a) * (pct - k)) / 256) * (info.tocBytes || size - info.tocBase));
      }
      return Math.floor(info.dataStart + (pct / 100) * Math.max(0, size - info.dataStart));
    }

    // wait until there's room: less than AHEAD seconds buffered. Drop what's well behind the playhead.
    async room(gen) {
      for (;;) {
        if (gen !== this.gen) return false;
        await this.idle();
        if (gen !== this.gen) return false;
        const ct = this.audio.currentTime;
        const r = this.sb.buffered;
        if (r.length && r.start(0) < ct - BEHIND - 5) {
          this.sb.remove(0, ct - BEHIND);
          continue;
        }
        if (this.bufferedEnd() - ct < AHEAD) return true;
        await sleep(500);
      }
    }

    async append(gen, bytes) {
      for (;;) {
        await this.idle();
        if (gen !== this.gen) return false;
        try {
          this.sb.appendBuffer(bytes);
        } catch (err) {
          if (err.name !== "QuotaExceededError") throw err;
          // full: wait for the playhead to move on so room() can drop some of what's behind it
          await sleep(1000);
          if (!(await this.room(gen))) return false;
          continue;
        }
        this.appended = true;
        await this.idle();
        return gen === this.gen;
      }
    }

    // Append tracks i, i+1, ... starting at time t of track i, at media time `start`.
    async feed(gen, signal, i, t, start) {
      const alive = () => gen === this.gen;
      try {
        let segStart = start;
        for (; i < this.tracks.length; i++, t = 0) {
          const track = this.tracks[i];
          const { info, head } = await this.header(track, signal);
          if (!alive()) return;

          const fromTop = !(t > 0);
          let offset = fromTop ? info.dataStart : this.byteFor(info, track, t);
          const front = fromTop ? info.front : 0;
          const seg = { i, start: segStart, t0: fromTop ? 0 : t, end: null };

          await this.idle();
          if (!alive()) return;
          this.segs.push(seg);
          this.pending = null;
          this.sb.appendWindowEnd = Infinity;
          this.sb.appendWindowStart = segStart;
          this.sb.timestampOffset = segStart - front / info.sr;

          const size = track.size || Infinity;
          let carry = null, synced = fromTop, frames = 0, eof = false, useHead = !!head;
          while (!eof) {
            if (!(await this.room(gen))) return;
            let bytes, asked;
            if (useHead && offset < head.length) {
              bytes = head.subarray(offset);
              asked = bytes.length + (head.length < FIRST_CHUNK ? 1 : 0); // a short head means a short file
            } else {
              asked = carry || offset !== info.dataStart ? CHUNK : FIRST_CHUNK;
              bytes = await this.fetchRange(track, offset, offset + asked - 1, signal);
              if (!alive()) return;
            }
            useHead = false;
            offset += bytes.length;
            eof = bytes.length < asked || offset >= size;

            let data = concat(carry, bytes);
            if (!synced) { // started mid-file: line up on a frame
              const p = findSync(data, 0, info.key);
              if (p < 0) {
                if (eof) break;
                carry = data.subarray(Math.max(0, data.length - 4096));
                continue;
              }
              data = data.subarray(p);
              synced = true;
            }
            const { spans, restAt } = walkFrames(data, info.key, eof);
            carry = eof ? null : data.subarray(restAt);
            if (carry && carry.length > 4 * CHUNK) throw new Error("lost track of the MP3 frames");
            frames += spans.length;
            if (eof) {
              // end of the song: trim the encoder padding, so the next one butts right up against it
              const end = segStart + (frames * info.spf - front - info.back) / info.sr;
              await this.idle();
              if (!alive()) return;
              if (end > segStart + 0.01) {
                this.sb.appendWindowEnd = end;
                seg.end = end;
              }
            }
            const out = joinSpans(data, spans);
            if (out && !(await this.append(gen, out))) return;
          }
          if (seg.end == null) seg.end = Math.max(segStart, this.bufferedEnd());
          segStart = seg.end;
        }
        // the whole show is in: let the element reach a real end
        await this.idle();
        if (alive() && this.ms.readyState === "open") this.ms.endOfStream();
      } catch (err) {
        if (err.name === "AbortError" || !alive()) return;
        this.fail(err);
      }
    }
  }

  window.GaplessStream = GaplessStream;
})();
