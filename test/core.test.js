// Run with:  npm test   (Node built-in test runner, no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const AF = require("../src/core/adultFilter");
const P = require("../src/core/channelNameParser");
const S = require("../src/core/channelSort");
const m3u = require("../src/core/m3uParser");
const { Service } = require("../src/core/service");
const { createProxy } = require("../src/core/streamProxy");
const xtream = require("../src/core/xtreamClient");

// ---------- ported from AdultContentFilterTest.kt ----------
test("adult flag: truthy values blocked", () => {
  for (const v of ["1", "true", "TRUE", "yes"]) assert.ok(AF.isBlockedChannel("Normal Channel", "", v));
});
test("adult flag: falsy values / missing not blocked", () => {
  for (const v of ["0", "false", "no", null]) assert.ok(!AF.isBlockedChannel("Normal Channel", "", v));
});
test("adult flag: ambiguous fails closed", () => {
  assert.ok(AF.isBlockedChannel("Normal Channel", "", "maybe"));
  assert.ok(AF.isBlockedChannel("Normal Channel", "", "2"));
});
test("category names", () => {
  for (const n of ["XXX Movies", "Adult Channels", "18+ Late Night", "Erotic"]) assert.ok(AF.isBlockedCategory("1", n), n);
  for (const n of ["Sports HD", "News", "Kids Zone"]) assert.ok(!AF.isBlockedCategory("1", n), n);
});
test("channel names, case and punctuation", () => {
  for (const n of ["XXX Prime", "Porno HD", "NSFW Channel", "xXx HD", "ADULT.SWIM.CLONE", "NSFW-Content", "Sports|18+|Live", "  XXX  "]) {
    assert.ok(AF.isBlockedChannel(n), n);
  }
});
test("substring false positives are not blocked", () => {
  for (const n of ["Sussex News", "Essex TV", "Middlesex Local", "", "Sports HD"]) assert.ok(!AF.isBlockedChannel(n), n);
});
test("group keyword blocks clean name", () => assert.ok(AF.isBlockedChannel("Channel 1", "XXX")));
test("list filters", () => {
  assert.deepEqual(AF.filterCategories([{ id: "1", name: "Sports" }, { id: "2", name: "XXX Movies" }, { id: "3", name: "News" }]).map((c) => c.id), ["1", "3"]);
  assert.deepEqual(AF.filterChannels([{ name: "ESPN" }, { name: "XXX Prime" }, { name: "BBC One" }]).map((c) => c.name), ["ESPN", "BBC One"]);
});

// ---------- ported from ChannelNameParserTest.kt ----------
test("name parser cases", () => {
  let p = P.parse("UK \u2503 BBC ONE"); assert.equal(p.displayName, "BBC ONE"); assert.equal(p.country, "UK");
  p = P.parse("UK \u25CF BBC ONE \u1D34\u1D30"); assert.equal(p.displayName, "BBC ONE"); assert.equal(p.country, "UK"); assert.equal(p.quality, "HD");
  p = P.parse("PK: GEO SUPER \u1DA0\u1D34\u1D30"); assert.equal(p.displayName, "GEO SUPER"); assert.equal(p.quality, "FHD");
  p = P.parse("[JM] TVJ HQ"); assert.equal(p.displayName, "TVJ"); assert.equal(p.country, "JM");
  assert.equal(P.parse("ARY NEWS [LQ]").displayName, "ARY NEWS");
  assert.equal(P.parse("TEST CRICKET").displayName, "TEST CRICKET");
  assert.equal(P.parse("MULTI SPORTS").displayName, "MULTI SPORTS");
  assert.equal(P.parse("TEST CRICKET").country, null);
  assert.equal(P.parse("USA TODAY").country, null);
  assert.equal(P.parse("ABC: NEWS").country, null);
  assert.equal(P.parse("PK: GEO NEWS HD").tag, "PK \u00B7 HD");
});

test("natural sort", () => {
  const list = ["TSN 10", "PK: TSN 2", "bbc one", "TSN 1"].map((name) => ({ name }));
  assert.deepEqual(S.apply("az", list).map((c) => c.name), ["bbc one", "TSN 1", "PK: TSN 2", "TSN 10"]);
  assert.equal(S.apply("default", list), list);
});

// ---------- M3U ----------
test("m3u parser: groups, quoted commas, adult dropped", () => {
  const txt = [
    "#EXTM3U",
    "#EXTINF:-1 tvg-id=\"a\" group-title=\"News, World\",BBC World",
    "http://x/1.ts",
    "#EXTINF:-1 group-title=\"XXX\",Clean Name", "http://x/2.ts",
    "#EXTINF:-1 adult=\"1\",Other", "http://x/3.ts",
    "#EXTINF:-1,No Group", "http://x/4.m3u8"
  ].join("\r\n");
  const r = m3u.parseText(txt);
  assert.deepEqual(r.map((c) => c.name), ["BBC World", "No Group"]);
  assert.equal(r[0].group, "News, World");
});

// ---------- mock provider ----------
function startMock(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => resolve({ s, base: `http://127.0.0.1:${s.address().port}` }));
  });
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "taziptv-"));

test("xtream + service end to end", async () => {
  const seenUA = [];
  const { s, base } = await startMock((req, res) => {
    const u = new URL(req.url, base_);
    seenUA.push(req.headers["user-agent"]);
    if (u.pathname !== "/player_api.php") { res.writeHead(404); return res.end(); }
    if (u.searchParams.get("username") !== "me") { res.writeHead(200); return res.end("{\"user_info\":{\"auth\":0}}"); }
    const a = u.searchParams.get("action");
    let body;
    if (a === "get_live_categories") body = [{ category_id: 1, category_name: "Sports" }, { category_id: "2", category_name: "XXX" }, { category_id: "3", category_name: "News" }];
    else if (a === "get_live_streams") {
      const all = [
        { stream_id: 10, name: "PK: GEO SUPER HD", category_id: "1", container_extension: "ts" },
        { stream_id: 11, name: "Sky Sports 2", category_id: "1", container_extension: "m3u8", is_adult: 0 },
        { stream_id: 12, name: "Hidden", category_id: "1", is_adult: "1" },
        { stream_id: 13, name: "BBC One", category_id: "3" }
      ];
      const c = u.searchParams.get("category_id");
      body = c ? all.filter((x) => x.category_id === c) : all;
    }
    const gz = zlib.gzipSync(JSON.stringify(body));
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip" });
    res.end(gz);
  });
  const base_ = base;
  const dir = tmp();
  const svc = new Service(dir);

  await assert.rejects(svc.saveSource({ type: "XTREAM", server: base, user: "bad", pass: "x" }), /Failed to connect/);
  assert.equal(svc.listSources().length, 0);

  const src = await svc.saveSource({ type: "XTREAM", server: base.replace("http://", ""), user: "me", pass: "p@ss word", name: "Mock", userAgent: "TestUA/1" });
  assert.equal(svc.listSources().length, 1);
  assert.ok(seenUA.includes("TestUA/1"), "custom User-Agent is sent");

  const { categories } = await svc.getCategories(src.id);
  assert.deepEqual(categories.map((c) => c.name), ["Sports", "News"]); // XXX removed

  const sports = await svc.loadList(src.id, { kind: "category", id: "1" });
  assert.deepEqual(sports.map((c) => c.name), ["PK: GEO SUPER HD", "Sky Sports 2"]); // is_adult dropped
  assert.ok(sports[0].url.endsWith("/live/me/p%40ss%20word/10.ts"));
  assert.ok(sports[1].url.endsWith("/11.m3u8"));

  // starred categories get cached, others never
  assert.equal(svc.cache.getChannels(src.id, "1"), null);
  svc.toggleStar(src.id, "1");
  await svc.loadList(src.id, { kind: "category", id: "1" });
  assert.ok(svc.cache.getChannels(src.id, "1"));
  svc.toggleStar(src.id, "1");
  assert.equal(svc.cache.getChannels(src.id, "1"), null, "unstar drops cache");

  // search index: built on first search, adult never written, no credentials on disk
  const found = await svc.loadList(src.id, { kind: "search", query: "sky" });
  assert.deepEqual(found.map((c) => c.name), ["Sky Sports 2"]);
  assert.deepEqual(found.map((c) => c.catId), ["1"], "search hits carry their category id (Open category)");
  const bbc = await svc.loadList(src.id, { kind: "search", query: "bbc" });
  assert.equal(bbc[0].catId, "3");
  // the url a search hit carries is the same one the category list gives, so the channel can be found there
  assert.ok((await svc.loadList(src.id, { kind: "category", id: "3" })).some((c) => c.url === bbc[0].url));
  const idx = fs.readFileSync(svc.cache.searchIndexFile(src.id), "utf8");
  assert.ok(!idx.includes("Hidden") && !idx.includes("p@ss") && !idx.includes("http"));
  assert.equal((await svc.loadList(src.id, { kind: "search", query: "o" })).length, 3);

  // favourites + EZ list, per source, adult never added
  assert.equal(svc.store.toggleFavourite(src.id, sports[0]), true);
  assert.equal(svc.store.toggleFavourite(src.id, { name: "XXX Prime", url: "http://x" }), false);
  assert.deepEqual(svc.store.getFavourites(src.id).map((c) => c.name), ["PK: GEO SUPER HD"]);
  svc.store.setEzSlot(src.id, 2, sports[1]);
  assert.equal(svc.store.getEz(src.id)[2].name, "Sky Sports 2");
  assert.equal(svc.store.getEz(src.id)[0], null);

  // editing the login rewrites saved URLs, keeps id, clears cache
  const edited = await svc.saveSource({ id: src.id, type: "XTREAM", server: base, user: "me", pass: "newpass", name: "Mock", userAgent: "TestUA/1" });
  assert.equal(edited.id, src.id);
  assert.ok(svc.store.getFavourites(src.id)[0].url.includes("/live/me/newpass/10.ts"));
  assert.ok(svc.store.getEz(src.id)[2].url.includes("/live/me/newpass/11.m3u8"));
  assert.ok(!fs.existsSync(svc.cache.searchIndexFile(src.id)));

  // persistence across restart
  const again = new Service(dir);
  assert.equal(again.listSources().length, 1);
  assert.equal(again.store.getFavourites(src.id).length, 1);

  // remove wipes everything for the source
  again.removeSource(src.id);
  assert.equal(again.listSources().length, 0);
  assert.equal(again.store.getFavourites(src.id).length, 0);
  s.close();
});

