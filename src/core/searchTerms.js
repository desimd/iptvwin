// Search words (port of SearchTerms.kt). A query is split into words and a name matches when it contains
// EVERY word, in any order, with anything in between: "toronto new york" finds "NBA: Toronto Raptors vs New
// York Knicks". Case-insensitive; punctuation only separates words ("man.utd" = "man utd").
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SearchTerms = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const SPLIT = /[^\p{L}\p{N}]+/u;

function tokens(query) {
  const q = String(query == null ? "" : query);
  const words = [...new Set(q.toLowerCase().split(SPLIT).filter(Boolean))];
  if (words.length) return words;
  const t = q.trim().toLowerCase();
  return t ? [t] : []; // no letters/digits at all (e.g. "+"): match the text as typed
}

function matches(text, words) {
  const lower = String(text).toLowerCase();
  for (const w of words) if (!lower.includes(w)) return false;
  return true;
}

return { tokens, matches };
});
