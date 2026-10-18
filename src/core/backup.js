// Backup / restore of what you have curated, as one small JSON file (port of BackupManager.kt, same file format,
// so a backup made by the Android app can be imported here and the other way round):
//   per source: all favourite lists (with their channels), starred categories (in order), hidden categories,
//   the 5 EZ List slots and the EPG shift.
// By default the file holds no logins. Sources are matched by a hash of server + username (Xtream) or the playlist URL
// (M3U), and Xtream channel links are stored without the server / user / password part, so a backup still restores
// after a password change or on another device - add the source there first, then import.
// Optionally (includeLogins) each source's login is written too (IN PLAIN TEXT - the file's owner keeps it safe), and
// importing then re-creates sources that aren't on the device, exactly as they were. Importing only ever ADDS.
const crypto = require("crypto");
const xtream = require("./xtreamClient");
const { EZ_SLOTS } = require("./store");

const APP = "IPTVLite"; // kept so the Android app's backups and this one are interchangeable
const VERSION = 1;
const DEFAULT_ID = "default";

const pad = (n) => String(n).padStart(2, "0");
const day = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fileName = () => `IPTVLite-backup-${day()}.json`;

// Same source on another device / after a password change = same fingerprint.
function fingerprint(s) {
  const raw = s.type === "XTREAM"
    ? `x|${xtream.normalizeServer(s.server).toLowerCase()}|${String(s.user || "").trim().toLowerCase()}`
    : `m|${String(s.m3uUrl || "").trim()}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}
const prefixOf = (s) => (s.type === "XTREAM" ? xtream.streamPrefix(s.server, s.user, s.pass) : null);

function channelToJson(s, c) {
  const prefix = prefixOf(s);
  if (prefix && c.url.startsWith(prefix)) return { n: c.name, u: c.url.slice(prefix.length), r: 1 };
  return { n: c.name, u: c.url };
}
function channelFromJson(s, o) {
  const prefix = prefixOf(s);
  return { name: String(o.n), url: o.r === 1 && prefix ? prefix + String(o.u) : String(o.u), group: "" };
}

function exportBackup(store, includeLogins = false) {
  const sources = store.getSources().map((s) => ({
    fp: fingerprint(s),
    name: s.name,
    type: s.type,
    ...(includeLogins ? { login: { type: s.type, name: s.name, server: s.server || "", user: s.user || "", pass: s.pass || "", m3uUrl: s.m3uUrl || "", userAgent: s.userAgent || "" } } : {}),
    epg_shift_min: store.getEpgShift(s.id),
    favourite_lists: store.listFavLists(s.id).map((l) => ({
      id: l.id, name: l.name, channels: store.getFavourites(s.id, l.id).map((c) => channelToJson(s, c))
    })),
    starred: store.getStarred(s.id),
    hidden: store.getHidden(s.id),
    ez: store.getEz(s.id).map((c) => (c ? channelToJson(s, c) : null))
  }));
  const d = new Date();
  return JSON.stringify({ app: APP, version: VERSION, ...(includeLogins ? { has_logins: true } : {}), exported: `${day(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, sources }, null, 1);
}

function summary(r) {
  const plural = (n, one, many) => (n === 1 ? one : many);
  let sb = "";
  if (r.sources === 0) sb += "Nothing was imported.";
  else {
    sb += `Imported into ${r.sources} ${plural(r.sources, "source", "sources")}`;
    if (r.created > 0) sb += ` (${r.created} re-created from the file's logins)`;
    sb += ":\n";
    sb += `\u2022 ${r.channels} favourite ${plural(r.channels, "channel", "channels")} added`;
    if (r.listsCreated > 0) sb += ` (${r.listsCreated} new ${plural(r.listsCreated, "list", "lists")})`;
    sb += `\n\u2022 ${r.starred} starred ${plural(r.starred, "category", "categories")} added`;
    if (r.hidden > 0) sb += `\n\u2022 ${r.hidden} hidden ${plural(r.hidden, "category", "categories")} added`;
    if (r.ezSlots > 0) sb += `\n\u2022 ${r.ezSlots} EZ List ${plural(r.ezSlots, "slot", "slots")} filled`;
  }
  if (r.missing.length) {
    sb += `\n\nNot on this device, so skipped: ${r.missing.join(", ")}. Add ${r.missing.length === 1 ? "it" : "them"} first, then import again.`;
  }
  return sb;
}