test("m3u source is cached until refreshed", async () => {
  let hits = 0;
  const { s, base } = await startMock((req, res) => {
    hits++; res.writeHead(200); res.end("#EXTM3U\n#EXTINF:-1,One\nhttp://x/1\n#EXTINF:-1,Two\nhttp://x/2\n");
  });
  const svc = new Service(tmp());
  const src = await svc.saveSource({ type: "M3U", m3uUrl: base + "/list.m3u" });
  assert.equal(src.name, new URL(base).host);
  const before = hits;
  assert.equal((await svc.loadList(src.id, { kind: "m3u" })).length, 2); // downloads + caches
  assert.equal((await svc.loadList(src.id, { kind: "m3u" })).length, 2); // from cache
  assert.equal(hits, before + 1);
  svc.refreshSource(src.id);
  await svc.loadList(src.id, { kind: "m3u" });
  assert.equal(hits, before + 2);
  s.close();
});

// ---------- stream proxy ----------
test("proxy: UA, CORS, redirects, token, HLS rewrite, upstream abort", async () => {
  let upstreamClosed = false;
  const seen = {};
  const { s, base } = await startMock((req, res) => {
    seen[req.url] = req.headers["user-agent"];
    if (req.url === "/redir") { res.writeHead(302, { Location: "/live.ts" }); return res.end(); }
    if (req.url === "/live.ts") {
      res.writeHead(200, { "Content-Type": "video/mp2t" });
      res.write(Buffer.alloc(1000, 0x47));
      req.on("close", () => { upstreamClosed = true; });
      return; // never ends, like a live stream
    }
    if (req.url === "/notfound") { res.writeHead(404); return res.end(); }
    if (req.url.startsWith("/hls/master.m3u8")) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      return res.end("#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttp://other.example/seg2.ts\n");
    }
    if (req.url === "/noext") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("#EXTM3U\n#EXTINF:4,\nsegA.ts\n"); }
    res.writeHead(404); res.end();
  });
  const proxy = createProxy();
  const pbase = await proxy.start();
  const get = (u, extra = {}) => new Promise((resolve, reject) => {
    http.get(u, extra, (r) => resolve(r)).on("error", reject);
  });

  // redirect + UA + CORS + live streaming + abort
  const r = await get(proxy.proxify(base + "/redir", "MyUA/9"));
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["access-control-allow-origin"], "*");
  assert.equal(seen["/live.ts"], "MyUA/9");
  const first = await new Promise((res) => r.once("data", res));
  assert.ok(first.length > 0);
  r.destroy();
  await new Promise((res) => setTimeout(res, 300));
  assert.ok(upstreamClosed, "closing the player connection drops the upstream stream");

  // upstream error status passes through
  assert.equal((await get(proxy.proxify(base + "/notfound", "x"))).statusCode, 404);

  // wrong token / bad host / bad target
  assert.equal((await get(pbase.replace(/\/[0-9a-f]{32}$/, "/wrong") + "/p?u=" + encodeURIComponent(base))).statusCode, 404);
  assert.equal((await get(pbase + "/p?u=file%3A%2F%2F%2Fetc%2Fpasswd")).statusCode, 400);
  assert.equal((await get(pbase + "/p?u=" + encodeURIComponent(base + "/live.ts"), { headers: { Host: "evil.example" } })).statusCode, 403);

  // HLS: playlist rewritten so keys/segments also go through the proxy (relative + absolute)
  const body = await new Promise((resolve) => {
    get(proxy.proxify(base + "/hls/master.m3u8", "HlsUA/1")).then((m) => { let t = ""; m.on("data", (d) => (t += d)); m.on("end", () => resolve(t)); });
  });
  assert.ok(body.includes(pbase + "/p?u=" + encodeURIComponent(base + "/hls/key.bin")));
  assert.ok(body.includes(pbase + "/p?u=" + encodeURIComponent(base + "/hls/seg1.ts")));
  assert.ok(body.includes(pbase + "/p?u=" + encodeURIComponent("http://other.example/seg2.ts")));
  assert.ok(body.includes("ua=HlsUA%2F1"));
  // manifest detected by sniffing even without .m3u8 / mpegurl
  const sniff = await new Promise((resolve) => {
    get(proxy.proxify(base + "/noext", "x")).then((m) => { let t = ""; m.on("data", (d) => (t += d)); m.on("end", () => resolve(t)); });
  });
  assert.ok(sniff.includes("/p?u=" + encodeURIComponent(base + "/segA.ts")));

  proxy.close(); s.closeAllConnections?.(); s.close();
});

test("xtream normalizeServer", () => {
  assert.equal(xtream.normalizeServer(" host:8080/ "), "http://host:8080");
  assert.equal(xtream.normalizeServer("https://h.tv///"), "https://h.tv");
});

// ---------- EPG (Now / Next + prefetch) ----------
const { Epg, streamIdFromUrl } = require("../src/core/epg");

test("epg: stream id from url, base64 / plain titles", () => {
  assert.equal(streamIdFromUrl("http://h:80/live/me/p%40ss/1234.ts"), "1234");
  assert.equal(streamIdFromUrl("http://h/live/me/pw/77.m3u8?x=1"), "77");
  assert.equal(streamIdFromUrl("http://h/movie/me/pw/77.mp4"), null);
  assert.equal(streamIdFromUrl("http://x/1"), null);
  assert.equal(xtream.decodeEpgText(Buffer.from("Evening News \u00e9").toString("base64")), "Evening News \u00e9");
  assert.equal(xtream.decodeEpgText("News"), "News");          // looks like base64, isn't
  assert.equal(xtream.decodeEpgText("Test"), "Test");
  assert.equal(xtream.decodeEpgText("Match of the Day"), "Match of the Day");
});

test("epg: now/next selection and cache behaviour", async () => {
  const t0 = Date.now();
  const min = 60000;
  let calls = 0;
  const e = new Epg(async (src, id) => {
    calls++;
    return [{ title: "A", start: t0 - 10 * min, stop: t0 + 20 * min }, { title: "B", start: t0 + 20 * min, stop: t0 + 50 * min }];
  });
  const src = { id: "s1" };
  const url = "http://h/live/u/p/5.ts";
  const [a, b] = await Promise.all([e.get(src, url), e.get(src, url)]); // concurrent -> one request
  assert.equal(calls, 1);
  assert.equal(a.now.title, "A"); assert.equal(a.next.title, "B"); assert.equal(a.after, null); assert.deepEqual(a, b);
  await e.get(src, url);
  assert.equal(calls, 1, "second read served from cache");
  assert.equal(await e.get(src, "http://x/1"), null);

  // programme ended -> entry refetched
  const old = new Epg(async () => { calls++; return []; });
  old.map.set("s1|9", { listings: [{ title: "Gone", start: t0 - 60 * min, stop: t0 - 30 * min }], at: Date.now(), failed: false });
  await old.get(src, "http://h/live/u/p/9.ts");
  assert.equal(calls, 2);

  // failure is remembered briefly and never throws
  const bad = new Epg(async () => { throw new Error("boom"); });
  assert.deepEqual(await bad.get(src, url), { now: null, next: null, after: null });
});

