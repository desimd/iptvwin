// #EXTM3U parser (port of M3uParser.kt). Accepts an http(s) URL, a local file path, or raw text.
const fs = require("fs");
const { fetchText } = require("./http");
const AdultFilter = require("./adultFilter");

// First comma that is not inside quotes (group-title="A, B",Name still works).
function nameAfterComma(line) {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\"") q = !q;
    else if (c === "," && !q) return line.slice(i + 1).trim();
  }
  return "";
}

function parseText(text) {
  const out = [];
  let name = "", group = "", adult = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF")) {
      name = nameAfterComma(line);
      const g = /group-title="([^"]*)"/.exec(line);
      group = g ? g[1] : "";
      const a = /adult="?([^"\s]*)"?/i.exec(line);
      adult = a ? a[1] : null;
    } else if (line && !line.startsWith("#")) {
      const n = name || "Unknown channel";
      if (!AdultFilter.isBlockedChannel(n, group, adult)) out.push({ name: n, url: line, group });
      name = ""; group = ""; adult = null;
    }
  }
  return out;
}

async function parse(source, userAgent) {
  let text;
  if (/^https?:\/\//i.test(source)) text = await fetchText(source, userAgent);
  else if (!source.includes("\n") && fs.existsSync(source)) text = fs.readFileSync(source, "utf8");
  else text = source;
  return parseText(text);
}

module.exports = { parse, parseText };
