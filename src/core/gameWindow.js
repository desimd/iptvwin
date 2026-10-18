// When a game belongs on the Games "Live" tab: from 30 min before it starts until 30 min after it ends.
// ESPN gives no end time, so a game's end is the moment we saw it flip from live to finished (g.endedAt); a game
// first seen already finished is estimated as start + a typical length for its sport. Pure; shared by the page and tests.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GameWindow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const WINDOW_MS = 30 * 60000;

  const endOf = (g, durMin) => g.endedAt || g.startMs + durMin * 60000;

  // g: { live, finished, startMs, endedAt? }.  durMin: typical length of this game's sport in minutes.
  function inLiveWindow(g, now, durMin) {
    if (g.finished) return now < endOf(g, durMin) + WINDOW_MS;
    if (g.live) return true;
    const toStart = g.startMs - now;
    return toStart <= WINDOW_MS && toStart > -WINDOW_MS; // about to start (or just past kick-off, not yet flagged live)
  }

  return { WINDOW_MS, endOf, inLiveWindow };
});
