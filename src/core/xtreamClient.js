// Xtream Codes player_api.php client (port of XtreamClient.kt).
const { fetchText } = require("./http");
const AdultFilter = require("./adultFilter");

const enc = encodeURIComponent;

function normalizeServer(server) {
  let s = String(server).trim();
  if (!/^https?:\/\//i.test(s)) s = "http://" + s;
  return s.replace(/\/+$/, "");
}

// Prefix shared by every live stream URL of an account - used to rewrite saved favourites / EZ URLs
// when a source is edited.
const streamPrefix = (server, user, pass) => `${normalizeServer(server)}/live/${enc(user)}/${enc(pass)}/`;

async function api(src, action, extra = "") {
  const url = `${normalizeServer(src.server)}/player_api.php?username=${enc(src.user)}&password=${enc(src.pass)}&action=${action}${extra}`;
  const text = await fetchText(url, src.userAgent);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error("The server did not return valid data (check the server address)"); }
  if (!Array.isArray(json)) throw new Error("The server did not return a list (check username and password)");
  return json;
}

// -> [{id, name}], adult categories already removed (fail-closed).
async function fetchCategories(src) {
  const json = await api(src, "get_live_categories");
  const out = json.filter((o) => o && o.category_id != null && o.category_name != null)
    .map((o) => ({ id: String(o.category_id), name: String(o.category_name) }));
  return AdultFilter.filterCategories(out);
}

function toChannel(src, o) {
  const streamId = String(o.stream_id);
  const name = o.name ? String(o.name) : `Channel ${streamId}`;
  const ext = o.container_extension ? String(o.container_extension) : "ts";
  const adultFlag = o.is_adult !== undefined && o.is_adult !== null ? String(o.is_adult) : null;
  if (AdultFilter.isBlockedChannel(name, "", adultFlag)) return null; // fail-closed
  return { name, url: `${streamPrefix(src.server, src.user, src.pass)}${enc(streamId)}.${ext}`, group: "" };
}

async function fetchChannels(src, categoryId) {
  const json = await api(src, "get_live_streams", categoryId ? `&category_id=${enc(categoryId)}` : "");
  const out = [];
  for (const o of json) {
    if (!o || o.stream_id == null) continue;
    const c = toChannel(src, o);
    if (c) out.push(c);
  }
  return out;
}

// Whole catalog, as raw rows for the search index.
async function fetchAllLive(src, onRow) {
  const json = await api(src, "get_live_streams");
  for (const o of json) {
    if (!o || o.stream_id == null) continue;
    const adultFlag = o.is_adult !== undefined && o.is_adult !== null ? String(o.is_adult) : null;
    onRow(String(o.stream_id), o.category_id != null ? String(o.category_id) : "",
      o.container_extension ? String(o.container_extension) : "ts",
      o.name ? String(o.name) : `Channel ${o.stream_id}`, adultFlag);
  }
}

// Xtream sends EPG titles base64-encoded; a few panels send plain text. Decode only when the result is
// clean UTF-8 text, so a plain title like "News" is never mangled.
function decodeEpgText(s) {
  if (s == null) return "";
  const raw = String(s).trim();
  if (raw.length >= 4 && raw.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(raw)) {
    try {
      const t = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "base64"));
      if (t && !/[\u0000-\u0008\u000e-\u001f\ufffd]/.test(t)) return t.trim();
    } catch (e) { /* not base64 text -> plain */ }
  }
  return raw;
}

function epgTime(ts, text) {
  const n = Number(ts);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  const t = Date.parse(String(text || "").replace(" ", "T")); // fallback: "YYYY-MM-DD HH:MM:SS" (panel time)
  return Number.isFinite(t) ? t : 0;
}

// Turns raw panel rows into [{title,start,stop}] (ms), shifted by shiftMs, dropping programmes that
// have already ended (after the shift is applied).
function parseEpgRows(rows, shiftMs) {
  const now = Date.now();
  const out = [];
  for (const r of rows) {
    if (!r) continue;
    const start = epgTime(r.start_timestamp, r.start), stop = epgTime(r.stop_timestamp, r.end);
    const title = decodeEpgText(r.title);
    if (!title || !start || !stop || stop <= start) continue;
    const s = start + shiftMs, e = stop + shiftMs;
    if (e <= now) continue;
    out.push({ title, start: s, stop: e });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

async function epgRequest(src, query) {
  const url = `${normalizeServer(src.server)}/player_api.php?username=${enc(src.user)}&password=${enc(src.pass)}&${query}`;
  const text = await fetchText(url, src.userAgent);
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error("The server did not return valid EPG data"); }
  return Array.isArray(json) ? json : (json && Array.isArray(json.epg_listings) ? json.epg_listings : []);
}

// Short EPG for one live stream: current + upcoming programmes only (action=get_short_epg).
// shiftMs moves every programme time (per-playlist "EPG shift"). With a shift the short list is not
// enough: a positive shift needs programmes that already started in the provider's clock, a negative
// one needs programmes further ahead. So the full table (get_simple_data_table) is used, with the
// short EPG (longer limit) as a fallback. -> [{title, start, stop}] in ms, sorted.
async function fetchShortEpg(src, streamId, limit = 2, shiftMs = 0) {
  if (!shiftMs) return parseEpgRows(await epgRequest(src, `action=get_short_epg&stream_id=${enc(streamId)}&limit=${limit}`), 0).slice(0, 4);
  try {
    const list = parseEpgRows(await epgRequest(src, `action=get_simple_data_table&stream_id=${enc(streamId)}`), shiftMs);
    if (list.length) return list.slice(0, 4);
  } catch (e) { /* fall back to the short EPG below */ }
  const extra = shiftMs < 0 ? Math.min(40, Math.ceil(-shiftMs / (30 * 60 * 1000))) : 0;
  return parseEpgRows(await epgRequest(src, `action=get_short_epg&stream_id=${enc(streamId)}&limit=${limit + extra}`), shiftMs).slice(0, 4);
}

module.exports = { normalizeServer, streamPrefix, fetchCategories, fetchChannels, fetchAllLive, fetchShortEpg, decodeEpgText };