test("epg: view gives now / next / after next", () => {
  const t = 1000000, m = 60000;
  const L = [{ title: "C", start: t + 60 * m, stop: t + 90 * m }, { title: "A", start: t - 5 * m, stop: t + 30 * m }, { title: "B", start: t + 30 * m, stop: t + 60 * m }];
  const v = Epg.view(L, t);
  assert.deepEqual([v.now.title, v.next.title, v.after.title], ["A", "B", "C"]);
  const gap = Epg.view([{ title: "X", start: t + 10 * m, stop: t + 20 * m }, { title: "Y", start: t + 20 * m, stop: t + 30 * m }], t);
  assert.equal(gap.now, null); assert.deepEqual([gap.next.title, gap.after.title], ["X", "Y"]);
  assert.deepEqual(Epg.view([], t), { now: null, next: null, after: null });
});

test("epg: prefetch warms in order, skips fresh, newer call supersedes", async () => {
  const t0 = Date.now(), seen = [];
  const e = new Epg(async (src, id) => { seen.push(id); return [{ title: "P" + id, start: t0 - 1000, stop: t0 + 600000 }]; });
  const src = { id: "s1" };
  const u = (n) => `http://h/live/u/p/${n}.ts`;
  await e.get(src, u(2));                        // already cached
  seen.length = 0;
  e.prefetch(src, [u(1), u(2), u(3), u(4)]);
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(seen, ["1", "3", "4"]);
  assert.equal((await e.get(src, u(3))).now.title, "P3");
  assert.equal(seen.length, 3, "prefetched channel needs no new request");

  seen.length = 0;
  e.prefetch(src, [u(10), u(11), u(12), u(13)]);
  await new Promise((r) => setTimeout(r, 20));
  e.prefetch(src, [u(20)]);                       // viewer moved on
  await new Promise((r) => setTimeout(r, 700));
  assert.ok(seen.includes("20") && !seen.includes("13"), "old prefetch abandoned: " + seen);
});

