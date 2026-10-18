// An M3U playlist seen as categories (port of M3uCatalog.kt): the group-titles are the categories, a category's
// id is its group name, channels with no group go to "Other", and a playlist with no groups at all gets one
// "All channels" entry. Pure functions over the parsed list.
const SearchTerms = require("./searchTerms");

const OTHER = "Other";
const ALL = "__ALL__";
const MAX_SEARCH = 500;

const groupOf = (c) => (c.group || "").trim() || OTHER;

// -> [{ id, name }] in order of first appearance
function categories(list) {
  const seen = new Map();
  let anyGroup = false;
  for (const c of list) {
    if ((c.group || "").trim()) anyGroup = true;
    const g = groupOf(c);
    if (!seen.has(g)) seen.set(g, { id: g, name: g });
  }
  if (!anyGroup) return list.length ? [{ id: ALL, name: "All channels" }] : [];
  return [...seen.values()];
}

function channelsOf(list, id) {
  if (id === ALL) return list;
  return list.filter((c) => groupOf(c) === id);
}

// Name search over the whole playlist (all words, any order; first MAX_SEARCH matches). Hits carry their
// category id so "Open category" can find them.
function search(list, query, hasGroups) {
  const words = SearchTerms.tokens(query);
  const out = [];
  for (const c of list) {
    if (!SearchTerms.matches(c.name, words)) continue;
    out.push({ name: c.name, url: c.url, group: c.group || "", catId: hasGroups ? groupOf(c) : ALL });
    if (out.length >= MAX_SEARCH) break;
  }
  return out;
}

const hasGroups = (list) => list.some((c) => (c.group || "").trim());

module.exports = { categories, channelsOf, search, hasGroups, OTHER, ALL, MAX_SEARCH };
