// Small HTTP(S) client on Node core: custom User-Agent, redirects, timeouts, gzip.
const http = require("http");
const https = require("https");
const zlib = require("zlib");

const CONNECT_TIMEOUT = 10000;
const READ_TIMEOUT = 15000;
const DEFAULT_UA = "VLC/3.0.18";

// Opens a request and resolves once headers arrive.
// -> { status, headers, stream, url, abort() }.  stream is already decompressed when decompress=true.
function open(url, opts = {}) {
  const { userAgent = DEFAULT_UA, headers = {}, decompress = true, maxRedirects = 5 } = opts;
  return new Promise((resolve, reject) => {
    const go = (target, left) => {
      let u;
      try { u = new URL(target); } catch (e) { return reject(new Error("Invalid URL: " + target)); }
      if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("Unsupported URL: " + target));
      const h = Object.assign({ "User-Agent": userAgent, Accept: "*/*", Connection: "close" }, headers);
      if (decompress) h["Accept-Encoding"] = "gzip, deflate";
      const lib = u.protocol === "https:" ? https : http;
      const req = lib.request(u, { method: "GET", headers: h }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (left <= 0) return reject(new Error("Too many redirects"));
          return go(new URL(res.headers.location, u).toString(), left - 1);
        }
        let stream = res;
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        if (decompress && enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (decompress && enc === "deflate") stream = res.pipe(zlib.createInflate());
        res.on("error", (e) => stream.destroy(e));
        resolve({ status: code, headers: res.headers, stream, url: u.toString(), abort: () => req.destroy() });
      });
      req.on("socket", (s) => {
        if (!s.connecting) return;
        const t = setTimeout(() => req.destroy(new Error("Connection timed out")), CONNECT_TIMEOUT);
        s.once("connect", () => clearTimeout(t));
        s.once("close", () => clearTimeout(t));
      });
      req.setTimeout(READ_TIMEOUT, () => req.destroy(new Error("Timed out waiting for the server")));
      req.on("error", reject);
      req.end();
    };
    go(url, maxRedirects);
  });
}

async function fetchText(url, userAgent) {
  const r = await open(url, { userAgent });
  if (r.status < 200 || r.status >= 300) { r.abort(); throw new Error("HTTP " + r.status); }
  const chunks = [];
  for await (const c of r.stream) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

module.exports = { open, fetchText, DEFAULT_UA };
