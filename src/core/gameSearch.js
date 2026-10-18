// "Find a stream for this game" (port of GameSearch.kt): turns a game into search words and runs them on the
// playlist in use. Channel names rarely match official team names ("AFC Bournemouth" vs "Bournemouth", "Toronto
// Raptors" vs "Toronto"), so it tries progressively looser searches and stops at the first that finds anything.
// Every search is the any-order, all-words match from searchTerms.
const { tokens } = require("./searchTerms");
const catalog = require("./m3uCatalog");

const MAX_RESULTS = 200;

// Club-name filler that streams leave out.
const NOISE = new Set(["fc", "afc", "cf", "sc", "sk", "ac", "as", "ssc", "rc", "ud", "cd", "sv", "fk", "bk", "if", "cfc", "the", "of", "de", "and", "club", "calcio"]);

// Two-word cities in the NBA / NHL, so "New York Knicks" -> "new york", not "new".
const TWO_WORD_CITIES = ["new york", "los angeles", "san antonio", "golden state", "oklahoma city", "new orleans", "san jose",
  "san francisco", "st louis", "las vegas", "tampa bay", "kansas city", "new jersey", "salt lake", "san diego"];

const cleaned = (name) => {
  const w = tokens(name);
  const f = w.filter((x) => !NOISE.has(x) && !(x.length <= 2 && /^\d+$/.test(x)));
  return f.length ? f : w;
};
const city = (name) => {
  const w = tokens(name).join(" ");
  return TWO_WORD_CITIES.find((c) => w.startsWith(c)) || w.split(" ")[0];
};
const nickname = (name) => tokens(name).slice(-1)[0] || "";
const longest = (arr, fallback) => arr.reduce((b, x) => (x.length > b.length ? x : b), "") || String(fallback).toLowerCase();

// The searches to try, loosest last. Each inner list is a group whose results are merged; first group with hits wins.
//   NBA / NHL:  "toronto new york" -> "raptors knicks" -> "raptors" + "knicks"
//   clubs:      "bournemouth sturm graz" -> "bournemouth sturm" -> "bournemouth" + "sturm"
function plan(game) {
  const home = game.home.name, away = game.away.name;
  let groups;
  if (game.league === "nba" || game.league === "nhl") {
    groups = [[`${city(home)} ${city(away)}`], [`${nickname(home)} ${nickname(away)}`], [nickname(home), nickname(away)]];
  } else {
    const ch = cleaned(home), ca = cleaned(away);
    const d1 = longest(ch, home), d2 = longest(ca, away);
    groups = [[ch.concat(ca).join(" ")], [`${d1} ${d2}`], [d1, d2]];
  }
  const seen = new Set(), out = [];
  for (const g of groups) {
    const clean = [...new Set(g.filter((x) => x && x.trim()))];
    const k = clean.join("\u0000");
    if (clean.length && !seen.has(k)) { seen.add(k); out.push(clean); }
  }
  return out;
}

// -> { label, firstQuery, channels } | null when nothing matched.
async function find(service, src, game) {
  let m3u = null;
  for (const group of plan(game)) {
    const merged = new Map();
    for (const q of group) {
      let r;
      if (src.type === "XTREAM") r = await service.search.query(src, q);
      else {
        if (!m3u) m3u = await service.loadList(src.id, { kind: "m3u" });
        r = catalog.search(m3u, q, catalog.hasGroups(m3u)); // hits carry their category (Open category)
      }
      for (const c of r) if (!merged.has(c.url)) merged.set(c.url, c);
    }
    if (merged.size) return { label: group.join(" / "), firstQuery: group[0], channels: [...merged.values()].slice(0, MAX_RESULTS) };
  }
  return null;
}

module.exports = { plan, find };
