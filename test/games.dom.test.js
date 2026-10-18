// Smoke test of the Games page in a fake browser (jsdom): loads the real renderer scripts, feeds the screen canned
// sports data through a stub of the IPC bridge, and checks the Live / Upcoming tabs actually show cards.
// Skipped when jsdom isn't installed (npm i -D jsdom to run it).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
let JSDOM = null;
try { ({ JSDOM } = require("jsdom")); } catch (e) { /* skipped below */ }

const root = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test("games page renders live / upcoming cards from sports data", { skip: !JSDOM && "jsdom not installed" }, async () => {
  const dom = new JSDOM("<!doctype html><body><div id=\"progress\"></div><div id=\"toast\"></div></body>", { runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const MIN = 60000, now = Date.now();
  const g = (id, league, startMin, extra = {}) => ({ id, league, startMs: now + startMin * MIN, live: false, finished: false,
    home: { name: "Home " + id, abbr: "H" + id }, away: { name: "Away " + id, abbr: "A" + id }, ...extra });
  const near = { failed: 0, backup: [], error: null, okLeagues: ["epl", "nba"], games: [
    g("1", "epl", -50, { live: true }),                    // live now
    g("2", "nba", -150, { finished: true }),               // ended ~0 min ago (150 min game) -> still in window
    g("3", "epl", 20),                                     // starts in 20 min -> Live tab
    g("4", "epl", 180),                                    // 3 h -> Upcoming/Today (if not past midnight) or later
    g("5", "nba", -400, { finished: true })                // long over -> nowhere
  ] };
  const calls = [];
  w.api = { call: async (name, ...a) => {
    calls.push(name);
    if (name === "sports.leagues") return [{ id: "epl", label: "EPL", dur: 115 }, { id: "nba", label: "NBA", dur: 150 }];
    if (name === "sports.near") return near;
    if (name === "sports.rest") return { games: [g("6", "epl", 60 * 30)] };
    if (name === "sports.live") return near.games.filter((x) => x.live || x.id === "3");
    return null;
  } };
  w.App = { ui: { channelSort: "default" }, source: null };
  w.Nav = { stack: [], top: () => null, push() {}, back() {}, pop() {} };
  w.Screens = {};
  for (const f of ["renderer/js/dom.js", "src/core/channelSort.js", "src/core/gameWindow.js"]) w.eval(read(f));
  w.eval(read("renderer/js/games.js"));

  let screen = null;
  try {
  screen = w.Screens.games({ source: { id: "s1", name: "Src" } });
  w.document.body.append(screen.el);
  await screen.onShow();
  await tick(100);

  const cards = () => [...screen.el.querySelectorAll(".card.game")];
  const names = () => cards().map((c) => c.querySelector(".gm-name").textContent); // home team of each card
  assert.deepEqual(names().sort(), ["Home 1", "Home 2", "Home 3"], "Live tab: live + just-ended + starting soon");
  assert.ok(screen.el.querySelector(".gm-live"), "live badge");
  assert.ok(screen.el.querySelector(".gm-ended"), "ended badge");
  // Upcoming tab
  [...screen.el.querySelectorAll(".gm-tabs button")][1].click();
  await tick();
  const up = names().join(",");
  assert.ok(!/Home 1|Home 2|Home 3|Home 5/.test(up), "live-window and long-finished games are not in Upcoming: " + up);
  assert.ok(calls.includes("sports.rest"), "second phase ran");
  // 7-day view shows the later game too
  [...screen.el.querySelectorAll(".gm-days button")][2].click();
  await tick();
  assert.ok(names().includes("Home 6"), "next-7-days shows the later game");
  } finally { if (screen) screen.destroy(); w.close(); } // always stop the page timers, or node never exits
});
