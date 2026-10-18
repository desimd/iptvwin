// Live + upcoming games (port of SportsRepository.kt). Two free, key-less sources, tried per league:
//   1. ESPN's public scoreboard JSON - good live data, one small request per league per day.
//   2. TheSportsDB (free key "3") as a backup if ESPN fails for that league - schedules are fine, but its free
//      tier has no real live feed, so "live" there is inferred from the event status and start time.
// Runs in the main process (the renderer's CSP blocks outside requests). Nothing is stored; no scores on purpose.
const { fetchText } = require("./http");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CONCURRENCY = 6;

// To cover another league, add ONE line here. path: ESPN "<sport>/<league>" slug; dbId: TheSportsDB league id;
// dur: typical game length in minutes (only used to guess when a game ended, for the Live tab).
const LEAGUES = [
  { id: "epl", label: "EPL", path: "soccer/eng.1", dbId: "4328", dur: 115 },
  { id: "ucl", label: "UCL", path: "soccer/uefa.champions", dbId: "4480", dur: 115 },
  { id: "uel", label: "UEL", path: "soccer/uefa.europa", dbId: "4481", dur: 115 },
  { id: "laliga", label: "LaLiga", path: "soccer/esp.1", dbId: "4335", dur: 115 },
  { id: "mls", label: "MLS", path: "soccer/usa.1", dbId: "4346", dur: 115 },
  { id: "nba", label: "NBA", path: "basketball/nba", dbId: "4387", dur: 150 },
  { id: "nhl", label: "NHL", path: "hockey/nhl", dbId: "4380", dur: 160 }
];

const FINISHED = new Set(["match finished", "ft", "aet", "pen", "finished", "after extra time", "after penalty", "final",
  "cancelled", "canceled", "canc", "postponed", "pst", "abandoned", "awarded", "walkover", "suspended", "match postponed"]);
const NOT_STARTED = new Set(["", "not started", "ns", "tbd", "tba", "time to be defined", "scheduled", "null"]);

// ---- helpers ----
const get = (url) => fetchText(url, UA);