function sourceFromLogin(l, defaultUa) {
  if (!l || typeof l !== "object") return null;
  const str = (v) => (typeof v === "string" ? v.trim() : "");
  const userAgent = str(l.userAgent) || defaultUa || "";
  if (l.type === "XTREAM") {
    const server = str(l.server), user = str(l.user), pass = str(l.pass);
    if (!server || !user || !pass) return null;
    return { id: crypto.randomUUID(), type: "XTREAM", name: str(l.name) || server.replace(/^https?:\/\//i, ""), server, user, pass, m3uUrl: "", userAgent };
  }
  if (l.type === "M3U") {
    const url = str(l.m3uUrl);
    if (!url) return null;
    let host = "M3U Playlist";
    try { host = new URL(url).host || host; } catch (e) { /* keep default */ }
    return { id: crypto.randomUUID(), type: "M3U", name: str(l.name) || host, server: "", user: "", pass: "", m3uUrl: url, userAgent };
  }
  return null;
}

// Merges the backup into this device's data. Throws for a file that is not one of ours.
function importBackup(store, text, opts = {}) {
  let root;
  try { root = JSON.parse(text); } catch (e) { root = null; }
  if (!root || typeof root !== "object" || root.app !== APP) throw new Error("That file is not an IPTV Lite backup");
  const local = new Map(store.getSources().map((s) => [fingerprint(s), s]));
  const r = { sources: 0, created: 0, listsCreated: 0, channels: 0, starred: 0, hidden: 0, ezSlots: 0, missing: [] };
  const arr = (v) => (Array.isArray(v) ? v : []);

  for (const o of arr(root.sources)) {
    if (!o || typeof o !== "object") continue;
    let s = local.get(o.fp);
    if (!s && o.login) { // the file carries the login: re-create the source (no network check, so it works offline)
      s = sourceFromLogin(o.login, opts.defaultUserAgent);
      if (s) { store.addSource(s); local.set(fingerprint(s), s); r.created++; }
    }
    if (!s) { r.missing.push(o.name || "a source"); continue; }
    r.sources++;

    // favourite lists: the default list merges into the default; others match by name (or are created)
    for (const l of arr(o.favourite_lists)) {
      if (!l || typeof l !== "object") continue;
      let listId = DEFAULT_ID;
      if (l.id !== DEFAULT_ID) {
        const name = String(l.name || "");
        const found = store.listFavLists(s.id).find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (found) listId = found.id;
        else {
          try { listId = store.createFavList(s.id, name).id; r.listsCreated++; } catch (e) { continue; } // bad / too long name
        }
      }
      const chs = arr(l.channels).filter((c) => c && c.n != null && c.u != null).map((c) => channelFromJson(s, c));
      r.channels += store.addFavourites(s.id, listId, chs);
    }

    // starred categories: keep the device's order, append new ones
    const starred = store.getStarred(s.id);
    let newStarred = 0;
    for (const id of arr(o.starred)) if (!starred.includes(String(id))) { starred.push(String(id)); newStarred++; }
    if (newStarred) store.saveStarOrder(s.id, starred);
    r.starred += newStarred;

    const hidden = new Set(store.getHidden(s.id));
    let newHidden = 0;
    for (const id of arr(o.hidden)) if (!hidden.has(String(id))) { hidden.add(String(id)); newHidden++; }
    if (newHidden) store.setHidden(s.id, [...hidden]);
    r.hidden += newHidden;

    // EZ List: only fills slots that are empty here
    const current = store.getEz(s.id);
    arr(o.ez).slice(0, EZ_SLOTS).forEach((c, slot) => {
      if (!current[slot] && c && c.n != null && c.u != null) { store.setEzSlot(s.id, slot, channelFromJson(s, c)); r.ezSlots++; }
    });

    const shift = Math.round(Number(o.epg_shift_min) || 0);
    if (shift !== 0 && store.getEpgShift(s.id) === 0) store.setEpgShift(s.id, shift);
  }
  r.summary = summary(r);
  return r;
}

module.exports = { fileName, exportBackup, importBackup, fingerprint };