test("epg: xtream get_short_epg through the service", async () => {
  const when = Math.floor(Date.now() / 1000);
  let epgCalls = 0;
  const { s, base } = await startMock((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/x.m3u") { res.writeHead(200); return res.end("#EXTM3U\n#EXTINF:-1,One\nhttp://x/live/a/b/1.ts\n"); }
    const a = u.searchParams.get("action");
    let body = [];
    if (a === "get_live_categories") body = [{ category_id: 1, category_name: "News" }];
    else if (a === "get_short_epg") {
      epgCalls++;
      assert.equal(u.searchParams.get("stream_id"), "10");
      assert.equal(u.searchParams.get("limit"), "3");
      body = { epg_listings: [
        { title: Buffer.from("Morning Show").toString("base64"), start_timestamp: String(when - 600), stop_timestamp: String(when + 1200) },
        { title: Buffer.from("Weather").toString("base64"), start_timestamp: String(when + 1200), stop_timestamp: String(when + 2400) }
      ] };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const svc = new Service(tmp());
  const src = await svc.saveSource({ type: "XTREAM", server: base, user: "me", pass: "pw" });
  const url = `${base}/live/me/pw/10.ts`;
  const r = await svc.getEpg(src.id, url);
  assert.equal(r.now.title, "Morning Show");
  assert.equal(r.next.title, "Weather");
  await svc.getEpg(src.id, url);
  assert.equal(epgCalls, 1);
  const m3 = await svc.saveSource({ type: "M3U", m3uUrl: base + "/x.m3u" });
  assert.equal(await svc.getEpg(m3.id, "http://x/live/a/b/1.ts"), null, "M3U sources have no Xtream EPG");
  svc.prefetchEpg(m3.id, ["http://x/live/a/b/1.ts"]); // no-op, must not throw
  assert.equal(epgCalls, 1);
  svc.removeSource(src.id);
  assert.equal(svc.epg.map.size, 0, "cache dropped with the source");
  s.close();
});

test("epg shift: per playlist, persisted, applied to now/next, cache refetched", async () => {
  const t0 = Math.floor(Date.now() / 1000);
  const H = 3600;
  const calls = [];
  const { s, base } = await startMock((req, res) => {
    const u = new URL(req.url, "http://x");
    const a = u.searchParams.get("action");
    calls.push(a);
    let body = [];
    if (a === "get_live_categories") body = [{ category_id: 1, category_name: "News" }];
    else if (a === "get_short_epg") {
      body = { epg_listings: [
        { title: "A", start_timestamp: String(t0 - 600), stop_timestamp: String(t0 + 1200) },
        { title: "B", start_timestamp: String(t0 + 1200), stop_timestamp: String(t0 + 2400) }
      ] };
    } else if (a === "get_simple_data_table") {
      // provider clock: programmes every hour, from 4h ago to 4h ahead
      const listings = [];
      for (let i = -4; i < 4; i++) listings.push({ title: "P" + i, start_timestamp: String(t0 + i * H), stop_timestamp: String(t0 + (i + 1) * H) });
      body = { epg_listings: listings };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const dir = tmp();
  const svc = new Service(dir);
  const one = await svc.saveSource({ type: "XTREAM", server: base, user: "me", pass: "pw", name: "one" });
  const two = await svc.saveSource({ type: "XTREAM", server: base, user: "you", pass: "pw", name: "two" });
  const url1 = `${base}/live/me/pw/10.ts`, url2 = `${base}/live/you/pw/10.ts`;

  assert.equal(svc.getEpgShift(one.id), 0);
  assert.equal((await svc.getEpg(one.id, url1)).now.title, "A"); // no shift: short EPG, as before
  await svc.getEpg(two.id, url2);

  // +2h: programmes move later, so what airs now is what the provider listed 2h earlier
  assert.equal(svc.setEpgShift(one.id, 120), 120);
  const r = await svc.getEpg(one.id, url1);
  assert.equal(r.now.title, "P-2");
  assert.equal(r.next.title, "P-1");
  assert.ok(r.now.start <= Date.now() && Date.now() < r.now.stop);

  // -2h: programmes move earlier
  svc.setEpgShift(one.id, -120);
  assert.equal((await svc.getEpg(one.id, url1)).now.title, "P2");

  // other playlist untouched (still cached, unshifted)
  assert.equal(svc.getEpgShift(two.id), 0);
  assert.equal((await svc.getEpg(two.id, url2)).now.title, "A");

  // persisted, clamped, removed with the source
  assert.equal(new Service(dir).getEpgShift(one.id), -120);
  assert.equal(svc.setEpgShift(one.id, 99999), 1440);
  svc.setEpgShift(one.id, 0);
  assert.equal((await svc.getEpg(one.id, url1)).now.title, "A");
  svc.setEpgShift(one.id, 60);
  svc.removeSource(one.id);
  assert.equal(svc.store.d.epgShift[one.id], undefined);

  // editing a source keeps its shift
  svc.setEpgShift(two.id, 30);
  await svc.saveSource({ id: two.id, type: "XTREAM", server: base, user: "you", pass: "pw", name: "two renamed" });
  assert.equal(svc.getEpgShift(two.id), 30);
  s.close();
});

test("stream stats: true values formatted for the player bar", () => {
  const S = require("../src/core/streamStats");
  assert.equal(S.qualityLabel(1920, 1080), "1080p");
  assert.equal(S.qualityLabel(1920, 1088), "1080p");
  assert.equal(S.qualityLabel(1280, 720), "720p");
  assert.equal(S.qualityLabel(1920, 800), "800p"); // true height, not a guess
  assert.equal(S.qualityLabel(3840, 2160), "4K");
  assert.equal(S.qualityLabel(0, 0), "");
  assert.equal(S.codecName("avc1.640028"), "H.264");
  assert.equal(S.codecName("hvc1.1.6.L93.B0"), "H.265");
  assert.equal(S.codecName("hev1.1.6.L120.90"), "H.265");
  assert.equal(S.codecName("av01.0.08M.08"), "AV1");
  assert.equal(S.codecName("avc1.640028,mp4a.40.2"), "H.264");
  assert.equal(S.codecName(""), "");
  assert.equal(S.bitrateText(6.2e6), "6.2 Mbps");
  assert.equal(S.bitrateText(850e3), "850 kbps");
  assert.equal(S.bitrateText(0), "");
  assert.equal(S.fpsText(49.97), "50 fps");
  assert.equal(S.fpsText(0), "");

  // sliding window: 50 fps and 6 Mbps worth of bytes (750 000 B/s), sampled each second
  const sm = new S.Sampler(4000);
  for (let i = 0; i <= 3; i++) sm.push(i * 1000, i * 50, i * 750000);
  const r = sm.rates();
  assert.ok(Math.abs(r.fps - 50) < 0.01 && Math.abs(r.bps - 6e6) < 1);
  // too little data yet -> unknown, not a wrong number
  const early = new S.Sampler(); early.push(0, 0, 0); early.push(1000, 50, 750000);
  assert.deepEqual(early.rates(), { fps: 0, bps: 0 });
  // counters going backwards (new stream) restart the window
  sm.push(4000, 3, 1000);
  assert.deepEqual(sm.rates(), { fps: 0, bps: 0 });
  // no byte counter available -> fps still works, bitrate unknown
  const nb = new S.Sampler(); for (let i = 0; i <= 3; i++) nb.push(i * 1000, i * 25, null);
  assert.ok(Math.abs(nb.rates().fps - 25) < 0.01 && nb.rates().bps === 0);

  // summary: measured wins, engine values are the fallback, nothing is invented
  const full = S.summarize({ width: 1920, height: 1080 }, { fps: 50.02, bps: 6.2e6 }, { codec: "avc1.640028" });
  assert.equal(full.video, "1080p \u00B7 50 fps \u00B7 H.264");
  assert.equal(full.bitrate, "6.2 Mbps");
  assert.ok(full.title.includes("1920\u00D71080"));
  const fb = S.summarize({ width: 1280, height: 720 }, { fps: 0, bps: 0 }, { codec: "hvc1.1.6.L93.B0", fps: 25, bps: 2.5e6 });
  assert.equal(fb.video, "720p \u00B7 25 fps \u00B7 H.265");
  assert.equal(fb.bitrate, "2.5 Mbps");
  const none = S.summarize({ width: 0, height: 0 }, {}, {});
  assert.deepEqual(none, { video: "", bitrate: "", title: "" });
  assert.equal(S.summarize({ width: 1280, height: 720 }, {}, {}).video, "720p"); // only what is really known
});

test("stream diagnosis: says whether it is the codec or something else", () => {
  const S = require("../src/core/streamStats");
  const supports = (set) => (t) => set.some((x) => t.includes(x));
  const okAll = supports(["avc1", "mp4a", "mpeg"]);
  assert.equal(S.audioName("mp4a.40.2"), "AAC");
  assert.equal(S.audioName("ac-3"), "AC-3");
  assert.equal(S.audioName("ec-3"), "E-AC-3");
  assert.equal(S.audioName("mp3"), "MP3");

  // H.265 not decodable here
  let d = S.diagnose({ codec: "hvc1.1.6.L93.B0", audioCodec: "mp4a.40.2" }, okAll);
  assert.equal(d.problems.length, 1);
  assert.ok(d.text.includes("H.265") && d.text.includes("can't decode the video"));
  // AC-3 audio not decodable here, video fine
  d = S.diagnose({ codec: "avc1.640028", audioCodec: "ac-3" }, okAll);
  assert.equal(d.problems.length, 1);
  assert.ok(d.text.includes("AC-3") && d.text.includes("audio"));
  // both fine -> not a codec problem, says so
  d = S.diagnose({ codec: "avc1.640028", audioCodec: "mp4a.40.2" }, okAll);
  assert.deepEqual(d.problems, []);
  assert.ok(d.text.includes("Video: H.264") && d.text.includes("Audio: AAC") && d.text.includes("stream or provider"));
  // sound but no decodable video (e.g. MPEG-2 video)
  d = S.diagnose({ hasVideo: false, hasAudio: true, audioCodec: "mp3" }, okAll);
  assert.ok(d.text.includes("no video"));
  // nothing known -> no claim
  assert.equal(S.diagnose({}, okAll).text, "");
  assert.equal(S.diagnose(null, null).text, "");
  // audio shows in the tooltip
  assert.ok(S.summarize({ width: 1280, height: 720 }, {}, { codec: "avc1.64001f", audioCodec: "ac-3" }).title.includes("Audio: AC-3"));
});

test("proxy probe: says what the address really serves, reuses the connection, reports provider messages", async () => {
  const { classify } = require("../src/core/streamProxy");
  let hits = {};
  const s = http.createServer((req, res) => {
    hits[req.url] = (hits[req.url] || 0) + 1;
    if (req.url === "/ts") { res.writeHead(200, { "Content-Type": "text/plain" }); const b = Buffer.alloc(376, 0); b[0] = 0x47; b[188] = 0x47; res.write(b); return; } // lies about its type, never ends
    if (req.url === "/hls.m3u8") { res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }); return res.end("#EXTM3U\n#EXTINF:4,\nseg.ts\n"); }
    if (req.url === "/fake.m3u8") { res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" }); return res.end("<html><body>Max connections reached</body></html>"); }
    if (req.url === "/empty") { res.writeHead(200, { "Content-Type": "video/mp2t" }); return res.end(); }
    if (req.url === "/msg") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<h1>Account expired</h1>"); }
    if (req.url === "/denied") { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("Forbidden for this device"); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const proxy = createProxy();
  const pbase = await proxy.start();
  const getJson = (u) => new Promise((resolve, reject) => http.get(u, (r) => { let t = ""; r.on("data", (d) => (t += d)); r.on("end", () => resolve(JSON.parse(t))); }).on("error", reject));
  const probe = (path) => getJson(`${pbase}/probe?u=${encodeURIComponent(base + path)}&ua=T`);

  const tsProbe = await probe("/ts");
  assert.equal(tsProbe.kind, "ts");                         // judged by its bytes, not its Content-Type
  assert.equal(tsProbe.bytes, 376);
  assert.ok(tsProbe.head.startsWith("47 00 00"));
  assert.equal((await probe("/hls.m3u8")).kind, "hls");
  const fake = await probe("/fake.m3u8");                  // promised a playlist, sent a web page
  assert.equal(fake.kind, "text");
  assert.ok(fake.text.includes("Max connections reached"));
  const msg = await probe("/msg");
  assert.equal(msg.kind, "text");
  assert.equal(msg.text, "Account expired");
  const empty = await probe("/empty");
  assert.equal(empty.status, 200);
  assert.equal(empty.bytes, 0);
  const denied = await probe("/denied");
  assert.equal(denied.status, 403);
  assert.equal(denied.kind, "error");
  assert.ok(denied.text.includes("Forbidden"));
  assert.ok((await probe("/nope")).status === 404);
  assert.ok((await getJson(`${pbase}/probe?u=${encodeURIComponent("http://127.0.0.1:1/x")}&ua=T`)).error, "unreachable provider is reported");

  // the player's next request reuses the probed connection: the provider sees ONE request
  hits = {};
  await probe("/ts");
  const r = await new Promise((resolve, reject) => http.get(proxy.proxify(base + "/ts", "T"), resolve).on("error", reject));
  assert.equal(r.statusCode, 200);
  const first = await new Promise((res) => r.once("data", res));
  assert.equal(first[0], 0x47);
  assert.equal(hits["/ts"], 1, "probe + play = a single connection to the provider");
  r.destroy();

  // an abandoned probe is dropped on request
  hits = {};
  await probe("/ts");
  await new Promise((resolve) => http.get(`${pbase}/drop?u=${encodeURIComponent(base + "/ts")}&ua=T`, (d) => { d.resume(); resolve(); }));
  const r2 = await new Promise((resolve, reject) => http.get(proxy.proxify(base + "/ts", "T"), resolve).on("error", reject));
  await new Promise((res) => r2.once("data", res));
  assert.equal(hits["/ts"], 2, "after drop the player opens a fresh connection");
  r2.destroy();

  assert.equal(classify({}, "", Buffer.from("\ufeff#EXTM3U\n")), "hls" /* BOM tolerated */);
  proxy.close(); s.closeAllConnections?.(); s.close();
});

// ---------- Download as M3U ----------
const { exportPlaylist, entry, safeFileName } = require("../src/core/m3uExport");

test("m3u export: compact entries, ordered output, progress, retry, skip, cancel", async () => {
  assert.equal(entry("BBC One", "News", "http://h/live/u/p/1.ts"), '#EXTINF:-1 group-title="News",BBC One\nhttp://h/live/u/p/1.ts\n');
  assert.equal(entry("A\nB, C", 'Say "hi"', "http://x/2.ts"), "#EXTINF:-1 group-title=\"Say 'hi'\",A B, C\nhttp://x/2.ts\n");
  assert.equal(entry("No group", "", "http://x/3.ts"), "#EXTINF:-1,No group\nhttp://x/3.ts\n");
  assert.equal(safeFileName('My: "list"/1'), "My list 1");
  assert.equal(safeFileName(""), "playlist");

  const mk = (g, n) => ({ group: g, load: async () => Array.from({ length: n }, (_, i) => ({ name: `${g}${i}`, url: `http://h/${g}${i}.ts` })) });
  let out = "";
  const seen = [];
  const r = await exportPlaylist([mk("A", 2), mk("B", 3), mk("C", 1), mk("D", 1)], { write: (t) => (out += t), onProgress: (p) => seen.push(p), concurrency: 2 });
  assert.equal(r.channels, 7);
  assert.deepEqual(r.skipped, []);
  assert.ok(out.startsWith("#EXTM3U\n"));
  assert.ok(out.indexOf("A0") < out.indexOf("B0") && out.indexOf("B2") < out.indexOf("C0") && out.indexOf("C0") < out.indexOf("D0"), "written in category order");
  assert.deepEqual(seen.map((p) => p.done), [0, 2, 4]);
  assert.equal(seen[seen.length - 1].channels, 7);
  assert.equal(seen[seen.length - 1].total, 4);

  // a category that fails once is retried; one that keeps failing is skipped and reported
  let tries = 0;
  out = "";
  const r2 = await exportPlaylist([
    { group: "Flaky", load: async () => { if (tries++ === 0) throw new Error("boom"); return [{ name: "x", url: "http://h/x.ts" }]; } },
    { group: "Dead", load: async () => { throw new Error("down"); } },
    { group: "Empty", load: async () => [] }
  ], { write: (t) => (out += t) });
  assert.equal(r2.channels, 1);
  assert.deepEqual(r2.skipped, ["Dead"]);
  assert.ok(out.includes("Flaky") && !out.includes("Empty"));

  // cancel between steps
  let stop = false;
  await assert.rejects(
    exportPlaylist([mk("A", 1), mk("B", 1), mk("C", 1)], { write() {}, concurrency: 1, onProgress: (p) => { if (p.done === 1) stop = true; }, isCancelled: () => stop }),
    (e) => e.cancelled === true
  );
});

test("m3u export through the service: only selected categories, adult dropped, temp file handled", async () => {
  const { s, base } = await startMock((req, res) => {
    const u = new URL(req.url, "http://x");
    const a = u.searchParams.get("action");
    let body = [];
    if (a === "get_live_categories") body = [{ category_id: "1", category_name: "News" }, { category_id: "2", category_name: "Sports" }, { category_id: "3", category_name: "Movies" }, { category_id: "4", category_name: "XXX Night" }];
    else if (a === "get_live_streams") {
      const cat = u.searchParams.get("category_id");
      if (cat === "3") { res.writeHead(500); return res.end("nope"); }
      body = { 1: [{ stream_id: 10, name: "BBC News" }, { stream_id: 11, name: "XXX Prime" }], 2: [{ stream_id: 20, name: "Sky Sports", container_extension: "m3u8" }] }[cat] || [];
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  const dir = tmp();
  const svc = new Service(dir);
  const src = await svc.saveSource({ type: "XTREAM", server: base, user: "me", pass: "pw", name: "Mock" });
  const file = path.join(dir, "out.m3u");

  // Manage categories: hide Sports. Movies fails on the server -> skipped, not fatal.
  svc.store.setHidden(src.id, ["2"]);
  const prog = [];
  const r = await svc.exportM3u(src.id, file, { onProgress: (p) => prog.push(p) });
  assert.equal(r.channels, 1);                       // BBC News only: Sports hidden, XXX Prime blocked, Movies failed
  assert.deepEqual(r.skipped, ["Movies"]);
  assert.equal(r.categories, 1);
  const txt = fs.readFileSync(file, "utf8");
  assert.equal(txt, `#EXTM3U\n#EXTINF:-1 group-title="News",BBC News\n${base}/live/me/pw/10.ts\n`);
  assert.ok(!fs.existsSync(file + ".part"), "temp file renamed away");
  assert.equal(r.bytes, Buffer.byteLength(txt));
  assert.ok(prog.length >= 2 && prog[prog.length - 1].done === prog[prog.length - 1].total);

  // everything selected again -> Sports comes back with its own extension
  svc.store.setHidden(src.id, []);
  const r2 = await svc.exportM3u(src.id, file);
  assert.equal(r2.channels, 2);
  assert.ok(fs.readFileSync(file, "utf8").includes('group-title="Sports",Sky Sports\n' + base + "/live/me/pw/20.m3u8"));

  // cancelled: nothing is left behind, an older file is untouched
  const before = fs.readFileSync(file, "utf8");
  const c = await svc.exportM3u(src.id, file, { isCancelled: () => true });
  assert.deepEqual(c, { cancelled: true });
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.ok(!fs.existsSync(file + ".part"));

  // nothing selected -> clear message
  svc.store.setHidden(src.id, ["1", "2", "3", "4"]);
  await assert.rejects(svc.exportM3u(src.id, file), /No categories are selected/);
  s.close();
});

// ---------- games (port of the Android sports page) ----------
test("search terms: all words, any order, punctuation separates", () => {
  const T = require("../src/core/searchTerms");
  assert.deepEqual(T.tokens("Man.Utd  man"), ["man", "utd"]);
  assert.deepEqual(T.tokens(" + "), ["+"]);
  assert.ok(T.matches("NBA: Toronto Raptors vs New York Knicks", T.tokens("toronto new york")));
  assert.ok(!T.matches("NBA: Toronto Raptors", T.tokens("toronto knicks")));
});

test("game search plan: clubs and NBA/NHL, loosest last", () => {
  const { plan } = require("../src/core/gameSearch");
  const g = (league, home, away) => ({ league, home: { name: home }, away: { name: away } });
  assert.deepEqual(plan(g("epl", "AFC Bournemouth", "SK Sturm Graz")), [["bournemouth sturm graz"], ["bournemouth sturm"], ["bournemouth", "sturm"]]);
  assert.deepEqual(plan(g("nba", "Toronto Raptors", "New York Knicks")), [["toronto new york"], ["raptors knicks"], ["raptors", "knicks"]]);
});

test("espn parser: keeps pre/in games, drops finished, reads home/away", () => {
  const { parseEspn } = require("../src/core/sports");
  const ev = (id, state, home) => ({ id, date: "2026-10-14T19:00Z", status: { type: { state } }, competitions: [{ competitors: [
    { homeAway: "home", team: { displayName: "Home FC", abbreviation: "HOM" } }, { homeAway: "away", team: { name: "Away" } }] }] });
  const r = parseEspn({ events: [ev("1", "pre"), ev("2", "in"), ev("3", "post")] }, "epl");
  assert.deepEqual(r.map((x) => [x.id, x.live]), [["1", false], ["2", true]]);
  assert.equal(r[0].startMs, Date.UTC(2026, 9, 14, 19, 0));
  assert.deepEqual([r[0].home.abbr, r[0].away.name], ["HOM", "Away"]);
});

test("find stream for a game in an M3U playlist, loosening the search", async () => {
  const { s, base } = await startMock((req, res) => {
    res.writeHead(200);
    res.end("#EXTM3U\n#EXTINF:-1,NBA: Raptors vs Knicks HD\nhttp://x/1\n#EXTINF:-1,Other Channel\nhttp://x/2\n");
  });
  const svc = new Service(tmp());
  const src = await svc.saveSource({ type: "M3U", m3uUrl: base + "/l.m3u" });
  const game = { league: "nba", home: { name: "Toronto Raptors" }, away: { name: "New York Knicks" } };
  const r = await svc.findGameStreams(src.id, game); // "toronto new york" misses, "raptors knicks" hits
  assert.equal(r.firstQuery, "raptors knicks");
  assert.deepEqual(r.channels.map((c) => c.url), ["http://x/1"]);
  assert.equal(await svc.findGameStreams(src.id, { league: "epl", home: { name: "Zzz United" }, away: { name: "Qqq City" } }), null);
  await assert.rejects(svc.findGameStreams(src.id, { league: "epl" }), /Invalid game/);
  s.close();
});

test("recently played: last 3 per source, most recent first, no duplicates", async () => {
  const svc = new Service(tmp());
  const ch = (n) => ({ name: "Chan " + n, url: "http://x/" + n, group: "" });
  for (const n of [1, 2, 3, 2, 4]) svc.store.addRecent("s1", ch(n));
  svc.store.addRecent("s2", ch(9));
  assert.deepEqual((await svc.loadList("s1x", { kind: "recent" }).catch(() => null)), null); // unknown source still errors
  assert.deepEqual(svc.store.getRecent("s1").map((c) => c.url), ["http://x/4", "http://x/2", "http://x/3"]);
  assert.deepEqual(svc.store.getRecent("s2").map((c) => c.url), ["http://x/9"]);
  svc.store.addRecent("s1", { name: "XXX Prime", url: "http://x/bad" }); // adult is never recorded
  assert.equal(svc.store.getRecent("s1").length, 3);
});

// ---------- M3U playlists on the categories page ----------
test("m3u catalog: groups become categories, ungrouped -> Other, no groups -> All channels", () => {
  const C = require("../src/core/m3uCatalog");
  const list = [
    { name: "A One", url: "u1", group: "Sports" }, { name: "B Two", url: "u2", group: "News" },
    { name: "C Three", url: "u3", group: "Sports" }, { name: "D Four", url: "u4", group: "" }
  ];
  assert.deepEqual(C.categories(list).map((c) => c.id), ["Sports", "News", "Other"]);
  assert.deepEqual(C.channelsOf(list, "Sports").map((c) => c.url), ["u1", "u3"]);
  assert.deepEqual(C.channelsOf(list, "Other").map((c) => c.url), ["u4"]);
  const flat = list.map((c) => ({ name: c.name, url: c.url, group: "" }));
  assert.deepEqual(C.categories(flat), [{ id: "__ALL__", name: "All channels" }]);
  assert.equal(C.channelsOf(flat, "__ALL__").length, 4);
  assert.deepEqual(C.categories([]), []);
  const hits = C.search(list, "three c", C.hasGroups(list)); // all words, any order; hit carries its category
  assert.deepEqual(hits.map((c) => [c.url, c.catId]), [["u3", "Sports"]]);
  const many = Array.from({ length: 600 }, (_, i) => ({ name: "Chan " + i, url: "x" + i, group: "G" }));
  assert.equal(C.search(many, "chan", true).length, C.MAX_SEARCH);
});

test("m3u source through the service: categories, category list, search with catId, hidden/starred", async () => {
  const { s, base } = await startMock((req, res) => {
    res.writeHead(200);
    res.end('#EXTM3U\n#EXTINF:-1 group-title="Sports",Sky Sports 1\nhttp://x/1\n#EXTINF:-1 group-title="News",BBC News\nhttp://x/2\n#EXTINF:-1,Loose Channel\nhttp://x/3\n');
  });
  const svc = new Service(tmp());
  const src = await svc.saveSource({ type: "M3U", m3uUrl: base + "/g.m3u" });
  const d = await svc.getCategories(src.id);
  assert.deepEqual(d.categories.map((c) => c.id), ["Sports", "News", "Other"]);
  assert.deepEqual((await svc.loadList(src.id, { kind: "category", id: "News" })).map((c) => c.url), ["http://x/2"]);
  assert.equal((await svc.loadList(src.id, { kind: "m3u" })).length, 3);
  const found = await svc.loadList(src.id, { kind: "search", query: "sports sky" });
  assert.deepEqual(found.map((c) => c.catId), ["Sports"]);
  assert.equal(svc.toggleStar(src.id, "News"), true);
  svc.store.setHidden(src.id, ["Other"]);
  const d2 = await svc.getCategories(src.id);
  assert.deepEqual([d2.starred, d2.hidden], [["News"], ["Other"]]);
  assert.deepEqual((await svc.refreshSearch(src.id, "bbc")).map((c) => c.url), ["http://x/2"]); // no index to rebuild for M3U
  s.close();
});

// ---------- multiple favourite lists ----------
test("favourite lists: create / rename / delete rules, per-list toggle + order, membership", () => {
  const svc = new Service(tmp());
  const st = svc.store, sid = "s1";
  const ch = (n) => ({ name: "Chan " + n, url: "http://x/" + n, group: "" });
  assert.deepEqual(st.listFavLists(sid).map((l) => l.name), ["Favourites"]);
  const kids = st.createFavList(sid, "  Kids  ");
  assert.equal(kids.name, "Kids");
  assert.throws(() => st.createFavList(sid, "kids"), /already exists/);       // unique, case-insensitive
  assert.throws(() => st.createFavList(sid, "favourites"), /already exists/);  // the default name is taken too
  assert.throws(() => st.createFavList(sid, "x".repeat(25)), /at most 24/);
  assert.throws(() => st.createFavList(sid, "  "), /enter a name/);
  const news = st.createFavList(sid, "News");
  assert.deepEqual(st.listFavLists(sid).map((l) => l.name), ["Favourites", "Kids", "News"]); // creation order
  assert.equal(st.toggleFavourite(sid, ch(1)), true);            // default list
  assert.equal(st.toggleFavourite(sid, ch(1), kids.id), true);
  assert.equal(st.toggleFavourite(sid, ch(2), kids.id), true);
  assert.deepEqual(st.favMembership(sid, "http://x/1"), ["default", kids.id]);
  assert.deepEqual(st.allFavouriteUrls(sid).sort(), ["http://x/1", "http://x/2"]);
  st.saveFavouritesOrder(sid, [ch(2), ch(1)], kids.id);
  assert.deepEqual(st.getFavourites(sid, kids.id).map((c) => c.url), ["http://x/2", "http://x/1"]);
  assert.deepEqual(st.getFavourites(sid).map((c) => c.url), ["http://x/1"]); // default untouched
  assert.equal(st.toggleFavourite(sid, ch(1), kids.id), false);  // removed from Kids only
  assert.deepEqual(st.favMembership(sid, "http://x/1"), ["default"]);
  assert.equal(st.renameFavList(sid, news.id, "Sport"), "Sport");
  assert.throws(() => st.renameFavList(sid, news.id, "Kids"), /already exists/);
  assert.throws(() => st.renameFavList(sid, "default", "Z"), /can't be renamed/);
  assert.throws(() => st.deleteFavList(sid, "default"), /can't be deleted/);
  st.deleteFavList(sid, news.id);
  assert.deepEqual(st.listFavLists(sid).map((l) => l.name), ["Favourites", "Kids"]);
  assert.throws(() => st.getFavourites(sid, news.id), /List not found/);
  // survives a restart, and a source removal takes its lists with it
  const again = new (require("../src/core/store").Store)(path.dirname(st.file));
  assert.equal(again.getFavourites(sid, kids.id).length, 1);
  again.removeSource(sid);
  assert.deepEqual(again.listFavLists(sid).map((l) => l.name), ["Favourites"]);
});

test("favourite lists through the service: list.load by id, url rewrite after a login edit", async () => {
  const svc = new Service(tmp());
  const l = svc.store.createFavList("s9", "Sport");
  svc.store.toggleFavourite("s9", { name: "A", url: "http://old/live/u/p/1.ts", group: "" }, l.id);
  svc.store.rewriteUrls("s9", "http://old/live/u/p/", "http://new/live/u2/p2/");
  assert.deepEqual(svc.store.getFavourites("s9", l.id).map((c) => c.url), ["http://new/live/u2/p2/1.ts"]);
});

// ---------- backup & restore ----------
test("backup: export holds no logins, import into a fresh store restores lists/stars/hidden/EZ/shift and only adds", async () => {
  const B = require("../src/core/backup");
  const a = new Service(tmp()), b = new Service(tmp());
  const srcA = a.store; // build sources directly (no network): ids differ per device
  srcA.addSource({ id: "A1", name: "Prov", type: "XTREAM", server: "http://h.example:8080", user: "Bob", pass: "secret1" });
  const prefixA = "http://h.example:8080/live/Bob/secret1/";
  const kids = srcA.createFavList("A1", "Kids");
  srcA.toggleFavourite("A1", { name: "One", url: prefixA + "1.ts", group: "" });
  srcA.toggleFavourite("A1", { name: "Two", url: prefixA + "2.ts", group: "" }, kids.id);
  srcA.toggleFavourite("A1", { name: "Odd", url: "http://elsewhere/x.ts", group: "" }, kids.id); // not under the prefix: kept as is
  srcA.toggleStarred("A1", "10"); srcA.toggleStarred("A1", "20");
  srcA.setHidden("A1", ["30"]);
  srcA.setEzSlot("A1", 1, { name: "Ez", url: prefixA + "9.ts", group: "" });
  srcA.setEpgShift("A1", 45);
  const text = B.exportBackup(srcA);
  assert.ok(!/secret1/.test(text), "password must not be in the file");

  // another device: same server + user (case-insensitive), a DIFFERENT password, one extra source not in the file
  const dev = b.store;
  dev.addSource({ id: "B7", name: "Mine", type: "XTREAM", server: "http://H.example:8080/", user: "bob", pass: "newpass" });
  dev.addSource({ id: "B8", name: "Other", type: "M3U", m3uUrl: "http://nope/x.m3u" });
  dev.toggleStarred("B7", "20"); dev.toggleStarred("B7", "99"); // pre-existing: kept, order kept
  const r = B.importBackup(dev, text);
  assert.deepEqual([r.sources, r.listsCreated, r.channels, r.starred, r.hidden, r.ezSlots], [1, 1, 3, 1, 1, 1]);
  const prefixB = "http://H.example:8080/live/bob/newpass/";
  assert.deepEqual(dev.getFavourites("B7").map((c) => c.url), [prefixB + "1.ts"]);       // relinked to the new login
  const k2 = dev.listFavLists("B7").find((l) => l.name === "Kids");
  assert.deepEqual(dev.getFavourites("B7", k2.id).map((c) => c.url), [prefixB + "2.ts", "http://elsewhere/x.ts"]);
  assert.deepEqual(dev.getStarred("B7"), ["20", "99", "10"]);
  assert.deepEqual(dev.getHidden("B7"), ["30"]);
  assert.equal(dev.getEz("B7")[1].url, prefixB + "9.ts");
  assert.equal(dev.getEpgShift("B7"), 45);
  assert.match(r.summary, /Imported into 1 source/);
  // importing again adds nothing (lists matched by name, nothing duplicated)
  const r2 = B.importBackup(dev, text);
  assert.deepEqual([r2.listsCreated, r2.channels, r2.starred, r2.hidden, r2.ezSlots], [0, 0, 0, 0, 0]);
  assert.equal(dev.listFavLists("B7").length, 2);
  // a file that is not ours
  assert.throws(() => B.importBackup(dev, "not json"), /not an IPTV Lite backup/);
  assert.throws(() => B.importBackup(dev, JSON.stringify({ app: "Other" })), /not an IPTV Lite backup/);
});

test("backup: sources not on the device are reported, M3U matches by URL", () => {
  const B = require("../src/core/backup");
  const a = new Service(tmp()).store, b = new Service(tmp()).store;
  a.addSource({ id: "M1", name: "My M3U", type: "M3U", m3uUrl: " http://p/list.m3u " });
  a.addSource({ id: "M2", name: "Gone", type: "M3U", m3uUrl: "http://p/gone.m3u" });
  a.toggleFavourite("M1", { name: "A", url: "http://p/a", group: "" });
  b.addSource({ id: "N1", name: "Renamed", type: "M3U", m3uUrl: "http://p/list.m3u" });
  const r = B.importBackup(b, B.exportBackup(a));
  assert.equal(r.sources, 1);
  assert.deepEqual(r.missing, ["Gone"]);
  assert.equal(b.getFavourites("N1").length, 1);
  assert.match(r.summary, /Not on this device, so skipped: Gone/);
});

// ---------- Live tab window: 30 min before start .. 30 min after the end ----------
test("espn parser keeps completed games flagged finished, drops postponed", () => {
  const { parseEspn } = require("../src/core/sports");
  const ev = (id, type) => ({ id, date: "2026-10-14T19:00Z", status: { type }, competitions: [{ competitors: [
    { homeAway: "home", team: { displayName: "H" } }, { homeAway: "away", team: { displayName: "A" } }] }] });
  const r = parseEspn({ events: [ev("1", { state: "post", completed: true }), ev("2", { state: "post", completed: false }), ev("3", { state: "in" })] }, "nba");
  assert.deepEqual(r.map((g) => [g.id, g.live, g.finished]), [["1", false, true], ["3", true, false]]);
});

test("game window: starts 30 min before, ends 30 min after the end (observed or estimated)", () => {
  const { inLiveWindow } = require("../src/core/gameWindow");
  const MIN = 60000, T0 = Date.UTC(2026, 9, 14, 19, 0), DUR = 115;
  const pre = { startMs: T0 };
  assert.equal(inLiveWindow(pre, T0 - 31 * MIN, DUR), false);
  assert.equal(inLiveWindow(pre, T0 - 30 * MIN, DUR), true);   // 30 min before kick-off
  assert.equal(inLiveWindow(pre, T0 + 10 * MIN, DUR), true);   // just past kick-off, not flagged live yet
  assert.equal(inLiveWindow(pre, T0 + 31 * MIN, DUR), false);  // stale "pre"
  assert.equal(inLiveWindow({ startMs: T0, live: true }, T0 + 100 * MIN, DUR), true);
  const ended = { startMs: T0, finished: true, endedAt: T0 + 100 * MIN };    // seen finishing at +100
  assert.equal(inLiveWindow(ended, T0 + 129 * MIN, DUR), true);
  assert.equal(inLiveWindow(ended, T0 + 131 * MIN, DUR), false);
  const est = { startMs: T0, finished: true };                                // first seen finished: start + 115
  assert.equal(inLiveWindow(est, T0 + 144 * MIN, DUR), true);
  assert.equal(inLiveWindow(est, T0 + 146 * MIN, DUR), false);
});

test("search terms module works both as CommonJS (core) and as a browser global (page)", () => {
  const vm = require("vm");
  const code = require("fs").readFileSync(require("path").join(__dirname, "../src/core/searchTerms.js"), "utf8");
  const sandbox = { self: {} };
  vm.runInNewContext(code, sandbox);
  const T = sandbox.self.SearchTerms;
  assert.ok(T && T.matches("Sports HD UK", T.tokens("uk sports"))); // category-name search: any order
  assert.ok(!T.matches("Sports HD UK", T.tokens("uk news")));
});

test("backup with logins: a fresh device re-creates the sources exactly, offline, and favourites relink", () => {
  const B = require("../src/core/backup");
  const a = new Service(tmp()).store, b = new Service(tmp()).store;
  a.addSource({ id: "A1", name: "Prov", type: "XTREAM", server: "http://h.example:8080", user: "Bob", pass: "secret1", m3uUrl: "", userAgent: "UA/1" });
  a.addSource({ id: "A2", name: "List", type: "M3U", server: "", user: "", pass: "", m3uUrl: "http://p/list.m3u", userAgent: "UA/2" });
  const pre = "http://h.example:8080/live/Bob/secret1/";
  const kids = a.createFavList("A1", "Kids");
  a.toggleFavourite("A1", { name: "One", url: pre + "1.ts", group: "" }, kids.id);
  a.toggleStarred("A1", "10"); a.toggleStarred("A1", "20");
  const plain = B.exportBackup(a);
  const full = B.exportBackup(a, true);
  assert.ok(!plain.includes("secret1") && !plain.includes("has_logins"));
  assert.ok(full.includes("secret1") && full.includes('"has_logins": true'));
  // without logins, an empty device can't import anything; with them it can
  assert.equal(B.importBackup(b, plain).sources, 0);
  const r = B.importBackup(b, full, { defaultUserAgent: "DEF" });
  assert.deepEqual([r.sources, r.created, r.channels, r.starred], [2, 2, 1, 2]);
  const x = b.getSources().find((s) => s.type === "XTREAM"), m = b.getSources().find((s) => s.type === "M3U");
  assert.deepEqual([x.name, x.server, x.user, x.pass, x.userAgent], ["Prov", "http://h.example:8080", "Bob", "secret1", "UA/1"]);
  assert.deepEqual([m.name, m.m3uUrl, m.userAgent], ["List", "http://p/list.m3u", "UA/2"]);
  assert.notEqual(x.id, "A1");                                                       // new device, new id
  const k2 = b.listFavLists(x.id).find((l) => l.name === "Kids");
  assert.deepEqual(b.getFavourites(x.id, k2.id).map((c) => c.url), [pre + "1.ts"]);  // identical link
  assert.deepEqual(b.getStarred(x.id), ["10", "20"]);                                // same order
  assert.match(r.summary, /2 re-created from the file's logins/);
  // importing again: sources already there, so nothing is created or duplicated
  const r2 = B.importBackup(b, full);
  assert.deepEqual([r2.created, r2.channels, r2.starred], [0, 0, 0]);
  assert.equal(b.getSources().length, 2);
  // a login block that is incomplete is ignored (source reported as missing)
  const bad = JSON.stringify({ app: "IPTVLite", version: 1, sources: [{ fp: "zz", name: "Bad", login: { type: "XTREAM", server: "http://x", user: "", pass: "" } }] });
  assert.deepEqual(B.importBackup(b, bad).missing, ["Bad"]);
});

test("sports loaders: phase 1 / phase 2 / live work end to end on ESPN-shaped data", async () => {
  const httpPath = require.resolve("../src/core/http");
  const sportsPath = require.resolve("../src/core/sports");
  const realHttp = require.cache[httpPath];
  const urls = [];
  let offline = false;
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString().replace(/\.\d+Z$/, "Z");
  const ev = (id, state, min, completed = false) => ({ id, date: iso(min), status: { type: { state, completed } }, competitions: [{ competitors: [
    { homeAway: "home", team: { displayName: "Home " + id, abbreviation: "H" } }, { homeAway: "away", team: { displayName: "Away " + id } }] }] });
  require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: { fetchText: async (url) => {
    urls.push(url);
    if (offline) throw new Error("offline");
    if (!url.includes("espn.com")) throw new Error("unexpected url " + url);
    const day = /dates=(\d{8})/.exec(url);
    return JSON.stringify({ events: day ? [ev("d" + day[1], "pre", 60)] : [ev("live1", "in", -30), ev("done1", "post", -200, true)] });
  } } };
  delete require.cache[sportsPath];
  try {
    const sp = require("../src/core/sports");
    const near = await sp.loadNear();
    assert.equal(near.failed, 0);
    assert.equal(near.okLeagues.length, sp.LEAGUES.length);
    assert.ok(near.games.length >= sp.LEAGUES.length * 3, "3 days per league");
    assert.equal(urls.filter((u) => u.includes("dates=")).length, sp.LEAGUES.length * 3);
    const rest = await sp.loadRest(near.okLeagues);
    assert.equal(rest.games.length, sp.LEAGUES.length * 6);
    const live = await sp.loadLive();
    assert.ok(live.some((g) => g.live) && live.some((g) => g.finished));
    // every ESPN failure -> backup source also unreachable -> reported, not thrown
    offline = true;
    const down = await sp.loadNear();
    assert.equal(down.failed, sp.LEAGUES.length);
    assert.equal(down.games.length, 0);
    assert.equal(await sp.loadLive(), null);
  } finally {
    delete require.cache[sportsPath];
    if (realHttp) require.cache[httpPath] = realHttp; else delete require.cache[httpPath];
  }
});

// ---------- closed captions (CEA-608 out of the video) ----------
const { Cea608, CaptionBus } = require("../src/core/captions");
const odd = (b) => { let p = 0; for (let i = 0; i < 7; i++) p ^= (b >> i) & 1; return b | (p ? 0 : 0x80); }; // odd parity, like real captions
const pairOf = (s) => [odd(s.charCodeAt(0)), odd(s.charCodeAt(1))];

test("captions: pop-on text appears only after end-of-caption", () => {
  const out = [];
  const d = new Cea608((l) => out.push(l));
  const send = (a, b) => { d.pair(odd(a), odd(b)); d.pair(odd(a), odd(b)); }; // control codes are sent twice
  send(0x14, 0x20);                       // RCL
  send(0x14, 0x70);                       // PAC row 15, col 0
  d.pair(...pairOf("HI")); d.pair(...pairOf("!\0".replace("\0", " ")));
  assert.equal(out.length, 0);
  send(0x14, 0x2f);                       // EOC
  assert.deepEqual(out.at(-1), ["HI!"]);
  send(0x14, 0x2c);                       // erase displayed
  assert.deepEqual(out.at(-1), []);
});

test("captions: roll-up scrolls and CC2 / text service are ignored", () => {
  const out = [];
  const d = new Cea608((l) => out.push(l));
  const send = (a, b) => { d.pair(odd(a), odd(b)); d.pair(odd(a), odd(b)); };
  send(0x14, 0x25);                       // RU2
  d.pair(...pairOf("AB")); send(0x14, 0x2d);
  d.pair(...pairOf("CD"));
  assert.deepEqual(out.at(-1), ["AB", "CD"]);
  send(0x1c, 0x25);                       // channel 2 command: following text must not show
  d.pair(...pairOf("ZZ"));
  assert.deepEqual(out.at(-1), ["AB", "CD"]);
});

// A tiny MPEG-TS stream: PAT -> PMT (PID 0x100) -> H.264 video (PID 0x101); each frame's SEI carries caption pairs.
function tsPacket(pid, pusi, payload) {
  const p = Buffer.alloc(188, 0xff);
  p[0] = 0x47; p[1] = (pusi ? 0x40 : 0) | (pid >> 8); p[2] = pid & 0xff; p[3] = 0x10;
  payload.copy(p, 4);
  return p;
}
function frame(pairs, pts) {
  const cc = Buffer.concat([Buffer.from([0xb5, 0x00, 0x31]), Buffer.from("GA94"), Buffer.from([0x03, 0xc0 | pairs.length, 0xff]),
    ...pairs.map((q) => Buffer.from([0xfc, q[0], q[1]]))]);
  const es = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 0, 1, 0x06, 0x04, cc.length]), cc, Buffer.from([0x80])]);
  const ptsB = Buffer.from([0x21 | ((pts / 2 ** 29) & 0x0e), (pts >> 22) & 0xff, 0x01 | ((pts >> 14) & 0xfe), (pts >> 7) & 0xff, 0x01 | ((pts << 1) & 0xfe)]);
  return tsPacket(0x101, true, Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), ptsB, es]));
}
const PAT = tsPacket(0, true, Buffer.from([0, 0x00, 0xb0, 0x0d, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0x00, 0, 0, 0, 0]));
const PMT = tsPacket(0x100, true, Buffer.from([0, 0x02, 0xb0, 0x12, 0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, 0x00, 0x1b, 0xe1, 0x01, 0xf0, 0x00, 0, 0, 0, 0]));

test("captions: caption text is read out of an H.264 transport stream (frames in order)", () => {
  const bus = new CaptionBus();
  const events = [];
  bus.subscribe({ write: (s) => events.push(JSON.parse(s.replace(/^data: /, ""))) });
  const ctl = (a, b) => [[odd(a), odd(b)], [odd(a), odd(b)]];
  const pairs = [...ctl(0x14, 0x20), ...ctl(0x14, 0x70), pairOf("HI"), ...ctl(0x14, 0x2f)];
  const frames = pairs.map((q, n) => frame([q], 1000 + n * 3000));
  for (let n = 0; n < 6; n++) frames.push(frame([[0x80, 0x80]], 100000 + n * 3000)); // filler frames push the reorder queue through
  const tap = bus.tap();
  const all = Buffer.concat([PAT, PMT, ...frames, frame([], 999999)]);
  tap.feed(all.slice(0, 500)); tap.feed(all.slice(500)); // split mid-packet on purpose
  assert.ok(events.some((e) => e.t === "avail" && e.on), "channel is flagged as having captions");
  const shown = events.filter((e) => e.t === "cc").map((e) => e.lines.join("|"));
  assert.deepEqual(shown.filter(Boolean), ["HI"]);
});

test("captions: a stream without caption data is not flagged", () => {
  const bus = new CaptionBus();
  const events = [];
  bus.subscribe({ write: (s) => events.push(JSON.parse(s.replace(/^data: /, ""))) });
  const noSei = tsPacket(0x101, true, Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x00, 0, 0, 0, 0, 1, 0x09, 0xf0]));
  bus.tap().feed(Buffer.concat([PAT, PMT, noSei, noSei]));
  assert.ok(!events.some((e) => e.t === "avail" && e.on));
});
