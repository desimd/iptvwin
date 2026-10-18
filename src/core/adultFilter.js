// Centralized adult-content classifier (port of AdultContentFilter.kt).
// Every path that brings channel/category data in routes through here: Xtream fetches, M3U parsing,
// the on-disk cache (read AND write), favourites, EZ List, search results, and a final check right
// before playback. Fail-closed: blocked items are never added to any list, there is no PIN/reveal.
//
// Whole-token matching only (never substring), so "Essex"/"Sussex" are fine. Trade-off kept on
// purpose: a channel literally named "Sex and the City" is blocked too.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AdultFilter = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const BLOCKED_TOKENS = new Set([
    "adult", "xxx", "18+", "porn", "porno", "pornographic", "erotic", "sex", "nsfw"
    // Add localized terms here, e.g. "adulto", "erotik"
  ]);

  // Provider-specific category ids that slip past the keywords. Empty by default.
  const BLOCKED_CATEGORY_IDS = new Set([
    // "123",
  ]);

  function normalize(text) {
    let s = String(text).toLowerCase();
    try { s = s.normalize("NFD").replace(/\p{Mn}+/gu, ""); } catch (e) { /* nicety only */ }
    return s.replace(/[-_.|:/\\]/g, " ").replace(/\s+/g, " ").trim();
  }

  function containsBlockedKeyword(text) {
    if (!text || !String(text).trim()) return false;
    return normalize(text).split(" ").some((t) => BLOCKED_TOKENS.has(t));
  }

  // Xtream is_adult / M3U adult="..." flag. Absent = no signal. Present but unrecognised = blocked.
  function isExplicitAdultFlag(raw) {
    if (raw === null || raw === undefined) return false;
    switch (String(raw).trim().toLowerCase()) {
      case "0": case "false": case "no": case "": return false;
      case "1": case "true": case "yes": return true;
      default: return true;
    }
  }

  function isBlockedCategory(id, name) {
    if (BLOCKED_CATEGORY_IDS.has(String(id))) return true;
    return containsBlockedKeyword(name);
  }

  // Parse-time check (raw flag still available).
  function isBlockedChannel(name, group, adultFlag) {
    if (isExplicitAdultFlag(adultFlag)) return true;
    if (containsBlockedKeyword(name)) return true;
    if (group && String(group).trim() && containsBlockedKeyword(group)) return true;
    return false;
  }

  // Everywhere downstream (cache, favourites, EZ, search, pre-playback): keyword-only second layer.
  function isBlocked(channel) {
    return isBlockedChannel(channel.name, channel.group || "", null);
  }

  const filterCategories = (cats) => cats.filter((c) => !isBlockedCategory(c.id, c.name));
  const filterChannels = (chs) => chs.filter((c) => !isBlocked(c));

  return { isBlockedCategory, isBlockedChannel, isBlocked, filterCategories, filterChannels };
});