// Runs async task functions with a small concurrency limit; each result is { ok, value | error }.
async function pool(tasks, limit = CONCURRENCY) {
  const out = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try { out[i] = { ok: true, value: await tasks[i]() }; } catch (e) { out[i] = { ok: false, error: e }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
// Device-local days from `from` to `to` days from today, as yyyymmdd.
function localDays(from, to) {
  const d = new Date();
  d.setDate(d.getDate() + from);
  const out = [];
  for (let o = from; o <= to; o++) { out.push(`${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`); d.setDate(d.getDate() + 1); }
  return out;
}
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// "2026-10-14T00:30Z", "...T00:30:00Z", "...T19:00:00" (no zone = UTC) -> ms | null
function parseUtc(s) {
  if (!s || s === "null") return null;
  let t = String(s).trim();
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
}

function describe(e) {
  const msg = e && e.message ? String(e.message).slice(0, 80) : "";
  return msg || (e && e.name) || "Error";
}

// ---- ESPN ----
// Pure: scoreboard JSON -> games. Upcoming / live ones, plus completed ones (flagged `finished`, for the Live tab's
// "30 min after the end"); postponed / cancelled are dropped.
function parseEspn(json, leagueId) {
  const events = (json && json.events) || [];
  const out = [];
  for (const e of events) {
    const state = e && e.status && e.status.type && e.status.type.state;
    const finished = state === "post" && !!(e.status.type.completed);
    if (state !== "pre" && state !== "in" && !finished) continue;
    const startMs = parseUtc(e.date);
    if (startMs === null) continue;
    const comps = e.competitions && e.competitions[0] && e.competitions[0].competitors;
    if (!Array.isArray(comps)) continue;
    let home = null, away = null;
    for (const c of comps) {
      const t = c && c.team;
      if (!t) continue;
      const team = { name: t.displayName || t.name || "TBD", abbr: t.abbreviation || "" };
      if (c.homeAway === "home") home = team; else away = team;
    }
    if (!home || !away) continue;
    out.push({ id: String(e.id), league: leagueId, startMs, live: state === "in", finished, home, away });
  }
  return out;
}

// One day (yyyymmdd), or the plain "current" scoreboard when date is null. ESPN rejects date RANGES (HTTP 400).
async function fetchEspn(league, date) {
  const base = `https://site.api.espn.com/apis/site/v2/sports/${league.path}/scoreboard`;
  const text = await get(date ? `${base}?dates=${date}&limit=300` : `${base}?limit=300`);
  return parseEspn(JSON.parse(text), league.id);
}

// ---- TheSportsDB (backup) ----
function dbStart(e) {
  const ts = e.strTimestamp;
  if (ts && ts !== "null") { const m = parseUtc(ts); if (m !== null) return m; }
  if (!e.dateEvent || e.dateEvent === "null") return null;
  return parseUtc(`${e.dateEvent}T${String(e.strTime || "00:00:00").slice(0, 8)}`);
}

async function fetchSportsDb(league) {
  const now = Date.now();
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const urls = [];
  for (let i = 0; i < 3; i++) { // yesterday, today, tomorrow
    urls.push(`https://www.thesportsdb.com/api/v1/json/3/eventsday.php?d=${isoDay(d)}&l=${league.dbId}`);
    d.setDate(d.getDate() + 1);
  }
  urls.push(`https://www.thesportsdb.com/api/v1/json/3/eventsnextleague.php?id=${league.dbId}`);
  const results = await pool(urls.map((u) => async () => JSON.parse(await get(u))), 4);
  if (!results.some((r) => r.ok)) throw (results[0].error || new Error("TheSportsDB unavailable"));
  const seen = new Set(), out = [];
  for (const r of results) {
    if (!r.ok || !Array.isArray(r.value.events)) continue;
    for (const e of r.value.events) {
      const id = String(e.idEvent);
      if (seen.has(id)) continue;
      seen.add(id);
      const startMs = dbStart(e);
      if (startMs === null) continue;
      const status = String(e.strStatus || "").trim().toLowerCase();
      if (FINISHED.has(status)) continue;
      const live = !NOT_STARTED.has(status) && startMs <= now + 5 * 60000 && now - startMs < 5 * 3600000;
      if (!live && startMs < now - 15 * 60000) continue; // old, status never updated
      out.push({ id, league: league.id, startMs, live, home: { name: e.strHomeTeam || "TBD", abbr: "" }, away: { name: e.strAwayTeam || "TBD", abbr: "" } });
    }
  }
  return out;
}

// ---- loads ----
const key = (g) => g.league + ":" + g.id;

// Phase 1: yesterday / today / tomorrow for every league (+ backup for leagues ESPN failed on), so the page fills
// in ~2 s. -> { games, failed, backup: [labels], error, okLeagues: [ids] }
async function loadNear() {
  const all = new Map(), okDays = new Map(LEAGUES.map((l) => [l.id, 0]));
  let error = null, failed = 0;
  const backup = [];
  const jobs = [];
  for (const l of LEAGUES) for (const d of localDays(-1, 1)) jobs.push({ l, run: () => fetchEspn(l, d) });
  const res = await pool(jobs.map((j) => j.run));
  res.forEach((r, i) => {
    const l = jobs[i].l;
    if (r.ok) { okDays.set(l.id, okDays.get(l.id) + 1); r.value.forEach((g) => all.set(key(g), g)); }
    else if (!error) error = describe(r.error);
  });
  for (const l of LEAGUES.filter((x) => okDays.get(x.id) === 0)) {
    try { (await fetchSportsDb(l)).forEach((g) => all.set(key(g), g)); backup.push(l.label); }
    catch (e) { failed++; }
  }
  return { games: [...all.values()], failed, backup, error, okLeagues: LEAGUES.filter((l) => okDays.get(l.id) > 0).map((l) => l.id) };
}

// Phase 2: the rest of the week (day +2 .. +7) for the leagues ESPN answered.
async function loadRest(leagueIds) {
  const ids = new Set(Array.isArray(leagueIds) ? leagueIds : []);
  const jobs = [];
  for (const l of LEAGUES.filter((x) => ids.has(x.id))) for (const d of localDays(2, 7)) jobs.push(() => fetchEspn(l, d));
  const res = await pool(jobs);
  const games = [];
  for (const r of res) if (r.ok) games.push(...r.value);
  return { games };
}

// Cheap refresh for the Live tab: each league's plain "current" scoreboard. null if every league failed.
async function loadLive() {
  const res = await pool(LEAGUES.map((l) => () => fetchEspn(l, null)));
  if (!res.some((r) => r.ok)) return null;
  const games = [];
  for (const r of res) if (r.ok) games.push(...r.value);
  return games;
}

module.exports = { LEAGUES, loadNear, loadRest, loadLive, parseEspn, parseUtc, key };
