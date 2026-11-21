/* =========================================================
   Jerry Tapes (jerrytapes.net) — Grateful Dead & Jerry Garcia live shows from archive.org
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
    // both of the above on one wall; built from their results, so it has no query of its own
    all: {
      key: "all",
      name: "Grateful Dead & Jerry Garcia",
      short: "GD+JG",
      sources: ["gd", "jg"],
      first: 1965,
      last: 1995,
      tagline: "The Grateful Dead and Garcia's side projects together, 1965–1995",
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
      // combined artist: merge each source's year (each uses its own cache), tagging shows with their band
      const sources = ARTISTS[artist].sources;
      if (sources) {
        const parts = await Promise.all(sources
          .filter((s) => year >= ARTISTS[s].first && year <= ARTISTS[s].last)
          .map(async (s) => (await this.searchYear(s, year)).map((show) => ({ ...show, artist: s }))));
        // stable sort keeps source order (GD before JG) for a shared date
        return parts.flat().sort((a, b) => a.date.localeCompare(b.date));
      }

      const key = cacheKey(artist, year);
      try {
        const cached = JSON.parse(localStorage.getItem(key) || "null");
        // re-sort: caches written by older versions may be in a different order
        if (cached && Date.now() - cached.t < CACHE_TTL_MS) return sortRecordings(cached.shows);
      } catch { /* ignore bad cache */ }

      const docs = await this._search(`${ARTISTS[artist].query} AND year:${year}`, 5000);
      const shows = groupByShow(docs, artist);
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), shows })); } catch { /* quota */ }
      return shows;
    },

    async _search(q, rows, extraFields = []) {
      const params = new URLSearchParams({ q, rows: String(rows), output: "json" });
      ["identifier", "date", "title", "venue", "coverage", "downloads", "avg_rating", ...extraFields]
        .forEach((f) => params.append("fl[]", f));
      params.append("sort[]", "date asc");
      const res = await fetch(`https://archive.org/advancedsearch.php?${params}`);
      if (!res.ok) throw new Error(`archive.org search failed (${res.status})`);
      const json = await res.json();
      return json.response.docs || [];
    },

    // Every show, from both bands, whose setlist (the recording's description) names the song.
    // Kept in memory only: a popular song's results are too big for localStorage.
    _songs: new Map(),
    searchSong(song) {
      const k = song.toLowerCase();
      if (!this._songs.has(k)) {
        const p = this._searchSong(song);
        p.catch(() => this._songs.delete(k)); // let a failed search be retried
        this._songs.set(k, p);
      }
      return this._songs.get(k);
    },

    async _searchSong(song) {
      const phrase = songPhrase(song);
      const parts = await Promise.all(["gd", "jg"].map(async (artist) => {
        const docs = await this._search(`${ARTISTS[artist].query} AND description:"${phrase}"`, 10000, ["description"]);
        return groupByShow(docs.filter((d) => inSetlist(d.description, phrase)), artist)
          .map((show) => ({ ...show, artist }));
      }));
      return parts.flat().sort((a, b) => a.date.localeCompare(b.date));
    },

    // one request gives us the songs, the taper's notes and listener reviews for a recording
    _meta: new Map(),
    async recording(identifier) {
      if (this._meta.has(identifier)) return this._meta.get(identifier);
      const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
      if (!res.ok) throw new Error(`archive.org metadata failed (${res.status})`);
      const data = await res.json();
      const md = data.metadata || {};
      const out = {
        tracks: pickTracks(identifier, data.files || []),
        info: {
          description: htmlToText(md.description),
          notes: htmlToText(md.notes),
          source: htmlToText(md.source),
          lineage: htmlToText(md.lineage),
          taper: htmlToText(md.taper),
          transferer: htmlToText(md.transferer),
        },
        reviews: Array.isArray(data.reviews) ? data.reviews : [],
      };
      this._meta.set(identifier, out);
      return out;
    },

    // Wikipedia paragraphs that mention this exact date alongside the band.
    // Only famous shows have their own articles, but tour/album/venue pages often cover a date.
    _hist: new Map(),
    async history(artistName, iso) {
      const key = `${artistName}|${iso}`;
      if (this._hist.has(key)) return this._hist.get(key);
      const cacheKey = `wiki:${key}`;
      try {
        const c = JSON.parse(localStorage.getItem(cacheKey) || "null");
        if (c && Date.now() - c.t < 7 * CACHE_TTL_MS) { this._hist.set(key, c.v); return c.v; }
      } catch { /* ignore */ }

      const [y, m, d] = iso.split("-").map(Number);
      if (!y || !m || !d) return [];
      const month = new Date(2000, m - 1, 1).toLocaleString("en-US", { month: "long" });
      const forms = [`${month} ${d}, ${y}`, `${d} ${month} ${y}`];
      const wiki = (p) => fetch(`https://en.wikipedia.org/w/api.php?${new URLSearchParams({ format: "json", origin: "*", ...p })}`)
        .then((r) => { if (!r.ok) throw new Error(`wikipedia ${r.status}`); return r.json(); });

      const found = await wiki({
        action: "query", list: "search", srlimit: "4", srprop: "",
        srsearch: `"${artistName}" ("${forms[0]}" OR "${forms[1]}")`,
      });
      const titles = ((found.query && found.query.search) || []).map((h) => h.title).slice(0, 4);
      const pages = await Promise.all(titles.map(async (title) => {
        const j = await wiki({ action: "query", prop: "extracts", explaintext: "1", redirects: "1", titles: title });
        const pg = Object.values((j.query && j.query.pages) || {})[0];
        const paras = String((pg && pg.extract) || "").split(/\n+/)
          .filter((p) => !/^=+.*=+$/.test(p.trim()) && forms.some((f) => p.includes(f)))
          .slice(0, 3)
          .map((p) => (p.length > 700 ? p.slice(0, 700).replace(/\s+\S*$/, "") + "…" : p));
        return { title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, paras };
      }));
      const v = pages.filter((p) => p.paras.length);
      this._hist.set(key, v);
      try { localStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), v })); } catch { /* quota */ }
      return v;
    },
  };

  // archive.org text fields are user-written HTML (or arrays of it). Parse it inertly and keep only the text.
  function htmlToText(v) {
    if (v == null) return "";
    const s = (Array.isArray(v) ? v.join("\n") : String(v))
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n");
    const text = new DOMParser().parseFromString(s, "text/html").body.textContent || "";
    return text.replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // Who was in the band on a given date. [name, instruments, from, to] (inclusive, ISO dates)
  const GD_LINEUP = [
    ["Jerry Garcia", "lead guitar, vocals"],
    ["Bob Weir", "rhythm guitar, vocals"],
    ["Phil Lesh", "bass, vocals"],
    ["Bill Kreutzmann", "drums"],
    ["Mickey Hart", "drums, percussion", "1967-09-29", "1971-02-18"],
    ["Mickey Hart", "drums, percussion", "1974-10-20"],
    ["Ron “Pigpen” McKernan", "organ, harmonica, vocals", "", "1971-08-26"],
    ["Ron “Pigpen” McKernan", "organ, harmonica, vocals", "1971-12-01", "1972-06-17"],
    ["Tom Constanten", "keyboards", "1968-11-23", "1970-01-30"],
    ["Keith Godchaux", "piano", "1971-10-19", "1979-02-17"],
    ["Donna Jean Godchaux", "vocals", "1971-12-31", "1979-02-17"],
    ["Brent Mydland", "keyboards, vocals", "1979-04-22", "1990-07-23"],
    ["Vince Welnick", "keyboards, vocals", "1990-09-07"],
    ["Bruce Hornsby", "piano, accordion, vocals", "1990-09-15", "1992-03-24"],
  ];
  function lineupOn(iso) {
    return GD_LINEUP.filter(([, , from, to]) => (!from || iso >= from) && (!to || iso <= to))
      .map(([name, role]) => ({ name, role }));
  }

  // "Jerry Garcia - guitar, vocals" style lines in the taper's notes
  const INSTRUMENT = /\b(guitars?|bass|drums?|percussion|keyboards?|keys|piano|organ|vocals?|harmonica|sax(ophone)?|mandolin|banjo|fiddle|violin|pedal steel|dobro|clarinet|trumpet|horns?|flute|accordion|synth(esizer)?s?)\b/i;
  function personnelFrom(text) {
    const out = [];
    for (const line of text.split("\n")) {
      const m = /^\s*[-*•]?\s*([A-Z][A-Za-z.'’"“” -]{3,40}?)\s*(?:[-–—:(]|,\s)\s*([^)]{3,80})\)?\s*$/.exec(line);
      if (!m || !INSTRUMENT.test(m[2]) || m[1].trim().split(/\s+/).length < 2) continue;
      if (/\b(set|disc|cd|track|source|lineage|encore)\b/i.test(m[1])) continue;
      out.push({ name: m[1].trim(), role: m[2].trim() });
    }
    return out;
  }

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

  // ---------------------------------------------------------
  // SONG SEARCH helpers
  // ---------------------------------------------------------
  // the part of a title to search for: "How Sweet It Is (To Be Loved by You)" -> "How Sweet It Is"
  function songPhrase(song) {
    const clean = (s) => s.replace(/["“”\\]/g, "").replace(/\s+/g, " ").trim();
    return clean(song.replace(/\(.*?\)/g, " ")) || clean(song.replace(/[()]/g, " "));
  }

  // matches the title loosely: any apostrophe or none ("Truckin" / "Truckin’"), "and" or "&"
  function songRegex(phrase, flags = "i") {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const words = phrase.split(" ").map((w) =>
      (/^(and|&)$/i.test(w) ? "(?:and|&)" : esc(w).replace(/['’]/g, "['’]?")));
    return new RegExp(`(?<![A-Za-z])${words.join("[\\s,]+")}(?![A-Za-z])`, flags);
  }

  // archive.org's search ignores case, so "Deal" also finds "a great deal" in the taper's notes.
  // Setlists capitalise song titles, so only count a match that starts with a capital.
  function inSetlist(description, phrase) {
    const text = Array.isArray(description) ? description.join("\n") : String(description || "");
    for (const m of text.matchAll(songRegex(phrase, "gi"))) if (!/[a-z]/.test(m[0][0])) return true;
    return false;
  }

  // suggestions on the Songs page
  const SONG_PICKS = [
    "Dark Star", "Scarlet Begonias", "Fire on the Mountain", "Eyes of the World", "Morning Dew", "Help on the Way",
    "Terrapin Station", "China Cat Sunflower", "Bertha", "Sugaree", "Deal", "Harder They Come",
    "Midnight Moonlight", "Mission in the Rain", "Tangled Up in Blue", "Knockin' on Heaven's Door",
  ];
  // Garcia side-project staples for the autocomplete (the Dead's songs come from Relisten, see loadSongNames)
  const GARCIA_SONGS = [
    "Harder They Come", "Midnight Moonlight", "Mission in the Rain", "Run for the Roses", "Cats Under the Stars",
    "That's What Love Will Make You Do", "My Sisters and Brothers", "Tore Up Over You", "Simple Twist of Fate",
    "Positively 4th Street", "Señor (Tales of Yankee Power)", "Dear Prudence", "And It Stoned Me",
    "Waiting for a Miracle", "Shining Star", "That Lucky Old Sun", "Evangeline", "Stop That Train", "Forever Young",
    "I Shall Be Released", "Mystery Train", "Let It Rock", "Think", "Gomorrah", "Don't Let Go", "Rhapsody in Red",
    "The Way You Do the Things You Do", "Russian Lullaby", "Catfish John", "Sitting in Limbo", "Tangled Up in Blue",
    "How Sweet It Is (To Be Loved by You)", "Ain't No Bread in the Breadbox", "Like a Road", "Struggling Man",
    "I Second That Emotion", "Mississippi Moon", "Reuben and Cherise", "Money Honey",
    "Knockin' on Heaven's Door", "Lonesome and a Long Way From Home",
    "Valerie", "Get Out of My Life Woman", "After Midnight", "The Night They Drove Old Dixie Down",
  ];

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

  // most-played recording first; rating breaks ties
  function sortRecordings(shows) {
    for (const s of shows) {
      s.recordings.sort((a, b) => b.downloads - a.downloads || (b.rating || 0) - (a.rating || 0));
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
    let chosen = [], format;
    for (format of prefs) {
      chosen = files.filter((f) => f.format === format);
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
      size: parseInt(f.size, 10) || 0,
      mp3: format !== "Ogg Vorbis",
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
    const sources = ARTISTS[artist].sources;
    if (sources) {
      let total = 0;
      for (const s of sources) {
        if (year < ARTISTS[s].first || year > ARTISTS[s].last) continue;
        const n = cachedCount(s, year);
        if (n == null) return null;
        total += n;
      }
      return total;
    }
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

  // the wall's tabs: one per artist, plus Songs
  function setTab(tab, tagline) {
    $("#wallTagline").textContent = `${tagline} · pulled live from the Internet Archive`;
    document.querySelectorAll(".artist-switch a").forEach((link) =>
      link.classList.toggle("active", link.dataset.artist === tab));
    document.body.dataset.artist = tab;
    $("#songPanel").classList.toggle("hidden", tab !== "songs");
    $("#shelves").classList.toggle("hidden", tab === "songs");
  }

  function renderSongs() {
    wallArtist = null;
    setTab("songs", "Every time the Dead or Jerry played a song, oldest first");
    const picks = $("#songPicks");
    if (!picks.children.length) {
      for (const s of SONG_PICKS) {
        const a = el("a", "chip", s);
        a.href = `#/songs/${encodeURIComponent(s)}`;
        picks.append(a);
      }
    }
    loadSongNames();
    if (!matchMedia("(pointer: coarse)").matches) $("#songInput").focus(); // no pop-up keyboard on phones
  }

  // autocomplete: the Dead's songs from Relisten (an archive.org-based setlist catalogue) plus Garcia staples
  let songNamesLoaded = false;
  async function loadSongNames() {
    if (songNamesLoaded) return;
    songNamesLoaded = true;
    let names = null;
    try {
      const c = JSON.parse(localStorage.getItem("gdvault:songnames") || "null");
      if (c && Date.now() - c.t < 7 * CACHE_TTL_MS) names = c.v;
    } catch { /* ignore */ }
    if (!names) {
      try {
        const res = await fetch("https://api.relisten.net/api/v2/artists/grateful-dead/songs");
        if (!res.ok) throw new Error(String(res.status));
        names = (await res.json()).map((s) => s.name).filter(Boolean);
        try { localStorage.setItem("gdvault:songnames", JSON.stringify({ t: Date.now(), v: names })); } catch { /* quota */ }
      } catch {
        names = []; // no autocomplete for the Dead's songs; typing still works
      }
    }
    const seen = new Set();
    const list = $("#songList");
    for (const n of [...names, ...GARCIA_SONGS].sort((a, b) => a.localeCompare(b))) {
      if (seen.has(n.toLowerCase())) continue;
      seen.add(n.toLowerCase());
      const o = document.createElement("option");
      o.value = n;
      list.append(o);
    }
  }

  $("#songForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const song = $("#songInput").value.trim();
    if (song) location.hash = `#/songs/${encodeURIComponent(song)}`;
  });

  function renderWall(artist) {
    wallArtist = artist;
    const a = ARTISTS[artist];
    setTab(artist, a.tagline);

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
  // A box holds either one artist's year or every performance of a song.
  //   key   identifies what's loaded   base  hash prefix for its tapes   back  where "Back" goes
  const boxState = { key: null, base: "", back: "", artist: null, song: null, shows: [], loading: null };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  async function loadBox({ key, base, back, artist, song = null, title, loading, load, titleFor, empty }) {
    if (boxState.key === key && boxState.shows.length) return;
    Object.assign(boxState, { key, base, back, artist, song, shows: [] });
    document.body.dataset.artist = artist;
    $("#boxTitle").textContent = title;
    $("#backToWall").textContent = song ? "← Back to songs" : "← Back to the wall";
    $("#boxFilter").value = "";
    $("#tapes").innerHTML = "";
    setBoxStatus(loading);

    const thisLoad = (boxState.loading = load());
    try {
      const shows = await thisLoad;
      if (boxState.loading !== thisLoad) return; // user moved on
      boxState.shows = shows;
      const recs = shows.reduce((n, s) => n + s.recordings.length, 0);
      $("#boxTitle").textContent = titleFor(shows, recs);
      setBoxStatus(shows.length ? "" : empty);
      renderTapes();
    } catch (err) {
      if (boxState.loading !== thisLoad) return;
      boxState.key = null; // so "Try again" reloads
      setBoxStatus(`Couldn't reach archive.org: ${err.message}`, true);
    }
  }

  function openBox(artist, year) {
    const a = ARTISTS[artist];
    return loadBox({
      key: `${artist}/${year}`, base: `${artist}/${year}`, back: `#/${artist}`, artist,
      title: `${a.name} · ${year}`,
      loading: "Digging through the box…",
      load: () => api.searchYear(artist, year),
      titleFor: (shows, recs) => `${a.name} · ${year} — ${plural(shows.length, "show")}, ${plural(recs, "tape")}`,
      empty: "This box is empty. No recordings from this year in the archive.",
    });
  }

  function openSongBox(song) {
    return loadBox({
      key: `songs/${song.toLowerCase()}`, base: `songs/${encodeURIComponent(song)}`, back: "#/songs",
      artist: "songs", song,
      title: `“${song}”`,
      loading: "Flipping through every setlist…",
      load: () => api.searchSong(song),
      titleFor: (shows) => shows.length
        ? `“${song}” — ${plural(shows.length, "show")}, ${shows[0].date.slice(0, 4)}–${shows[shows.length - 1].date.slice(0, 4)}`
        : `“${song}”`,
      empty: `No setlists mention “${song}”. Check the spelling, or try a shorter part of the title.`,
    });
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
    const artist = boxState.artist;
    let shown = 0, i = 0, lastYear = null;

    // one cassette per show, showing its most-played recording; the others are in the player's dropdown
    for (const show of boxState.shows) {
      const color = SPINE_COLORS[Math.floor(hash(show.date) * 1000) % SPINE_COLORS.length];
      const venue = [show.venue, show.location].filter(Boolean).join(" · ") || "Unknown venue";
      const band = ARTISTS[show.artist || artist].name;
      const showText = `${show.date} ${fmtDate(show.date)} ${show.venue} ${show.location} ${band}`.toLowerCase();
      const recText = (r) => `${r.project ? ` ${r.project.tag} ${r.project.name}` : ""} ${r.id}`.toLowerCase();

      // if the filter matches a particular recording (e.g. "sbd"), the tape shows the best matching one
      const rec = q
        ? (showText.includes(q) ? show.recordings[0] : show.recordings.find((r) => (showText + recText(r)).includes(q)))
        : show.recordings[0];
      if (!rec) continue;
      const n = show.recordings.length;
      shown++;
      // a song's results span many years: label where each year starts
      if (boxState.song && show.date.slice(0, 4) !== lastYear) {
        lastYear = show.date.slice(0, 4);
        wrap.append(el("div", "tape-year", lastYear));
      }
      const r = hash(rec.id);
      const b = el("button", "tape-case");
      b.style.setProperty("--c", color);
      b.style.setProperty("--tilt", `${(r - 0.5) * 2.4}deg`);
      b.style.setProperty("--delay", `${Math.min(i++ * 10, 600)}ms`);
      const badges = el("span", "t-badges");
      if (rec.project) {
        const p = el("span", "t-proj", rec.project.tag);
        p.title = rec.project.name;
        badges.append(p);
      }
      badges.append(el("span", "t-src", rec.type));
      // date + band name share a row with the badges, so a long band name truncates before them
      const head = el("div", "t-head");
      head.append(
        el("span", "t-date", fmtDate(show.date)),
        el("span", "t-band", rec.project ? rec.project.name : band),
        badges,
      );
      const spine = el("div", "spine");
      spine.append(
        head,
        el("div", "t-venue", venue),
        el("div", "t-lineage", recLabel(rec.id, show.date)),
      );
      b.append(spine);
      if (n > 1) b.append(el("span", "t-of", `${n} versions`));
      b.title = [fmtLongDate(show.date), rec.project && rec.project.name, show.venue, show.location, rec.id,
        rec.rating ? `★ ${rec.rating.toFixed(1)}` : "", `${rec.downloads.toLocaleString()} plays`,
        n > 1 ? `${n} versions — pick another in the player` : ""].filter(Boolean).join("\n");
      b.addEventListener("click", () => {
        location.hash = `#/${boxState.base}/${show.date}/${encodeURIComponent(rec.id)}`;
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
    cue: null, // regex for the song to start on, when opened from a song search
    gapless: false, // this tape streams through `gapless` (see gapless.js) rather than one file at a time
  };
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  // Gapless playback: the whole show goes through one MediaSource, so there's no pause between songs.
  // Not on iOS (Safari's MediaSource there isn't proven with lock-screen playback) or where MP3 MediaSource
  // isn't supported; those, and Ogg-only tapes, play one file at a time like before.
  const gapless = window.GaplessStream && GaplessStream.supported() && !IOS ? new GaplessStream(audio) : null;
  if (gapless) {
    gapless.onfail = (_err, started) => {
      if (!player.gapless) return;
      if (!started) { // never got going (odd file?): fall back to one file at a time for this tape
        const wasPlaying = !audio.paused;
        gapless.unload();
        player.gapless = false;
        loadTrack(player.index, wasPlaying);
      } else {
        lcd(undefined, undefined, "TAPE JAMMED — TRY ANOTHER SOURCE");
      }
    };
  }

  // where the tape is: the current song's index and the time within it
  function position() {
    return player.gapless ? gapless.position() : { i: player.index, t: audio.currentTime };
  }
  function seekTo(t) {
    if (player.gapless) gapless.seek(player.index, t);
    else audio.currentTime = t;
  }
  // highlight song i on the J-card and show it on the LCD
  function showTrack(i) {
    const t = player.tracks[i];
    document.querySelectorAll("#trackList li").forEach((li, n) => li.classList.toggle("current", n === i));
    const cur = document.querySelectorAll("#trackList li")[i];
    if (cur) cur.scrollIntoView({ block: "nearest" });
    lcd(`TRK ${String(i + 1).padStart(2, "0")}/${String(player.tracks.length).padStart(2, "0")}`, undefined, t.title.toUpperCase());
    updateMediaSession();
  }

  async function openPlayer(artist, show, recId) {
    artist = show.artist || artist; // shows in the combined box carry their own band
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
    $("#cassBand").textContent = rec.project ? rec.project.name : ARTISTS[artist].name;
    $("#jDate").textContent = fmtLongDate(show.date);
    $("#jVenue").textContent = (rec.project ? `${rec.project.name} — ` : "") + (where.join(" — ") || "Unknown venue");
    $("#archiveLink").href = `https://archive.org/details/${rec.id}`;
    if (!sameShow) fillSourceSelect(show);
    $("#sourceSelect").value = rec.id;
    $("#trackList").innerHTML = "";
    $("#trackList").append(el("li", "muted", "Threading the tape…"));
    for (const id of ["#jNotes", "#jReviews"]) { $(id).innerHTML = ""; $(id).append(el("p", "muted", "Threading the tape…")); }
    renderLineup(artist, show, null);
    if (!sameShow) { setPage("Tracks"); loadHistory(artist, show); }
    else setPage(jcard.page);
    lcd("TRK --/--", "00:00", "LOADING…");
    setReels(0);

    const token = ++player.loadToken;
    try {
      const { tracks, info, reviews } = await api.recording(rec.id);
      if (token !== player.loadToken) return;
      renderNotes(info);
      renderReviews(reviews);
      renderLineup(artist, show, info);
      if (!tracks.length) throw new Error("no streamable audio in this recording");
      player.tracks = tracks;
      player.offsets = [];
      let acc = 0;
      for (const t of tracks) { player.offsets.push(acc); acc += t.duration; }
      player.total = acc;
      player.gapless = !!gapless && tracks.every((t) => t.mp3);
      if (player.gapless) gapless.load(tracks);
      renderTrackList();
      $("#cassette").classList.remove("empty");
      // opened from a song search: wind the tape to that song
      const cueAt = player.cue ? tracks.findIndex((t) => player.cue.test(t.title)) : -1;
      loadTrack(Math.max(cueAt, 0), false);
      lcd(undefined, undefined, "PRESS PLAY ▶");
    } catch (err) {
      if (token !== player.loadToken) return;
      $("#trackList").innerHTML = "";
      $("#trackList").append(el("li", "muted", `Tape jammed: ${err.message}. Try another source.`));
      for (const id of ["#jNotes", "#jReviews"]) { $(id).innerHTML = ""; $(id).append(el("p", "muted", "Couldn't load this recording's details.")); }
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
      const o = el("option", null, `${proj}${r.type}${i === 0 ? " (most played)" : ""} — ${r.id} (${rating}${r.downloads.toLocaleString()} plays)`);
      o.value = r.id;
      o.title = o.textContent;
      sel.append(o);
    });
  }

  // ---------------------------------------------------------
  // J-card pages: Tracks · Notes · Performers · Reviews · History, flipped with ‹ › or a swipe
  // ---------------------------------------------------------
  const jcard = { page: "Tracks" };
  function jPages() { return [...$("#jPages").children].filter((p) => !p.dataset.off); }

  function setPage(name, dir) {
    const pages = jPages();
    let i = pages.findIndex((p) => p.dataset.name === name);
    if (i < 0) i = 0;
    const page = pages[i];
    jcard.page = page.dataset.name;
    [...$("#jPages").children].forEach((p) => {
      p.classList.toggle("active", p === page);
      p.classList.remove("in-left", "in-right");
    });
    if (dir) { void page.offsetWidth; page.classList.add(dir > 0 ? "in-right" : "in-left"); }
    $("#jPageName").textContent = page.dataset.label || page.dataset.name;
    const dots = $("#jDots");
    dots.innerHTML = "";
    pages.forEach((p, k) => {
      const b = el("button", k === i ? "on" : "");
      b.type = "button";
      b.setAttribute("aria-label", p.dataset.name);
      b.title = p.dataset.name;
      b.addEventListener("click", () => setPage(p.dataset.name, Math.sign(k - i)));
      dots.append(b);
    });
    if (page.id === "trackList") {
      const cur = page.querySelector("li.current");
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
  }
  function flipPage(step) {
    const pages = jPages();
    const i = pages.findIndex((p) => p.dataset.name === jcard.page);
    setPage(pages[(i + step + pages.length) % pages.length].dataset.name, step);
  }
  $("#jPrev").addEventListener("click", () => flipPage(-1));
  $("#jNext").addEventListener("click", () => flipPage(1));
  {
    // horizontal swipe on the page area (iPad / phones)
    let sx = 0, sy = 0, tracking = false;
    const area = $("#jPages");
    area.addEventListener("touchstart", (e) => {
      const t = e.touches[0]; sx = t.clientX; sy = t.clientY; tracking = e.touches.length === 1;
    }, { passive: true });
    area.addEventListener("touchend", (e) => {
      if (!tracking) return;
      tracking = false;
      const t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) flipPage(dx < 0 ? 1 : -1);
    }, { passive: true });
  }

  function textSection(box, heading, text) {
    if (!text) return;
    if (heading) box.append(el("h4", null, heading));
    box.append(el("p", "pre", text));
  }

  function renderNotes(info) {
    const box = $("#jNotes");
    box.innerHTML = "";
    textSection(box, "", info.description);
    textSection(box, "Notes", info.notes);
    textSection(box, "Source", info.source);
    if (info.lineage !== info.source) textSection(box, "Lineage", info.lineage);
    const who = [["Taped by", info.taper], ["Transferred by", info.transferer]].filter(([, v]) => v);
    if (who.length) {
      const dl = el("dl", "who");
      for (const [k, v] of who) dl.append(el("dt", null, k), el("dd", null, v));
      box.append(dl);
    }
    if (!box.childElementCount) box.append(el("p", "muted", "The taper didn't leave any notes for this source."));
  }

  function renderReviews(reviews) {
    const box = $("#jReviews");
    box.innerHTML = "";
    const list = [...reviews].sort((a, b) => String(b.reviewdate || "").localeCompare(String(a.reviewdate || "")));
    $("#jReviews").dataset.label = list.length ? `Reviews (${list.length})` : "Reviews";
    if (!list.length) {
      box.append(el("p", "muted", "No one has reviewed this source yet."));
    }
    for (const r of list) {
      const art = el("article", "review");
      const head = el("div", "rv-head");
      const stars = Math.max(0, Math.min(5, parseInt(r.stars, 10) || 0));
      if (stars) {
        const s = el("span", "rv-stars", "★".repeat(stars) + "☆".repeat(5 - stars));
        s.setAttribute("aria-label", `${stars} out of 5 stars`);
        head.append(s);
      }
      if (r.reviewtitle) head.append(el("strong", null, String(r.reviewtitle)));
      art.append(head);
      const by = [r.reviewer, String(r.reviewdate || "").slice(0, 10)].filter(Boolean).join(" · ");
      if (by) art.append(el("div", "rv-by", by));
      if (r.reviewbody) art.append(el("p", "pre", String(r.reviewbody).trim()));
      box.append(art);
    }
    if (jcard.page === "Reviews") $("#jPageName").textContent = $("#jReviews").dataset.label;
  }

  function renderLineup(artist, show, info) {
    const box = $("#jLineup");
    box.innerHTML = "";
    const core = artist === "gd" ? lineupOn(show.date) : [{ name: "Jerry Garcia", role: "guitar, vocals" }];
    const known = (name) => core.some((c) => name.toLowerCase().includes(c.name.split(" ").pop().toLowerCase()));
    const fromNotes = info ? personnelFrom([info.description, info.notes].join("\n")).filter((p) => !known(p.name)) : [];
    const list = (people) => {
      const dl = el("dl", "lineup");
      for (const p of people) dl.append(el("dt", null, p.name), el("dd", null, p.role));
      return dl;
    };
    if (artist === "gd") {
      box.append(el("h4", null, "The band"), list(core));
    } else {
      const proj = player.rec && player.rec.project;
      box.append(el("h4", null, proj ? proj.name : "Jerry Garcia"), list(core));
    }
    if (fromNotes.length) box.append(el("h4", null, "Also listed in the notes"), list(fromNotes));
    box.append(el("p", "muted small", artist === "gd"
      ? "Based on the band's lineup on this date. Guests usually turn up in the Notes."
      : "Garcia's side-project lineups changed often. Check the Notes for who played this night."));
  }

  async function loadHistory(artist, show) {
    const page = $("#jHistory");
    page.dataset.off = "1";
    page.innerHTML = "";
    const want = show;
    try {
      const found = await api.history(ARTISTS[artist].name, show.date);
      if (player.show !== want || !found.length) return;
      for (const a of found) {
        const h = el("h4");
        const link = el("a", null, a.title);
        link.href = a.url; link.target = "_blank"; link.rel = "noopener";
        h.append(link);
        page.append(h);
        for (const p of a.paras) page.append(el("p", null, p));
      }
      page.append(el("p", "muted small", "From Wikipedia, CC BY-SA."));
      delete page.dataset.off;
      setPage(jcard.page); // refresh the dots
    } catch { /* no history page, that's fine */ }
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
    if (player.gapless) gapless.cue(i);
    else {
      audio.src = player.tracks[i].url;
      audio.load();
    }
    showTrack(i);
    lcd(undefined, "00:00");
    if (autoplay) play();
    else updateTransport();
  }

  function play() {
    if (!player.tracks.length) return;
    initMeter(); // needs a user gesture, which every play() call comes from
    audio.play().catch((e) => { if (e.name !== "AbortError") lcd(undefined, undefined, "TAPE JAMMED"); });
  }
  function pause() { audio.pause(); }
  function stopAudio(silent) {
    audio.pause();
    if (!silent && player.tracks.length) seekTo(0);
    if (silent) {
      if (gapless) gapless.unload();
      player.gapless = false;
      audio.removeAttribute("src");
      audio.load();
    }
    updateTransport();
  }
  function next() {
    if (player.index < player.tracks.length - 1) loadTrack(player.index + 1, !audio.paused || audio.ended);
  }
  function prev() {
    // standard deck behaviour: if we're a few seconds in, rewind to the top of the song first
    if (position().t > 4) { seekTo(0); return; }
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
    if (playing && meter.analyser) {
      if (actx.state === "suspended") actx.resume(); // audio is routed through actx, so it must be running
      if (!meter.raf) meter.raf = requestAnimationFrame(drawMeter);
    }
  }

  // ---------------------------------------------------------
  // level meter: real levels from the stream via an AnalyserNode.
  // archive.org sends CORS headers, so the <audio> element is crossorigin and can be
  // routed through Web Audio. Skipped on iOS (routing <audio> through Web Audio stops
  // playback when the screen locks) and for reduced motion; there, or without Web Audio,
  // the CSS animation in styles.css runs instead.
  // ---------------------------------------------------------
  const bars = [...document.querySelectorAll(".window-glass i")];
  const meter = { analyser: null, gain: null, data: null, bands: [], raf: 0 };

  function initMeter() {
    if (meter.analyser || IOS || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const analyser = actx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.7;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -20;
      const gain = actx.createGain();
      gain.gain.value = audio.volume;
      actx.createMediaElementSource(audio).connect(analyser).connect(gain).connect(actx.destination);
      audio.volume = 1; // volume now lives on the gain node, after the meter (like a deck's record level)
      meter.analyser = analyser;
      meter.gain = gain;
      meter.data = new Uint8Array(analyser.frequencyBinCount);
      // log-spaced bands from 60 Hz to 11 kHz, so bass and treble each get bars
      const hz = actx.sampleRate / analyser.fftSize;
      const edge = (b) => Math.max(1, Math.round((60 * Math.pow(11000 / 60, b / bars.length)) / hz));
      meter.bands = bars.map((_, b) => [edge(b), Math.max(edge(b) + 1, edge(b + 1))]);
      $(".window-glass").classList.add("live");
    } catch { /* no Web Audio: the CSS animation stays */ }
  }

  function drawMeter() {
    meter.raf = 0;
    const playing = !audio.paused && !audio.ended;
    if (!playing) { bars.forEach((bar) => { bar.style.transform = ""; }); return; } // rest height from CSS
    meter.analyser.getByteFrequencyData(meter.data);
    meter.bands.forEach(([lo, hi], b) => {
      let peak = 0;
      for (let k = lo; k < hi; k++) peak = Math.max(peak, meter.data[k]);
      const tilt = 1 + 0.1 * b; // treble carries less energy; lift it so the right-hand bars still dance
      bars[b].style.transform = `scaleY(${Math.min(1, Math.max(0.06, (peak / 255) * tilt)).toFixed(3)})`;
    });
    meter.raf = requestAnimationFrame(drawMeter);
  }

  let seeking = false;
  audio.addEventListener("timeupdate", () => {
    if (!player.tracks.length) return;
    const pos = position();
    if (pos.i !== player.index) { // gapless: the tape rolled on into the next song
      player.index = pos.i;
      showTrack(pos.i);
    }
    const t = player.tracks[pos.i];
    if (!t) return;
    const dur = !player.gapless && isFinite(audio.duration) ? audio.duration : t.duration;
    lcd(undefined, fmtTime(pos.t));
    if (!seeking && dur) $("#seek").value = Math.round(Math.min(1, pos.t / dur) * 1000);
    if (player.total) setReels(Math.min(1, (player.offsets[pos.i] + pos.t) / player.total));
    // lock screen / media overlay: the song's own length (a gapless tape's element spans the whole show)
    if (player.gapless && dur && "mediaSession" in navigator && navigator.mediaSession.setPositionState) {
      try { navigator.mediaSession.setPositionState({ duration: dur, position: Math.min(pos.t, dur), playbackRate: audio.playbackRate }); } catch { /* ignore */ }
    }
  });
  audio.addEventListener("play", () => {
    const t = player.tracks[player.index];
    if (t) lcd(undefined, undefined, t.title.toUpperCase()); // replaces "PRESS PLAY ▶" and other prompts
    updateTransport();
  });
  audio.addEventListener("pause", updateTransport);
  audio.addEventListener("ended", () => {
    // gapless tapes only end after the last song; one-file-at-a-time tapes load the next song here
    if (!player.gapless && player.index < player.tracks.length - 1) loadTrack(player.index + 1, true);
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
    const dur = !player.gapless && isFinite(audio.duration) ? audio.duration : t && t.duration;
    if (dur) seekTo((seek.value / 1000) * dur);
    seeking = false;
  });
  const vol = $("#volume");
  audio.volume = vol.value / 100;
  vol.addEventListener("input", () => {
    if (meter.gain) meter.gain.gain.value = vol.value / 100;
    else audio.volume = vol.value / 100;
  });

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
      location.hash = boxState.back || `#/${DEFAULT_ARTIST}`;
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
    const isTab = (t) => t === "songs" || !!ARTISTS[t];
    if (!isTab(parts[0])) {
      let saved = null;
      try { saved = localStorage.getItem("gdvault:artist"); } catch { /* ignore */ }
      location.replace(`#/${isTab(saved) ? saved : DEFAULT_ARTIST}`);
      return;
    }
    try { localStorage.setItem("gdvault:artist", parts[0]); } catch { /* ignore */ }

    const showWall = () => {
      if (player.show) closePlayer();
      $("#boxview").classList.add("hidden");
      $("#wall").classList.remove("hidden");
    };
    const showBox = () => {
      $("#wall").classList.add("hidden");
      $("#boxview").classList.remove("hidden");
    };
    const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

    let date, recId, path, label, boxTitle, extra;
    if (parts[0] === "songs") {
      // #/songs   #/songs/<song>   #/songs/<song>/<date>/<identifier>
      const song = parts[1] ? decode(parts[1]).trim() : "";
      if (!song) {
        showWall();
        renderSongs();
        trackView("/songs", "Songs");
        return;
      }
      [, , date, recId] = parts;
      showBox();
      await openSongBox(song);
      path = `/songs/${encodeURIComponent(song)}`;
      label = boxTitle = `“${song}”`;
      extra = { song };
    } else {
      const [artist, yearStr] = parts;
      [, , date, recId] = parts;
      const a = ARTISTS[artist];
      const year = parseInt(yearStr, 10);
      if (!year || year < a.first || year > a.last) {
        showWall();
        renderWall(artist);
        trackView(`/${artist}`, `${a.name} — all years`, { artist: a.name });
        return;
      }
      showBox();
      await openBox(artist, year);
      path = `/${artist}/${year}`;
      label = a.name;
      boxTitle = `${a.name} · ${year}`;
      extra = { artist: a.name, year: String(year) };
    }

    // a combined or song box can hold a GD and a JG show on the same date; the recording id tells them apart
    const id = recId && decode(recId);
    const onDate = date ? boxState.shows.filter((s) => s.date === date) : [];
    const show = onDate.find((s) => s.recordings.some((r) => r.id === id)) || onDate[0];
    if (show) {
      player.cue = boxState.song ? songRegex(songPhrase(boxState.song)) : null;
      openPlayer(show.artist || parts[0], show, id);
      trackView(`${path}/${date}`, `${label} · ${date}${show.venue ? ` · ${show.venue}` : ""}`,
        { ...extra, show_date: date });
    } else {
      if (!date && !$("#player").classList.contains("hidden")) closePlayer();
      trackView(path, boxTitle, extra);
    }
  }

  $("#backToWall").addEventListener("click", () => { location.hash = boxState.back || `#/${DEFAULT_ARTIST}`; });
  $("#boxFilter").addEventListener("input", renderTapes);
  window.addEventListener("hashchange", route);
  route();
})();
