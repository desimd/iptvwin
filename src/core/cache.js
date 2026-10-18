// File cache (port of CacheStore.kt): categories + starred-category channels (24h TTL),
// M3U playlists (until refreshed), and the per-source search index file.
const fs = require("fs");
const path = require("path");
const AdultFilter = require("./adultFilter");

const TTL = 24 * 60 * 60 * 1000;
const sanitize = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

class Cache {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }); }

  isStale(ts) { return Date.now() - ts > TTL; }
  _f(name) { return path.join(this.dir, name); }
  _read(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return null; } }
  _write(file, obj) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  }

  // Everything is re-filtered on read (self-healing) and filtered before write.
  getCategories(sid) {
    const o = this._read(this._f(`categories_${sanitize(sid)}.json`));
    if (!o || !Array.isArray(o.data)) return null;
    return { data: AdultFilter.filterCategories(o.data), timestamp: o.timestamp || 0 };
  }
  putCategories(sid, data) {
    this._write(this._f(`categories_${sanitize(sid)}.json`), { timestamp: Date.now(), data: AdultFilter.filterCategories(data) });
  }

  getChannels(sid, key) {
    const o = this._read(this._f(`channels_${sanitize(sid)}_${sanitize(key)}.json`));
    if (!o || !Array.isArray(o.data)) return null;
    return { data: AdultFilter.filterChannels(o.data.map((c) => ({ name: c.name, url: c.url, group: "" }))), timestamp: o.timestamp || 0 };
  }
  putChannels(sid, key, data) {
    const d = AdultFilter.filterChannels(data).map((c) => ({ name: c.name, url: c.url }));
    this._write(this._f(`channels_${sanitize(sid)}_${sanitize(key)}.json`), { timestamp: Date.now(), data: d });
  }

  getM3u(sid) {
    const o = this._read(this._f(`m3u_${sanitize(sid)}.json`));
    if (!o || !Array.isArray(o.data)) return null;
    return AdultFilter.filterChannels(o.data.map((c) => ({ name: c.name, url: c.url, group: c.group || "" })));
  }
  putM3u(sid, data) {
    this._write(this._f(`m3u_${sanitize(sid)}.json`), { data: AdultFilter.filterChannels(data) });
  }

  searchIndexFile(sid) { return this._f(`search_index_${sanitize(sid)}.tsv`); }

  clearChannels(sid, key) {
    try { fs.unlinkSync(this._f(`channels_${sanitize(sid)}_${sanitize(key)}.json`)); } catch (e) { /* none */ }
  }

  clearForSource(sid) {
    const s = sanitize(sid);
    for (const f of fs.readdirSync(this.dir)) {
      if (f.startsWith(`categories_${s}`) || f.startsWith(`channels_${s}_`) || f.startsWith(`m3u_${s}`) || f.startsWith(`search_index_${s}`)) {
        try { fs.unlinkSync(this._f(f)); } catch (e) { /* ignore */ }
      }
    }
  }
}

module.exports = { Cache, TTL };
