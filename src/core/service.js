// The app logic the UI talks to (what the Android Activities did with the stores, cache and clients).
const crypto = require("crypto");
const { Store } = require("./store");
const { Cache } = require("./cache");
const { SearchIndex } = require("./searchIndex");
const { Epg } = require("./epg");
const xtream = require("./xtreamClient");
const m3u = require("./m3uParser");
const { DEFAULT_UA } = require("./http");
const fs = require("fs");
const { exportPlaylist } = require("./m3uExport");
const sports = require("./sports");
const gameSearch = require("./gameSearch");
const catalog = require("./m3uCatalog");
const backup = require("./backup");

class Service {
  constructor(dataDir) {
    this.store = new Store(dataDir);
    this.cache = new Cache(require("path").join(dataDir, "cache"));
    this.search = new SearchIndex(this.cache, (id) => this.store.getSource(id));
    this._m3uMem = null; // { sid, list }: the parsed playlist of the M3U source in use, kept in memory
    this.epg = new Epg((src, streamId) => xtream.fetchShortEpg(src, streamId, 3, this.store.getEpgShift(src.id) * 60000));
  }

  _src(id) {
    const s = this.store.getSource(id);
    if (!s) throw new Error("Source not found");
    return s;
  }

  // The parsed M3U playlist: memory, else disk cache, else downloaded (and cached until the source is refreshed).
  async _m3u(s) {
    if (this._m3uMem && this._m3uMem.sid === s.id) return this._m3uMem.list;
    let list = this.cache.getM3u(s.id);
    if (!list) { list = await m3u.parse(s.m3uUrl, s.userAgent); this.cache.putM3u(s.id, list); }
    this._m3uMem = { sid: s.id, list };
    return list;
  }

  // ---- sources ----
  listSources() { return this.store.getSourcesByRecent(); }
  markUsed(id) { this.store.markUsed(id); }

