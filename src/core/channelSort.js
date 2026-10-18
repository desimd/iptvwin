// Channel sorting (port of ChannelSort.kt). Applied once to an already-fetched list, never while
// scrolling, and never to the cache (which keeps the provider's order).
(function (root, factory) {
  const parser = (typeof module === 'object' && module.exports) ? require('./channelNameParser') : root.ChannelNameParser;
  if (typeof module === 'object' && module.exports) module.exports = factory(parser);
  else root.ChannelSort = factory(parser);
})(typeof self !== 'undefined' ? self : this, function (parser) {
  'use strict';

  const SORT_DEFAULT = 'default';
  const SORT_AZ = 'az';

  const isDigit = (c) => c >= '0' && c <= '9';

  // Digit runs compare as numbers, so "TSN 2" comes before "TSN 10".
  function naturalCompare(a, b) {
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const ca = a[i], cb = b[j];
      if (isDigit(ca) && isDigit(cb)) {
        let ei = i; while (ei < a.length && isDigit(a[ei])) ei++;
        let ej = j; while (ej < b.length && isDigit(b[ej])) ej++;
        const na = a.slice(i, ei).replace(/^0+/, '');
        const nb = b.slice(j, ej).replace(/^0+/, '');
        if (na.length !== nb.length) return na.length - nb.length;
        if (na !== nb) return na < nb ? -1 : 1;
        i = ei; j = ej;
      } else {
        if (ca !== cb) return ca < cb ? -1 : 1;
        i++; j++;
      }
    }
    return (a.length - i) - (b.length - j);
  }

  function apply(mode, list) {
    if (mode !== SORT_AZ || list.length < 2) return list;
    // Sort on the cleaned name, so "PK: GEO SUPER" files under G, not P. Keys are built once.
    const keys = list.map((c) => parser.parse(c.name).displayName.toLowerCase());
    return list.map((_, i) => i).sort((a, b) => naturalCompare(keys[a], keys[b])).map((i) => list[i]);
  }

  return { SORT_DEFAULT, SORT_AZ, apply, naturalCompare };
});
