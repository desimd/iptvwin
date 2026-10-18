// Daily-refreshed search index, one TSV per Xtream source (port of SearchIndex.kt):
// stream_id <TAB> category_id <TAB> ext <TAB> name. No URLs or credentials are stored; adult
// channels are never written. Build is atomic (temp file + rename).
const fs = require("fs");
const AdultFilter = require("./adultFilter");
const xtream = require("./xtreamClient");
const SearchTerms = require("./searchTerms");

class SearchIndex {
  constructor(cache, getSource) {
    this.cache = cache;
    this.getSource = getSource; // id -> current saved source (to detect edits during a build)
    this.building = new Map();  // sourceId -> Promise
  }

  async query(src, q) {
    const file = this.cache.searchIndexFile(src.id);
    if (!fs.existsSync(file)) await this.build(src);
    else if (this.cache.isStale(fs.statSync(file).mtimeMs)) this.refreshAsync(src);
    return this.read(src, q);
  }

  build(src) {
    if (this.building.has(src.id)) return this.building.get(src.id);
    const p = this._build(src).finally(() => this.building.delete(src.id));
    this.building.set(src.id, p);
    return p;
  }

  async _build(src) {
    const dest = this.cache.searchIndexFile(src.id);
    const tmp = dest + ".tmp";
    const lines = [];
    try {
      await xtream.fetchAllLive(src, (id, cat, ext, name, adultFlag) => {
        if (AdultFilter.isBlockedChannel(name, "", adultFlag)) return;
        lines.push(`${id}\t${cat}\t${ext}\t${name.replace(/[\t\r\n]/g, " ")}`);
      });
      if (lines.length === 0) throw new Error("Provider returned no channels");
      const cur = this.getSource(src.id);
      if (!cur || JSON.stringify(cur) !== JSON.stringify(src)) throw new Error("Source changed");
      fs.writeFileSync(tmp, lines.join("\n") + "\n", "utf8");
      fs.renameSync(tmp, dest);
      return lines.length;
    } finally {
      try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    }
  }

  // Background rebuild; failures are ignored (the old index keeps serving).
  refreshAsync(src) {
    this.build(src).catch(() => {});
  }

  read(src, q) {
    const file = this.cache.searchIndexFile(src.id);
    const prefix = xtream.streamPrefix(src.server, src.user, src.pass);
    const words = SearchTerms.tokens(q); // every word must be in the name, in any order (same as the Android app)
    const out = [];
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const p = line.split("\t");
      if (p.length < 4) continue;
      const name = p.slice(3).join(" ");
      if (!SearchTerms.matches(name, words)) continue;
      out.push({ name, url: `${prefix}${encodeURIComponent(p[0])}.${p[2]}`, group: "", catId: p[1] }); // catId: lets "Open category" find the channel
    }
    return AdultFilter.filterChannels(out);
  }
}

module.exports = { SearchIndex };