  // Validates the login before saving, so a bad one never ends up on the home screen.
  async saveSource(f) {
    const userAgent = (f.userAgent || "").trim() || DEFAULT_UA;
    const old = f.id ? this.store.getSource(f.id) : null;
    let src;
    if (f.type === "XTREAM") {
      const server = (f.server || "").trim(), user = (f.user || "").trim(), pass = (f.pass || "").trim();
      if (!server || !user || !pass) throw new Error("Please fill in all Xtream fields");
      src = { id: old ? old.id : crypto.randomUUID(), type: "XTREAM", name: (f.name || "").trim() || server.replace(/^https?:\/\//i, ""), server, user, pass, m3uUrl: "", userAgent };
      try { await xtream.fetchCategories(src); } catch (e) { throw new Error("Failed to connect: " + e.message); }
    } else {
      const url = (f.m3uUrl || "").trim();
      if (!url) throw new Error("Please enter an M3U URL");
      let host = "M3U Playlist";
      try { host = new URL(url).host || host; } catch (e) { /* keep default */ }
      src = { id: old ? old.id : crypto.randomUUID(), type: "M3U", name: (f.name || "").trim() || host, server: "", user: "", pass: "", m3uUrl: url, userAgent };
      let list;
      try { list = await m3u.parse(url, userAgent); } catch (e) { throw new Error("Failed to load playlist: " + e.message); }
      if (!list.length) throw new Error("Failed to load playlist: No channels found in playlist");
    }
    if (!old) { this.store.addSource(src); return src; }
    // Same id, so favourites / starred / hidden / EZ list / last-used all stay attached.
    this.store.replaceSource(src);
    const changed = old.server !== src.server || old.user !== src.user || old.pass !== src.pass || old.m3uUrl !== src.m3uUrl;
    if (changed) {
      if (src.type === "XTREAM") {
        const a = xtream.streamPrefix(old.server, old.user, old.pass), b = xtream.streamPrefix(src.server, src.user, src.pass);
        if (a !== b) this.store.rewriteUrls(src.id, a, b);
      }
      this.cache.clearForSource(src.id);
      this.epg.clearForSource(src.id);
      this._m3uMem = null;
    }
    return src;
  }

  removeSource(id) { this.store.removeSource(id); this.cache.clearForSource(id); this.epg.clearForSource(id); this._m3uMem = null; }

  refreshSource(id) {
    const s = this._src(id);
    this.cache.clearForSource(id); // also drops the search index
    this._m3uMem = null;
    if (s.type === "XTREAM") this.search.refreshAsync(s);
  }

  // ---- EPG (Xtream only; M3U sources just get null) ----
  // -> { now, next, after } (each {title,start,stop}|null) | null
  async getEpg(sid, url) {
    const s = this._src(sid);
    if (s.type !== "XTREAM") return null;
    return this.epg.get(s, url);
  }

  // Per-playlist EPG shift in minutes. Changing it drops that playlist's cached programmes so the
  // player bar and the guide are re-fetched with the new shift (other playlists are untouched).
  getEpgShift(sid) { this._src(sid); return this.store.getEpgShift(sid); }
  setEpgShift(sid, minutes) {
    this._src(sid);
    const before = this.store.getEpgShift(sid);
    const n = this.store.setEpgShift(sid, minutes);
    if (n !== before) this.epg.clearForSource(sid);
    return n;
  }

  // Fire-and-forget warm-up for the channels the viewer is likely to switch to next.
  prefetchEpg(sid, urls) {
    const s = this.store.getSource(sid);
    if (!s || s.type !== "XTREAM" || !Array.isArray(urls)) return;
    this.epg.prefetch(s, urls.filter((u) => typeof u === "string").slice(0, 10));
  }

  // ---- categories (Xtream) ----
  async getCategories(sid) {
    const s = this._src(sid);
    if (s.type === "M3U") { // the playlist's groups are the categories
      return { categories: catalog.categories(await this._m3u(s)), starred: this.store.getStarred(sid), hidden: this.store.getHidden(sid) };
    }
    const cached = this.cache.getCategories(sid);
    let categories;
    if (cached) {
      categories = cached.data;
      if (this.cache.isStale(cached.timestamp)) { // stale-while-revalidate, disk only
        xtream.fetchCategories(s).then((c) => this.cache.putCategories(sid, c)).catch(() => {});
      }
    } else {
      categories = await xtream.fetchCategories(s);
      this.cache.putCategories(sid, categories);
    }
    return { categories, starred: this.store.getStarred(sid), hidden: this.store.getHidden(sid) };
  }

  toggleStar(sid, catId) {
    const now = this.store.toggleStarred(sid, catId);
    if (!now) this.cache.clearChannels(sid, catId); // no longer starred -> drop its cache
    return now;
  }

  // ---- channel lists. spec.kind: favourites | m3u | category | search ----
  async loadList(sid, spec) {
    const s = this._src(sid);
    switch (spec.kind) {
      case "favourites": return this.store.getFavourites(sid, spec.id);
      case "m3u": return this._m3u(s);
      case "category": {
        if (s.type === "M3U") return catalog.channelsOf(await this._m3u(s), spec.id);
        // Only starred categories are cached (24h, stale-while-revalidate); others are always live.
        if (!this.store.getStarred(sid).includes(spec.id)) return xtream.fetchChannels(s, spec.id);
        const c = this.cache.getChannels(sid, spec.id);
        if (c) {
          if (this.cache.isStale(c.timestamp)) {
            xtream.fetchChannels(s, spec.id).then((l) => this.cache.putChannels(sid, spec.id, l)).catch(() => {});
          }
          return c.data;
        }
        const list = await xtream.fetchChannels(s, spec.id);
        this.cache.putChannels(sid, spec.id, list);
        return list;
      }
      case "recent": return this.store.getRecent(sid);
      case "search": {
        if (s.type === "M3U") { const l = await this._m3u(s); return catalog.search(l, spec.query, catalog.hasGroups(l)); }
        return this.search.query(s, spec.query);
      }
      default: return [];
    }
  }

  // ---- export as a compact M3U file ----
  // Xtream: every category that is ticked in "Manage categories" (hidden ones are left out), in provider order,
  // fetched live (several at a time). M3U sources: the whole playlist, grouped as in the original.
  // The file is written to "<path>.part" and renamed when complete, so a cancelled / failed export leaves nothing behind.
  // -> { path, channels, categories, skipped: [names], bytes } | { cancelled: true }
  async exportM3u(sid, filePath, { onProgress, isCancelled } = {}) {
    const s = this._src(sid);
    let batches;
    if (s.type === "XTREAM") {
      const d = await this.getCategories(sid);
      const hidden = new Set(d.hidden);
      batches = d.categories.filter((c) => !hidden.has(c.id)).map((c) => ({ group: c.name, load: () => xtream.fetchChannels(s, c.id) }));
    } else {
      const list = await this.loadList(sid, { kind: "m3u" });
      const byGroup = new Map();
      for (const c of list) { const g = c.group || ""; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(c); }
      batches = [...byGroup].map(([group, chs]) => ({ group, load: async () => chs }));
    }
    if (!batches.length) throw new Error("No categories are selected. Tick some in Manage categories first.");
    const tmp = filePath + ".part";
    const fd = fs.openSync(tmp, "w");
    let r;
    try {
      r = await exportPlaylist(batches, { write: (t) => fs.writeSync(fd, t), onProgress, isCancelled });
      fs.closeSync(fd);
    } catch (e) {
      try { fs.closeSync(fd); } catch (e2) { /* already closed */ }
      try { fs.unlinkSync(tmp); } catch (e2) { /* nothing written */ }
      if (e && e.cancelled) return { cancelled: true };
      throw e;
    }
    if (!r.channels) { try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ } throw new Error("No channels could be loaded for export" + (r.skipped.length ? " (" + r.skipped.length + " categories failed)" : "")); }
    fs.renameSync(tmp, filePath);
    return { path: filePath, channels: r.channels, categories: batches.length - r.skipped.length, skipped: r.skipped, bytes: fs.statSync(filePath).size };
  }

  exportBackup(includeLogins) { return backup.exportBackup(this.store, !!includeLogins); }
  importBackup(text) { return backup.importBackup(this.store, text, { defaultUserAgent: DEFAULT_UA }); }

  // ---- games (live + upcoming; port of the Android "ball" page) ----
  sportsLeagues() { return sports.LEAGUES.map((l) => ({ id: l.id, label: l.label, dur: l.dur })); }

  // Looks for a stream of the game in this playlist -> { label, firstQuery, channels } | null.
  async findGameStreams(sid, game) {
    const s = this._src(sid);
    const team = (t) => t && typeof t.name === "string" && t.name.trim();
    if (!game || typeof game.league !== "string" || !team(game.home) || !team(game.away)) throw new Error("Invalid game");
    return gameSearch.find(this, s, { league: game.league, home: { name: game.home.name }, away: { name: game.away.name } });
  }

  async refreshSearch(sid, query) {
    const s = this._src(sid);
    if (s.type === "M3U") return this.loadList(sid, { kind: "search", query });
    await this.search.build(s);
    return this.search.read(s, query);
  }
}

module.exports = { Service };
