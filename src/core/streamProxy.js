// Local 127.0.0.1 proxy the video element streams through. Why: browsers cannot set a custom
// User-Agent, cannot play providers' CORS-less streams, and cannot follow some redirects. The proxy
// fetches upstream with the source's User-Agent, adds CORS headers, rewrites HLS playlists so every
// segment also goes through it, and drops the upstream connection the moment the player disconnects.
// Protected by a random per-run token + Host check, and bound to loopback only.
const http = require("http");
const crypto = require("crypto");
const { open, DEFAULT_UA } = require("./http");
const { CaptionBus } = require("./captions");

const MAX_MANIFEST = 5 * 1024 * 1024;
const PRE_MS = 6000; // how long a probed connection waits for the player to pick it up
const PASS_HEADERS = ["content-type", "content-length", "content-range", "accept-ranges"];

// What is this stream, judging by its real first bytes (not its address or Content-Type)?
// -> "hls" | "ts" | "mp4" | "text" (a message / web page instead of video) | "unknown"
function classify(headers, url, buf) {
  const ct = String((headers && headers["content-type"]) || "").toLowerCase();
  const head = buf.slice(0, 32).toString("latin1").replace(/^\u00EF\u00BB\u00BF/, "").trimStart();
  if (head.startsWith("#EXTM3U")) return "hls";
  if (buf.length && buf[0] === 0x47 && (buf.length <= 188 || buf[188] === 0x47)) return "ts";
  if (buf.length >= 8 && buf.slice(4, 8).toString("latin1") === "ftyp") return "mp4";
  if (ct.includes("mpegurl") || /\.m3u8(\?|$)/i.test(url || "")) return buf.length ? "text" : "unknown"; // promised a playlist, sent something else
  if (/^(text\/|application\/json)/.test(ct) || /^\s*(<|\{)/.test(head)) return "text";
  return "unknown";
}

function snippet(buf) {
  return buf.slice(0, 600).toString("utf8").replace(/<[^>]*>/g, " ").replace(/[^\x20-\x7E\u00A0-\uFFFF]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
}

function createProxy() {
  const token = crypto.randomBytes(16).toString("hex");
  let port = 0;
  const base = () => `http://127.0.0.1:${port}/${token}`;
  const proxify = (abs, ua) => `${base()}/p?u=${encodeURIComponent(abs)}&ua=${encodeURIComponent(ua)}`;

  function rewriteManifest(text, baseUrl, ua) {
    const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch (e) { return u; } };
    return text.split(/\r?\n/).map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${proxify(abs(u), ua)}"`);
      return proxify(abs(t), ua);
    }).join("\n");
  }

  const captions = new CaptionBus(); // closed captions read out of the video on its way through (see captions.js)

  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Cache-Control": "no-store" };

  // ---- probe: look at what the provider really sends before choosing a player engine ----
  // /probe opens the upstream stream, reads its first bytes and says what it is (hls / ts / mp4 / text ...).
  // The open connection is kept for a few seconds and handed to the player's next request for the same
  // address, so probing never costs an extra connection (providers often allow only one per account).
  const pre = new Map(); // key -> { up, it, first, timer }
  const keyOf = (target, ua) => target + "\n" + ua;
  function dropPre(key) {
    const p = pre.get(key);
    if (!p) return;
    clearTimeout(p.timer);
    pre.delete(key);
    try { p.up.abort(); } catch (e) { /* already closed */ }
  }

  async function openFirst(target, ua, range) {
    const headers = {};
    if (range) headers.Range = range;
    const up = await open(target, { userAgent: ua, headers, decompress: false });
    const it = up.stream[Symbol.asyncIterator]();
    let first;
    try { first = await it.next(); } catch (e) { up.abort(); throw e; }
    return { up, it, first };
  }

  async function probe(req, res, target, ua) {
    const key = keyOf(target, ua);
    dropPre(key);
    let gone = false;
    res.on("close", () => { if (!res.writableFinished) gone = true; });
    let o;
    try { o = await openFirst(target, ua, null); } catch (e) {
      res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
    if (gone) { o.up.abort(); return; }
    const buf = o.first.done ? Buffer.alloc(0) : o.first.value;
    const kind = o.up.status >= 400 ? "error" : classify(o.up.headers, o.up.url, buf);
    const out = { status: o.up.status, kind, contentType: String(o.up.headers["content-type"] || ""), url: o.up.url, text: "", bytes: buf.length, head: buf.slice(0, 12).toString("hex").replace(/(..)(?=.)/g, "$1 ") };
    if (kind === "text" || kind === "error") out.text = snippet(buf);
    if (kind === "text" || kind === "error") o.up.abort();
    else pre.set(key, Object.assign(o, { timer: setTimeout(() => dropPre(key), PRE_MS) }));
    res.writeHead(200, Object.assign({ "Content-Type": "application/json" }, cors));
    res.end(JSON.stringify(out));
  }

  async function handler(req, res) {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); return res.end(); }
      const u = new URL(req.url, "http://127.0.0.1");
      const parts = u.pathname.split("/");
      if (parts[1] !== token || !["p", "probe", "drop", "cc", "ccreset"].includes(parts[2])) { res.writeHead(404); return res.end(); }
      if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }
      if (parts[2] === "ccreset") { captions.reset(); res.writeHead(204, cors); return res.end(); }
      if (parts[2] === "cc") { // the player's caption event stream (server-sent events)
        res.writeHead(200, Object.assign({ "Content-Type": "text/event-stream" }, cors));
        const off = captions.subscribe(res);
        const ka = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) { /* closed */ } }, 20000);
        res.on("close", () => { clearInterval(ka); off(); });
        return;
      }
      const target = u.searchParams.get("u") || "";
      const ua = u.searchParams.get("ua") || DEFAULT_UA;
      if (!/^https?:\/\//i.test(target)) { res.writeHead(400, cors); return res.end("Bad target"); }
      if (parts[2] === "drop") { dropPre(keyOf(target, ua)); res.writeHead(204, cors); return res.end(); }
      if (parts[2] === "probe") return await probe(req, res, target, ua);

      // reuse the connection a probe just opened, otherwise open one
      const key = keyOf(target, ua);
      let o = !req.headers.range && pre.get(key);
      if (o) { clearTimeout(o.timer); pre.delete(key); } else o = await openFirst(target, ua, req.headers.range);
      const { up, it, first } = o;
      res.on("close", () => { if (!res.writableFinished) up.abort(); }); // player left -> drop upstream
      up.stream.on("error", () => res.destroy());

      if (up.status >= 400) {
        up.abort();
        res.writeHead(up.status, cors);
        return res.end("Upstream HTTP " + up.status);
      }

      const firstBuf = first.done ? Buffer.alloc(0) : first.value;
      const kind = classify(up.headers, up.url, firstBuf);
      const isManifest = kind === "hls";

      if (isManifest) {
        const chunks = [firstBuf];
        let size = firstBuf.length;
        if (!first.done) for await (const c of up.stream) { chunks.push(c); size += c.length; if (size > MAX_MANIFEST) break; }
        const body = rewriteManifest(Buffer.concat(chunks).toString("utf8"), up.url, ua);
        res.writeHead(200, Object.assign({ "Content-Type": "application/vnd.apple.mpegurl" }, cors));
        return res.end(body);
      }

      const h = Object.assign({}, cors);
      for (const k of PASS_HEADERS) if (up.headers[k]) h[k] = up.headers[k];
      res.writeHead(up.status, h);
      const tap = kind === "ts" ? captions.tap() : null; // never lets a caption problem touch the video
      const feed = (c) => { if (tap) { try { tap.feed(c); } catch (e) { /* ignore */ } } };
      if (firstBuf.length) { feed(firstBuf); res.write(firstBuf); }
      if (first.done) return res.end();
      for await (const c of up.stream) { feed(c); if (!res.write(c)) await new Promise((r) => res.once("drain", r)); }
      res.end();
    } catch (e) {
      if (!res.headersSent) { res.writeHead(502, cors); res.end(String(e.message || e)); } else res.destroy();
    }
  }

  const server = http.createServer(handler);
  return {
    start: () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => { port = server.address().port; resolve(base()); })),
    base,
    proxify,
    rewriteManifest,
    classify,
    captions,
    close: () => server.close()
  };
}

module.exports = { createProxy, classify };
