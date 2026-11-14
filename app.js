/* =========================================================
   The Tape Vault — Grateful Dead & Jerry Garcia live shows from archive.org
   No build step, no dependencies. Open index.html or serve the folder.
   ========================================================= */
(() => {
  "use strict";

  const ARTISTS = {
    gd: {
      key: "gd",
      name: "Grateful Dead",
      short: "GD",
      query: "collection:GratefulDead",
      first: 1965,
      last: 1995,
      tagline: "Grateful Dead live recordings, 1965–1995",
    },
    jg: {
      key: "jg",
      name: "Jerry Garcia",
      short: "JG",
      // Garcia's side projects live in the Taper's Section collection, credited to "Jerry Garcia"
      query: 'creator:"Jerry Garcia" AND collection:taperssection',
      first: 1970,
      last: 1995,
      tagline: "Jerry Garcia Band, Legion of Mary, Reconstruction & friends, 1970–1995",
    },
  };
  const DEFAULT_ARTIST = "gd";

  // Garcia projects, recognised from the archive.org identifier. First match wins.
  const PROJECTS = [
    [/jgb|garcia[-_ ]?band/, "JGB", "Jerry Garcia Band"],
    [/legion|[._-]lom[._-]/, "LoM", "Legion of Mary"],
    [/recon/, "Recon", "Reconstruction"],
    [/jgms|saunders|merl/, "G/S", "Garcia & Saunders"],
    [/jgjk|kahn/, "G/K", "Garcia & Kahn"],
    [/oaitw|old.?(and|&).?in/, "OAITW", "Old & In the Way"],
    [/grisman|jgdg|[._-]dg[._-]/, "G/G", "Garcia & Grisman"],
    [/jgab|acoustic/, "JGAB", "Jerry Garcia Acoustic Band"],
    [/interview/, "Intv", "Interview"],
  ];
  const DEFAULT_PROJECT = ["JG", "Jerry Garcia"];

  const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
  const SPINE_COLORS = ["#e4572e", "#f2b134", "#2e86ab", "#3a9e5c", "#8e44ad", "#c0392b", "#d35400", "#16a085", "#2c3e50", "#b03a7a"];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  // deterministic pseudo-random from a string, so tilts/colours don't jump around on re-render
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967295;
  }

  // drop caches written by older versions of the app (before artists were added)
  try {
    Object.keys(localStorage).filter((k) => k.startsWith("gdvault:year:")).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }

  // ---------------------------------------------------------
  // archive.org API
  // ---------------------------------------------------------
  const cacheKey = (artist, year) => `gdvault:${artist}:year:${year}`;

  const api = {
    _inflight: new Map(),
    searchYear(artist, year) {
      // share one request between the wall's counter and an opened box
      const k = cacheKey(artist, year);
      if (!this._inflight.has(k)) {
        const p = this._searchYear(artist, year).finally(() => this._inflight.delete(k));
        this._inflight.set(k, p);
      }
      return this._inflight.get(k);
    },

    async _searchYear(artist, year) {
      const key = cacheKey(artist, year);
      try {
        const cached = JSON.parse(localStorage.getItem(key) || "null");
        // re-sort: caches written by older versions were ordered by plays, not rating
        if (cached && Date.now() - cached.t < CACHE_TTL_MS) return sortRecordings(cached.shows);
      } catch { /* ignore bad cache */ }

      const params = new URLSearchParams({
        q: `${ARTISTS[artist].query} AND year:${year}`,
        rows: "5000",
        output: "json",
      });
      ["identifier", "date", "title", "venue", "coverage", "downloads", "avg_rating"]
        .forEach((f) => params.append("fl[]", f));
      params.append("sort[]", "date asc");

      const res = await fetch(`https://archive.org/advancedsearch.php?${params}`);
      if (!res.ok) throw new Error(`archive.org search failed (${res.status})`);
      const json = await res.json();
      const shows = groupByShow(json.response.docs || [], artist);
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), shows })); } catch { /* quota */ }
      return shows;
    },

    _meta: new Map(),
    async tracks(identifier) {
      if (this._meta.has(identifier)) return this._meta.get(identifier);
      const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      if (!res.ok) throw new Error(`archive.org metadata failed (${res.status})`);
      const data = await res.json();
      const tracks = pickTracks(identifier, data.files || []);
      this._meta.set(identifier, tracks);
      return tracks;
    },
  };

  function sourceType(id) {
    const s = id.toLowerCase();
    if (/matrix|mtx/.test(s)) return "MTX";
    if (/sbd|soundboard/.test(s)) return "SBD";
    if (/(^|[._-])(aud|fob)|audience|nak|senn|schoeps|akg|neumann/.test(s)) return "AUD";
    if (/[._-]fm[._-]/.test(s)) return "FM";
    return "TAPE";
  }

  function projectOf(id) {
    const s = id.toLowerCase();
    const hit = PROJECTS.find(([re]) => re.test(s)) || [null, ...DEFAULT_PROJECT];
    return { tag: hit[1], name: hit[2] };
  }

  // "Jerry Garcia live at Keystone, Berkeley, CA on 1975-11-17" -> { venue: "Keystone", location: "Berkeley, CA" }
  function venueFromTitle(title) {
    const m = /live at (.+?) on \d{4}-[\dx]{2}-[\dx]{2}\s*$/i.exec(String(title || ""));
    if (!m || /^unknown/i.test(m[1])) return { venue: "", location: "" };
    const parts = m[1].split(",").map((p) => p.trim());
    return { venue: parts[0], location: parts.slice(1).join(", ") };
  }

  // Many recordings exist for each concert. Collapse them into one "show" per date,
  // keeping every recording so each can be shown as its own tape.
  function groupByShow(docs, artist) {
    const map = new Map();
    for (const d of docs) {
      if (!d.date || !d.identifier) continue;
      const date = String(d.date).slice(0, 10);
      if (!map.has(date)) map.set(date, { date, venue: "", location: "", recordings: [] });
      const show = map.get(date);
      const rec = {
        id: d.identifier,
        type: sourceType(d.identifier),
        downloads: d.downloads || 0,
        rating: d.avg_rating || 0,
      };
      if (artist === "jg") rec.project = projectOf(d.identifier);
      show.recordings.push(rec);

      const fromTitle = venueFromTitle(d.title);
      if (!show.venue) show.venue = String(d.venue || fromTitle.venue || "").trim();
      if (!show.location) show.location = String(d.coverage || fromTitle.location || "").trim();
    }
    const shows = [...map.values()];
    sortRecordings(shows);
    shows.sort((a, b) => a.date.localeCompare(b.date));
    return shows;
  }

  // highest-rated recording first; plays break ties (and order the unrated ones)
  function sortRecordings(shows) {
    for (const s of shows) {
      s.recordings.sort((a, b) => (b.rating || 0) - (a.rating || 0) || b.downloads - a.downloads);
    }
    return shows;
  }

  function parseLength(len) {
    if (len == null) return 0;
    const s = String(len);
    if (s.includes(":")) return s.split(":").reduce((acc, p) => acc * 60 + (parseFloat(p) || 0), 0);
    return parseFloat(s) || 0;
  }

  function pickTracks(identifier, files) {
    const prefs = ["VBR MP3", "MP3", "128Kbps MP3", "64Kbps MP3", "Ogg Vorbis"];
    let chosen = [];
    for (const fmt of prefs) {
      chosen = files.filter((f) => f.format === fmt);
      if (chosen.length) break;
    }
    const natural = new Intl.Collator(undefined, { numeric: true });
    chosen.sort((a, b) => {
      const ta = parseInt(a.track, 10), tb = parseInt(b.track, 10);
      if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb;
      return natural.compare(a.name, b.name);
    });
    return chosen.map((f) => ({
      title: (f.title || f.name.replace(/\.[^.]+$/, "")).trim(),
      duration: parseLength(f.length),
      url: `https://archive.org/download/${encodeURIComponent(identifier)}/${f.name.split("/").map(encodeURIComponent).join("/")}`,
    }));
  }

  function fmtDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return `${m}/${d}/${String(y).slice(2)}`;
  }
  function fmtLongDate(iso) {
    const dt = new Date(iso + "T12:00:00");
    return dt.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "long", day: "numeric" });
  }
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------------------------------------------------------
  // little mechanical "clunk" for the piano keys (WebAudio, no assets)
  // ---------------------------------------------------------
  let actx;
  function clunk() {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const len = 0.05, buf = actx.createBuffer(1, actx.sampleRate * len, actx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 6);
      const src = actx.createBufferSource(); src.buffer = buf;
      const filt = actx.createBiquadFilter(); filt.type = "lowpass"; filt.frequency.value = 1800;
      const g = actx.createGain(); g.gain.value = 0.35;
      src.connect(filt).connect(g).connect(actx.destination);
      src.start();
    } catch { /* audio not available */ }
  }

  // ---------------------------------------------------------
  // WALL
  // ---------------------------------------------------------
  let wallArtist = null;

  function cachedCount(artist, year) {
    try {
      const c = JSON.parse(localStorage.getItem(cacheKey(artist, year)) || "null");
      return c && Date.now() - c.t < CACHE_TTL_MS ? c.shows.length : null;
    } catch { return null; }
  }

  function yearsOf(artist) {
    const years = [];
    for (let y = ARTISTS[artist].first; y <= ARTISTS[artist].last; y++) years.push(y);
    return years;
  }

  function renderWall(artist) {
    wallArtist = artist;
    const a = ARTISTS[artist];
    $("#wallTagline").textContent = `${a.tagline} · pulled live from the Internet Archive`;
    document.querySelectorAll(".artist-switch a").forEach((link) =>
      link.classList.toggle("active", link.dataset.artist === artist));
    document.body.dataset.artist = artist;

    const shelves = $("#shelves");
    shelves.innerHTML = "";
    const years = yearsOf(artist);
    const perShelf = shelfSize();
    for (let i = 0; i < years.length; i += perShelf) {
      const shelf = el("div", "shelf");
      for (const y of years.slice(i, i + perShelf)) {
        const r = hash(artist + "box" + y);
        const b = el("button", "box");
        b.style.setProperty("--tilt", `${(r - 0.5) * 5}deg`);
        b.setAttribute("aria-label", `Open the ${a.name} ${y} box`);
        b.append(el("div", "lid"), el("div", "side"));
        const front = el("div", "front");
        front.append(el("div", "tape-strip"), el("div", "handle"), el("div", "year", String(y)));
        const n = cachedCount(artist, y);
        const count = el("div", "count", n == null ? "counting…" : countLabel(n));
        count.id = `count-${artist}-${y}`;
        front.append(count);
        b.append(front);
        b.addEventListener("click", () => { location.hash = `#/${artist}/${y}`; });
        shelf.append(b);
      }
      shelves.append(shelf);
    }
    fillCounts(artist);
  }

  // how many boxes fit on one shelf at the current screen width
  function shelfSize() {
    const w = window.innerWidth;
    return w < 480 ? 3 : w < 700 ? 4 : w < 1000 ? 6 : 8;
  }
  let lastShelfSize = shelfSize();
  window.addEventListener("resize", () => {
    const n = shelfSize();
    if (n !== lastShelfSize) {
      lastShelfSize = n;
      if (!$("#wall").classList.contains("hidden") && wallArtist) renderWall(wallArtist);
    }
  });

  function countLabel(n) {
    return n === 0 ? "empty" : `${n} show${n === 1 ? "" : "s"}`;
  }

  // Look up every year in the background, 4 at a time, and label each box as it comes in.
  // Results land in the same cache the boxes use, so opening a box afterwards is instant.
  const countsRunning = new Set();
  async function fillCounts(artist) {
    if (countsRunning.has(artist)) return;
    countsRunning.add(artist);
    const queue = yearsOf(artist).filter((y) => cachedCount(artist, y) == null);
    const worker = async () => {
      while (queue.length) {
        const y = queue.shift();
        let label;
        try { label = countLabel((await api.searchYear(artist, y)).length); }
        catch { label = "?"; }
        const node = document.getElementById(`count-${artist}-${y}`);
        if (node) node.textContent = label;
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    countsRunning.delete(artist);
  }

  // ---------------------------------------------------------
  // BOX (top-down view)
  // ---------------------------------------------------------
  const boxState = { artist: null, year: null, shows: [], loading: null };

  async function openBox(artist, year) {
    if (boxState.artist === artist && boxState.year === year && boxState.shows.length) return;
    const a = ARTISTS[artist];
    boxState.artist = artist;
    boxState.year = year;
    boxState.shows = [];
    document.body.dataset.artist = artist;
    $("#boxTitle").textContent = `${a.name} · ${year}`;
    $("#boxFilter").value = "";
    $("#tapes").innerHTML = "";
    setBoxStatus("Digging through the box…");

    const thisLoad = (boxState.loading = api.searchYear(artist, year));
    try {
      const shows = await thisLoad;
      if (boxState.loading !== thisLoad) return; // user moved on
      boxState.shows = shows;
      const recs = shows.reduce((n, s) => n + s.recordings.length, 0);
      $("#boxTitle").textContent =
        `${a.name} · ${year} — ${shows.length} show${shows.length === 1 ? "" : "s"}, ${recs} tape${recs === 1 ? "" : "s"}`;
      if (!shows.length) setBoxStatus("This box is empty. No recordings from this year in the archive.");
      else setBoxStatus("");
      renderTapes();
    } catch (err) {
      if (boxState.loading !== thisLoad) return;
      boxState.year = null;
      setBoxStatus(`Couldn't reach archive.org: ${err.message}`, true);
    }
  }

  function setBoxStatus(msg, withRetry) {
    const s = $("#boxStatus");
    s.textContent = msg;
    if (withRetry) {
      s.append(document.createElement("br"));
      const btn = el("button", "chip", "Try again");
      btn.addEventListener("click", route);
      s.append(btn);
    }
  }

  // "gd1972-12-31.sbd.miller.12345.flac16" -> "sbd.miller.12345.flac16"
  // "jg75-11-17.094376.jgb.fob.rhino.flac16" -> "094376.jgb.fob.rhino.flac16"
  function recLabel(id, date) {
    const [y, m, d] = date.split("-");
    const prefix = new RegExp(`^[a-z]+(${y}|${y.slice(2)})[-.]?(${m}|xx)[-.]?(${d}|xx)[._-]?`, "i");
    return id.replace(prefix, "") || id;
  }

  function renderTapes() {
    const q = $("#boxFilter").value.trim().toLowerCase();
    const wrap = $("#tapes");
    wrap.innerHTML = "";
    const year = boxState.year, artist = boxState.artist;
    let shown = 0, i = 0;

    // one cassette per show, showing its highest-rated recording; the others are in the player's dropdown
    for (const show of boxState.shows) {
      const color = SPINE_COLORS[Math.floor(hash(show.date) * 1000) % SPINE_COLORS.length];
      const venue = [show.venue, show.location].filter(Boolean).join(" · ") || "Unknown venue";
      const showText = `${show.date} ${fmtDate(show.date)} ${show.venue} ${show.location}`.toLowerCase();
      const recText = (r) => `${r.project ? ` ${r.project.tag} ${r.project.name}` : ""} ${r.id}`.toLowerCase();

      // if the filter matches a particular recording (e.g. "sbd"), the tape shows the best matching one
      const rec = q
        ? (showText.includes(q) ? show.recordings[0] : show.recordings.find((r) => (showText + recText(r)).includes(q)))
        : show.recordings[0];
      if (!rec) continue;
      const n = show.recordings.length;
      shown++;
      const r = hash(rec.id);
      const b = el("button", "tape-case");
      b.style.setProperty("--c", color);
      b.style.setProperty("--tilt", `${(r - 0.5) * 2.4}deg`);
      b.style.setProperty("--delay", `${Math.min(i++ * 10, 600)}ms`);
      const spine = el("div", "spine");
      spine.append(
        el("div", "t-date", fmtDate(show.date)),
        el("div", "t-venue", venue),
        el("div", "t-lineage", recLabel(rec.id, show.date)),
      );
      const badges = el("span", "t-badges");
      if (rec.project) {
        const p = el("span", "t-proj", rec.project.tag);
        p.title = rec.project.name;
        badges.append(p);
      }
      badges.append(el("span", "t-src", rec.type));
      b.append(spine, badges);
      if (n > 1) b.append(el("span", "t-of", `${n} versions`));
      b.title = [fmtLongDate(show.date), rec.project && rec.project.name, show.venue, show.location, rec.id,
        rec.rating ? `★ ${rec.rating.toFixed(1)}` : "", `${rec.downloads.toLocaleString()} plays`,
        n > 1 ? `${n} versions — pick another in the player` : ""].filter(Boolean).join("\n");
      b.addEventListener("click", () => {
        location.hash = `#/${artist}/${year}/${show.date}/${encodeURIComponent(rec.id)}`;
      });
      wrap.append(b);
    }
    if (q && !shown) setBoxStatus(`No tapes matching “${q}”.`);
    else if (boxState.shows.length) setBoxStatus("");
  }

  // ---------------------------------------------------------
  // PLAYER
  // ---------------------------------------------------------
  const audio = $("#audio");
  const player = {
    artist: null,
    show: null,
    rec: null,
    tracks: [],
    offsets: [],
    total: 0,
    index: 0,
    loadToken: 0,
  };

  async function openPlayer(artist, show, recId) {
    $("#player").classList.remove("hidden");
    const rec = show.recordings.find((r) => r.id === recId) || show.recordings[0];
    if (player.rec && player.rec.id === rec.id) return; // already loaded

    const sameShow = player.show === show;
    player.artist = artist;
    player.show = show;
    player.rec = rec;
    player.tracks = [];
    player.index = 0;
    stopAudio(true);

    // label + J-card
    const where = [show.venue, show.location].filter(Boolean);
    $("#cassette").classList.add("empty");
    $("#brandArtist").textContent = ARTISTS[artist].short;
    $("#brandYear").textContent = show.date.slice(0, 4);
    $("#cassDate").textContent = fmtDate(show.date);
    $("#cassBrand").textContent = rec.project ? rec.project.tag : "C-90";
    $("#cassVenue").textContent = where.join(", ");
    $("#jDate").textContent = fmtLongDate(show.date);
    $("#jVenue").textContent = (rec.project ? `${rec.project.name} — ` : "") + (where.join(" — ") || "Unknown venue");
    $("#archiveLink").href = `https://archive.org/details/${rec.id}`;
    if (!sameShow) fillSourceSelect(show);
    $("#sourceSelect").value = rec.id;
    $("#trackList").innerHTML = "";
    $("#trackList").append(el("li", "muted", "Threading the tape…"));
    lcd("TRK --/--", "00:00", "LOADING…");
    setReels(0);

    const token = ++player.loadToken;
    try {
      const tracks = await api.tracks(rec.id);
      if (token !== player.loadToken) return;
      if (!tracks.length) throw new Error("no streamable audio in this recording");
      player.tracks = tracks;
      player.offsets = [];
      let acc = 0;
      for (const t of tracks) { player.offsets.push(acc); acc += t.duration; }
      player.total = acc;
      renderTrackList();
      $("#cassette").classList.remove("empty");
      loadTrack(0, false);
      lcd(undefined, undefined, "PRESS PLAY ▶");
    } catch (err) {
      if (token !== player.loadToken) return;
      $("#trackList").innerHTML = "";
      $("#trackList").append(el("li", "muted", `Tape jammed: ${err.message}. Try another source.`));
      lcd("TRK --/--", "00:00", "TAPE JAMMED");
    }
  }

  function closePlayer() {
    stopAudio(true);
    player.show = null;
    player.rec = null;
    player.loadToken++;
    $("#player").classList.add("hidden");
    if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
  }

  function fillSourceSelect(show) {
    const sel = $("#sourceSelect");
    sel.innerHTML = "";
    show.recordings.forEach((r, i) => {
      const proj = r.project ? `${r.project.tag} · ` : "";
      const rating = r.rating ? `★ ${r.rating.toFixed(1)} · ` : "";
      const o = el("option", null, `${proj}${r.type}${i === 0 ? " (top rated)" : ""} — ${r.id} (${rating}${r.downloads.toLocaleString()} plays)`);
      o.value = r.id;
      o.title = o.textContent;
      sel.append(o);
    });
  }

  function renderTrackList() {
    const ol = $("#trackList");
    ol.innerHTML = "";
    player.tracks.forEach((t, i) => {
      const li = el("li");
      li.append(el("span", "tl-title", t.title), el("span", "tl-len", t.duration ? fmtTime(t.duration) : ""));
      li.addEventListener("click", () => { clunk(); loadTrack(i, true); });
      ol.append(li);
    });
  }

  function loadTrack(i, autoplay) {
    if (!player.tracks.length) return;
    i = Math.max(0, Math.min(i, player.tracks.length - 1));
    player.index = i;
    const t = player.tracks[i];
    audio.src = t.url;
    audio.load();
    document.querySelectorAll("#trackList li").forEach((li, n) => li.classList.toggle("current", n === i));
    const cur = document.querySelectorAll("#trackList li")[i];
    if (cur) cur.scrollIntoView({ block: "nearest" });
    lcd(`TRK ${String(i + 1).padStart(2, "0")}/${String(player.tracks.length).padStart(2, "0")}`, "00:00", t.title.toUpperCase());
    updateMediaSession();
    if (autoplay) play();
    else updateTransport();
  }

  function play() {
    if (!player.tracks.length) return;
    audio.play().catch((e) => { if (e.name !== "AbortError") lcd(undefined, undefined, "TAPE JAMMED"); });
  }
  function pause() { audio.pause(); }
  function stopAudio(silent) {
    audio.pause();
    if (!silent && player.tracks.length) { audio.currentTime = 0; }
    if (silent) { audio.removeAttribute("src"); audio.load(); }
    updateTransport();
  }
  function next() {
    if (player.index < player.tracks.length - 1) loadTrack(player.index + 1, !audio.paused || audio.ended);
  }
  function prev() {
    // standard deck behaviour: if we're a few seconds in, rewind to the top of the song first
    if (audio.currentTime > 4) { audio.currentTime = 0; return; }
    loadTrack(player.index - 1, !audio.paused);
  }

  function eject() {
    closePlayer();
    const [, artist, year] = location.hash.split("/");
    location.hash = year ? `#/${artist}/${year}` : `#/${artist || DEFAULT_ARTIST}`;
  }

  function lcd(track, time, title) {
    if (track !== undefined) $("#lcdTrack").textContent = track;
    if (time !== undefined) $("#lcdTime").textContent = time;
    if (title !== undefined) $("#lcdTitle").textContent = title;
  }

  function setReels(progress) {
    // left reel empties, right reel fills — area-proportional, like real tape.
    // Sizes are fractions of the reel (which scales with the cassette); the empty pack
    // stays just wider than the hub (54% of the reel, see .reel in styles.css).
    const max = 0.97, min = 0.6;
    const r = (p) => Math.sqrt(min * min + (max * max - min * min) * p);
    $("#tapeLeft").style.setProperty("--size", r(1 - progress).toFixed(4));
    $("#tapeRight").style.setProperty("--size", r(progress).toFixed(4));
  }

  function updateTransport() {
    const playing = !audio.paused && !audio.ended;
    $("#cassette").parentElement.classList.toggle("playing", playing);
    $("#kPlay").classList.toggle("down", playing);
    $("#kPause").classList.toggle("down", !playing && audio.currentTime > 0);
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }

  let seeking = false;
  audio.addEventListener("timeupdate", () => {
    const t = player.tracks[player.index];
    if (!t) return;
    const dur = isFinite(audio.duration) ? audio.duration : t.duration;
    lcd(undefined, fmtTime(audio.currentTime));
    if (!seeking && dur) $("#seek").value = Math.round((audio.currentTime / dur) * 1000);
    if (player.total) setReels(Math.min(1, (player.offsets[player.index] + audio.currentTime) / player.total));
  });
  audio.addEventListener("play", updateTransport);
  audio.addEventListener("pause", updateTransport);
  audio.addEventListener("ended", () => {
    if (player.index < player.tracks.length - 1) loadTrack(player.index + 1, true);
    else { updateTransport(); lcd(undefined, undefined, "END OF TAPE — FLIP IT OVER, MAN"); }
  });
  audio.addEventListener("error", () => {
    if (audio.getAttribute("src")) lcd(undefined, undefined, "TAPE JAMMED — TRY ANOTHER SOURCE");
  });

  // controls
  const bindKey = (id, fn) => $(id).addEventListener("click", () => { clunk(); fn(); });
  bindKey("#kPlay", play);
  bindKey("#kPause", () => (audio.paused ? play() : pause())); // pause key toggles, like a real deck
  bindKey("#kStop", () => stopAudio(false));
  bindKey("#kNext", next);
  bindKey("#kPrev", prev);
  bindKey("#kEject", eject);

  const seek = $("#seek");
  seek.addEventListener("input", () => { seeking = true; });
  seek.addEventListener("change", () => {
    const t = player.tracks[player.index];
    const dur = isFinite(audio.duration) ? audio.duration : t && t.duration;
    if (dur) audio.currentTime = (seek.value / 1000) * dur;
    seeking = false;
  });
  const vol = $("#volume");
  audio.volume = vol.value / 100;
  vol.addEventListener("input", () => { audio.volume = vol.value / 100; });

  $("#sourceSelect").addEventListener("change", (e) => {
    const [, artist, year, date] = location.hash.split("/");
    location.hash = `#/${artist}/${year}/${date}/${encodeURIComponent(e.target.value)}`;
  });

  $("#player").addEventListener("click", (e) => { if (e.target.id === "player") eject(); });

  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !player.show) return;
    const t = player.tracks[player.index];
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t ? t.title : "",
      artist: player.rec && player.rec.project ? player.rec.project.name : ARTISTS[player.artist].name,
      album: `${player.show.date} — ${player.show.venue}`,
    });
  }
  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler("play", play);
    ms.setActionHandler("pause", pause);
    ms.setActionHandler("nexttrack", next);
    ms.setActionHandler("previoustrack", prev);
    ms.setActionHandler("stop", () => stopAudio(false));
  }

  // keyboard
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    const playerOpen = !$("#player").classList.contains("hidden");
    if (playerOpen) {
      if (e.key === " ") { e.preventDefault(); audio.paused ? play() : pause(); }
      else if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
      else if (e.key === "Escape") eject();
    } else if (e.key === "Escape" && !$("#boxview").classList.contains("hidden")) {
      location.hash = `#/${boxState.artist || DEFAULT_ARTIST}`;
    }
  });

  // ---------------------------------------------------------
  // ANALYTICS — tell Google Tag Manager about each view, as a readable path like /gd/1977.
  // GTM listens for the "virtual_page_view" event (see README). Nothing happens if GTM isn't loaded.
  // ---------------------------------------------------------
  let lastTrackedPath = null;
  function trackView(path, title, extra) {
    if (path === lastTrackedPath) return; // e.g. switching versions of the same show
    lastTrackedPath = path;
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({
      event: "virtual_page_view",
      page_path: path,
      page_location: location.origin + path,
      page_title: title,
      ...extra,
    });
  }

  // ---------------------------------------------------------
  // ROUTER   #/gd                            wall (gd = Grateful Dead, jg = Jerry Garcia)
  //          #/gd/1977                       box
  //          #/gd/1977/1977-05-08[/identifier]   player
  // ---------------------------------------------------------
  async function route() {
    let parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);

    // links from before artists were added: #/1977/... -> #/gd/1977/...
    if (parts.length && /^\d{4}$/.test(parts[0])) {
      location.replace(`#/${DEFAULT_ARTIST}/${parts.join("/")}`);
      return;
    }
    if (!ARTISTS[parts[0]]) {
      let saved = null;
      try { saved = localStorage.getItem("gdvault:artist"); } catch { /* ignore */ }
      location.replace(`#/${ARTISTS[saved] ? saved : DEFAULT_ARTIST}`);
      return;
    }

    const [artist, yearStr, date, recId] = parts;
    const a = ARTISTS[artist];
    try { localStorage.setItem("gdvault:artist", artist); } catch { /* ignore */ }
    const year = parseInt(yearStr, 10);

    if (!year || year < a.first || year > a.last) {
      if (player.show) closePlayer();
      $("#boxview").classList.add("hidden");
      $("#wall").classList.remove("hidden");
      renderWall(artist);
      trackView(`/${artist}`, `${a.name} — all years`, { artist: a.name });
      return;
    }

    $("#wall").classList.add("hidden");
    $("#boxview").classList.remove("hidden");
    await openBox(artist, year);

    const show = date && boxState.shows.find((s) => s.date === date);
    if (show) {
      openPlayer(artist, show, recId && decodeURIComponent(recId));
      trackView(`/${artist}/${year}/${date}`, `${a.name} · ${date}${show.venue ? ` · ${show.venue}` : ""}`,
        { artist: a.name, year: String(year), show_date: date });
    } else {
      if (!date && !$("#player").classList.contains("hidden")) closePlayer();
      trackView(`/${artist}/${year}`, `${a.name} · ${year}`, { artist: a.name, year: String(year) });
    }
  }

  $("#backToWall").addEventListener("click", () => { location.hash = `#/${boxState.artist || DEFAULT_ARTIST}`; });
  $("#boxFilter").addEventListener("input", renderTapes);
  window.addEventListener("hashchange", route);
  route();
})();
