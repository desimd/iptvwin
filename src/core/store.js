// All persistent user data in one JSON file (atomic writes): sources, favourites, EZ lists,
// starred/hidden categories, UI prefs and the "where was I" session. Everything is per source id.
const fs = require("fs");
const path = require("path");
const AdultFilter = require("./adultFilter");

const EZ_SLOTS = 5;
const RECENT_MAX = 3;
const DEFAULT_LIST = "default"; // the built-in "Favourites" list (keeps its old storage key)
const DEFAULT_LIST_NAME = "Favourites";
const LIST_NAME_MAX = 24;

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "userdata.json");
    this.d = this._load();
  }

  _load() {
    const empty = { sources: [], lastUsed: {}, favourites: {}, ezlist: {}, recent: {}, favlists: {}, starred: {}, hidden: {}, epgShift: {}, ui: {}, session: null };
    if (!fs.existsSync(this.file)) return empty;
    try {
      return Object.assign(empty, JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch (e) {
      try { fs.renameSync(this.file, this.file.replace(/\.json$/, `.corrupt-${Date.now()}.json`)); } catch (e2) { /* ignore */ }
      return empty;
    }
  }

  save() {
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.d));
    fs.renameSync(tmp, this.file);
  }

  // ---- sources ----
  getSources() { return this.d.sources.slice(); }
  getSource(id) { return this.d.sources.find((s) => s.id === id) || null; }
  // Most recently opened first; never-opened keep their added order (stable sort).
  getSourcesByRecent() {
    return this.getSources().sort((a, b) => (this.d.lastUsed[b.id] || 0) - (this.d.lastUsed[a.id] || 0));
  }
  markUsed(id) { this.d.lastUsed[id] = Date.now(); this.save(); }
  addSource(s) { this.d.sources.push(s); this.save(); }
  replaceSource(s) { this.d.sources = this.d.sources.map((x) => (x.id === s.id ? s : x)); this.save(); }
  removeSource(id) {
    this.d.sources = this.d.sources.filter((s) => s.id !== id);
    for (const k of ["lastUsed", "favourites", "ezlist", "recent", "favlists", "starred", "hidden", "epgShift"]) if (this.d[k]) delete this.d[k][id];
    this.save();
  }

  // ---- favourites: the default "Favourites" list plus any number of named lists (re-filtered on every read) ----
  _extra(sid) { return (this.d.favlists[sid] = this.d.favlists[sid] || []); }
  _items(sid, listId) {
    if (!listId || listId === DEFAULT_LIST) return this.d.favourites[sid] || [];
    const l = this._extra(sid).find((x) => x.id === listId);
    if (!l) throw new Error("List not found");
    return l.items || [];
  }
  _setItems(sid, listId, arr) {
    const items = arr.map((c) => ({ name: c.name, url: c.url }));
    if (!listId || listId === DEFAULT_LIST) this.d.favourites[sid] = items;
    else this._extra(sid).find((x) => x.id === listId).items = items;
  }
  // -> [{ id, name, count }], the default list first, then the others in creation order
  listFavLists(sid) {
    const n = (id) => this.getFavourites(sid, id).length;
    return [{ id: DEFAULT_LIST, name: DEFAULT_LIST_NAME, count: n(DEFAULT_LIST) }]
      .concat(this._extra(sid).map((l) => ({ id: l.id, name: l.name, count: n(l.id) })));
  }
  _validName(sid, name, exceptId) {
    const n = String(name == null ? "" : name).trim();
    if (!n) throw new Error("Please enter a name");
    if (n.length > LIST_NAME_MAX) throw new Error(`Name can be at most ${LIST_NAME_MAX} characters`);
    const taken = [DEFAULT_LIST_NAME].concat(this._extra(sid).filter((l) => l.id !== exceptId).map((l) => l.name));
    if (taken.some((t) => t.toLowerCase() === n.toLowerCase())) throw new Error("A list with that name already exists");
    return n;
  }
  createFavList(sid, name) {
    const n = this._validName(sid, name);
    const l = { id: "l" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: n, items: [] };
    this._extra(sid).push(l);
    this.save();
    return { id: l.id, name: l.name };
  }
  renameFavList(sid, id, name) {
    if (id === DEFAULT_LIST) throw new Error("The default list can't be renamed");
    const l = this._extra(sid).find((x) => x.id === id);
    if (!l) throw new Error("List not found");
    l.name = this._validName(sid, name, id);
    this.save();
    return l.name;
  }
  deleteFavList(sid, id) {
    if (id === DEFAULT_LIST) throw new Error("The default list can't be deleted");
    this.d.favlists[sid] = this._extra(sid).filter((x) => x.id !== id);
    this.save();
  }
  getFavourites(sid, listId) {
    return AdultFilter.filterChannels(this._items(sid, listId).map((c) => ({ name: c.name, url: c.url, group: "" })));
  }
  toggleFavourite(sid, ch, listId) {
    const cur = this.getFavourites(sid, listId);
    const i = cur.findIndex((c) => c.url === ch.url);
    if (i >= 0) cur.splice(i, 1);
    else if (!AdultFilter.isBlocked(ch)) cur.push({ name: ch.name, url: ch.url, group: "" });
    this._setItems(sid, listId, cur);
    this.save();
    return cur.some((c) => c.url === ch.url); // false if it was blocked
  }
  // Adds the channels not already in the list (adult ones skipped) -> how many were added. Used by backup import.
  addFavourites(sid, listId, chs) {
    const cur = this.getFavourites(sid, listId);
    const have = new Set(cur.map((c) => c.url));
    let n = 0;
    for (const c of chs) {
      if (have.has(c.url) || AdultFilter.isBlocked(c)) continue;
      have.add(c.url); cur.push({ name: c.name, url: c.url, group: "" }); n++;
    }
    if (n) { this._setItems(sid, listId, cur); this.save(); }
    return n;
  }
  saveFavouritesOrder(sid, chs, listId) { this._setItems(sid, listId, chs); this.save(); }
  // ids of every list the channel is in / urls of every channel that is in any list (for the star on a row)
  favMembership(sid, url) {
    return this.listFavLists(sid).filter((l) => this.getFavourites(sid, l.id).some((c) => c.url === url)).map((l) => l.id);
  }
  allFavouriteUrls(sid) {
    const set = new Set();
    for (const l of this.listFavLists(sid)) for (const c of this.getFavourites(sid, l.id)) set.add(c.url);
    return [...set];
  }

  // ---- recently played: the last RECENT_MAX channels per source, most recent first ----
  getRecent(sid) {
    return AdultFilter.filterChannels((this.d.recent[sid] || []).map((c) => ({ name: c.name, url: c.url, group: "" })));
  }
  addRecent(sid, ch) {
    if (!ch || typeof ch.url !== "string" || typeof ch.name !== "string" || AdultFilter.isBlocked({ name: ch.name, group: "" })) return;
    const cur = (this.d.recent[sid] || []).filter((c) => c.url !== ch.url);
    cur.unshift({ name: ch.name, url: ch.url });
    this.d.recent[sid] = cur.slice(0, RECENT_MAX);
    this.save();
  }

  // ---- EZ List: 5 positional slots ----
  getEz(sid) {
    const out = new Array(EZ_SLOTS).fill(null);
    const arr = this.d.ezlist[sid] || [];
    for (let i = 0; i < Math.min(EZ_SLOTS, arr.length); i++) {
      const c = arr[i];
      if (c && !AdultFilter.isBlocked({ name: c.name, group: "" })) out[i] = { name: c.name, url: c.url, group: "" };
    }
    return out;
  }
  setEzSlot(sid, slot, ch) {
    if (slot < 0 || slot >= EZ_SLOTS || AdultFilter.isBlocked(ch)) return;
    const cur = this.getEz(sid);
    cur[slot] = { name: ch.name, url: ch.url, group: "" };
    this.d.ezlist[sid] = cur.map((c) => (c ? { name: c.name, url: c.url } : null));
    this.save();
  }

  // ---- saved stream URLs after a source login edit ----
  rewriteUrls(sid, oldPrefix, newPrefix) {
    const fix = (u) => (u.startsWith(oldPrefix) ? newPrefix + u.slice(oldPrefix.length) : u);
    this.d.favourites[sid] = (this.d.favourites[sid] || []).map((c) => ({ name: c.name, url: fix(c.url) }));
    this.d.ezlist[sid] = (this.d.ezlist[sid] || []).map((c) => (c ? { name: c.name, url: fix(c.url) } : null));
    this.d.recent[sid] = (this.d.recent[sid] || []).map((c) => ({ name: c.name, url: fix(c.url) }));
    for (const l of this.d.favlists[sid] || []) l.items = (l.items || []).map((c) => ({ name: c.name, url: fix(c.url) }));
    this.save();
  }

  // ---- starred categories (order = display order) / hidden categories ----
  getStarred(sid) { return (this.d.starred[sid] || []).slice(); }
  toggleStarred(sid, id) {
    const cur = this.getStarred(sid);
    const i = cur.indexOf(id);
    if (i >= 0) cur.splice(i, 1); else cur.push(id);
    this.d.starred[sid] = cur;
    this.save();
    return i < 0;
  }
  saveStarOrder(sid, ids) { this.d.starred[sid] = ids.slice(); this.save(); }
  getHidden(sid) { return (this.d.hidden[sid] || []).slice(); }
  setHidden(sid, ids) { this.d.hidden[sid] = ids.slice(); this.save(); }

  // ---- EPG shift: minutes added to every programme time of this source (+ = later, - = earlier) ----
  getEpgShift(sid) { const n = Number((this.d.epgShift || {})[sid]); return Number.isFinite(n) ? n : 0; }
  setEpgShift(sid, minutes) {
    const n = Math.max(-1440, Math.min(1440, Math.round(Number(minutes) || 0)));
    if (!this.d.epgShift) this.d.epgShift = {};
    if (n === 0) delete this.d.epgShift[sid]; else this.d.epgShift[sid] = n;
    this.save();
    return n;
  }

  // ---- UI prefs + session ----
  getUi() { return Object.assign({}, this.d.ui); }
  setUi(patch) { this.d.ui = Object.assign(this.d.ui, patch); this.save(); return this.getUi(); }
  getSession() { return this.d.session; }
  setSession(s) { this.d.session = s; this.save(); }
  clearSession() { if (this.d.session !== null) { this.d.session = null; this.save(); } }
}

module.exports = { Store, EZ_SLOTS };
