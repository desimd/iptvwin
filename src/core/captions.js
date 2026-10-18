// Closed captions (CC) for live TV. Desktop browsers do not draw the CEA-608 captions hidden inside an IPTV
// channel's video (mpegts.js ignores them), so the local stream proxy reads them itself: it watches the MPEG-TS
// bytes on their way to the player, pulls the caption bytes out of the video (H.264 SEI / MPEG-2 user data),
// decodes CC1 into plain text lines and hands them to the player over a tiny event stream.
//
//   TsCaptionParser  - MPEG-TS packets -> caption byte pairs (field 1)
//   Cea608           - caption byte pairs -> on-screen text lines (CC1: pop-on, roll-up, paint-on)
//   CaptionBus       - one shared decoder + the listeners (the player's event stream)
//
// "Available" means the channel really carries a caption data stream (the player greys the CC button otherwise).

const STD = { 0x2a: "\u00E1", 0x5c: "\u00E9", 0x5e: "\u00ED", 0x5f: "\u00F3", 0x60: "\u00FA", 0x7b: "\u00E7", 0x7c: "\u00F7", 0x7d: "\u00D1", 0x7e: "\u00F1", 0x7f: "\u2588" };
const SPECIAL = Array.from("\u00AE\u00B0\u00BD\u00BF\u2122\u00A2\u00A3\u266A\u00E0 \u00E8\u00E2\u00EA\u00EE\u00F4\u00FB");
const EXT1 = Array.from("\u00C1\u00C9\u00D3\u00DA\u00DC\u00FC\u2018\u00A1*'\u2014\u00A9\u2120\u2022\u201C\u201D\u00C0\u00C2\u00C7\u00C8\u00CA\u00CB\u00EB\u00CE\u00CF\u00EF\u00D4\u00D9\u00F9\u00DB\u00AB\u00BB");
const EXT2 = Array.from("\u00C3\u00E3\u00CD\u00CC\u00EC\u00D2\u00F2\u00D5\u00F5{}\\^_|~\u00C4\u00E4\u00D6\u00F6\u00DF\u00A5\u00A4\u2502\u00C5\u00E5\u00D8\u00F8\u250C\u2510\u2514\u2518");
const ROW_BY_P1 = { 0x11: 1, 0x12: 3, 0x15: 5, 0x16: 7, 0x17: 9, 0x10: 11, 0x13: 12, 0x14: 14 }; // first row of the pair (second = +1 when p2 >= 0x60)
const COLS = 32, ROWS = 15;

class Cea608 {
  constructor(emit) {
    this.emit = emit || (() => {});
    this.reset();
  }

  reset() {
    this.disp = this._blank();
    this.nd = this._blank();
    this.mode = "pop"; // pop | roll | paint
    this.roll = 2;
    this.row = 14;
    this.col = 0;
    this.ch = 1;
    this.text = false; // T1/T2 text service (not captions): ignored
    this.last = -1;
    this.shown = "";
  }

  _blank() { return Array.from({ length: ROWS }, () => new Array(COLS).fill(" ")); }

  lines() {
    const out = [];
    for (const r of this.disp) { const t = r.join("").trim(); if (t) out.push(t); }
    return out.slice(-4);
  }

  _changed() {
    const l = this.lines(), key = l.join("\n");
    if (key !== this.shown) { this.shown = key; this.emit(l); }
  }

  _put(c) {
    if (this.text || this.ch !== 1) return;
    const mem = this.mode === "pop" ? this.nd : this.disp;
    if (this.col < COLS) mem[this.row][this.col++] = c;
    if (this.mode !== "pop") this._changed();
  }

  _crawl() { // roll-up carriage return
    const top = Math.max(0, this.row - this.roll + 1);
    for (let r = top; r < this.row; r++) this.disp[r] = this.disp[r + 1].slice();
    this.disp[this.row] = new Array(COLS).fill(" ");
    this.col = 0;
    this._changed();
  }

  // One pair of caption bytes (field 1).
  pair(b1, b2) {
    const p1 = b1 & 0x7f, p2 = b2 & 0x7f;
    if (p1 === 0 && p2 === 0) return;
    if (p1 >= 0x10 && p1 <= 0x1f) {
      const code = (p1 << 8) | p2;
      if (code === this.last) { this.last = -1; return; } // control codes are sent twice: act on the first
      this.last = code;
      this.ch = p1 & 0x08 ? 2 : 1;
      this._control(p1 & 0xf7, p2);
      return;
    }
    this.last = -1;
    if (p1 >= 0x20) this._put(STD[p1] || String.fromCharCode(p1));
    if (p2 >= 0x20) this._put(STD[p2] || String.fromCharCode(p2));
  }

  _control(p1, p2) {
    if (p2 >= 0x40) { // preamble address code: row, indent
      if (!(p1 in ROW_BY_P1) || (p1 === 0x10 && p2 >= 0x60)) return;
      const row = ROW_BY_P1[p1] + (p2 >= 0x60 ? 1 : 0) - 1;
      this.row = Math.min(ROWS - 1, row);
      this.col = p2 & 0x10 ? ((p2 & 0x0e) >> 1) * 4 : 0;
      return;
    }
    if (p1 === 0x11) {
      if (p2 >= 0x30) this._put(SPECIAL[p2 - 0x30]);
      else if (p2 >= 0x20) this._put(" "); // mid-row style change takes one space
      return;
    }
    if (p1 === 0x12 || p1 === 0x13) { // extended characters replace the character before them
      if (p2 >= 0x20 && p2 <= 0x3f) {
        if (this.col > 0) this.col--;
        this._put((p1 === 0x12 ? EXT1 : EXT2)[p2 - 0x20]);
      }
      return;
    }
    if (p1 === 0x17) { if (p2 >= 0x21 && p2 <= 0x23) this.col = Math.min(COLS - 1, this.col + (p2 - 0x20)); return; }
    if (p1 !== 0x14 && p1 !== 0x15) return;
    switch (p2) {
      case 0x20: this.text = false; this.mode = "pop"; break;                 // resume caption loading
      case 0x21: if (this.col > 0 && !this.text && this.ch === 1) { this.col--; (this.mode === "pop" ? this.nd : this.disp)[this.row][this.col] = " "; if (this.mode !== "pop") this._changed(); } break;
      case 0x25: case 0x26: case 0x27: this._rollUp(p2 - 0x23); break;         // roll-up 2 / 3 / 4
      case 0x29: this.text = false; this.mode = "paint"; break;               // resume direct captioning
      case 0x2a: case 0x2b: this.text = true; break;                          // text restart / resume text
      case 0x2c: this.disp = this._blank(); this._changed(); break;           // erase displayed memory
      case 0x2d: if (this.mode === "roll" && !this.text && this.ch === 1) this._crawl(); break;
      case 0x2e: this.nd = this._blank(); break;                              // erase non-displayed memory
      case 0x2f: { const t = this.disp; this.disp = this.nd; this.nd = t; this._changed(); break; } // end of caption: show it
      default: break;
    }
  }

  _rollUp(n) {
    this.text = false;
    if (this.mode !== "roll") { this.disp = this._blank(); this.nd = this._blank(); this._changed(); }
    this.mode = "roll";
    this.roll = n;
    this.row = ROWS - 1;
    this.col = 0;
  }
}

// ---- MPEG-TS -> caption byte pairs ----
class TsCaptionParser {
  // onPairs(pts, pairs[]) is called per video frame that carries caption data; onSeen() when such data exists at all.
  constructor(onPairs, onSeen) {
    this.onPairs = onPairs;
    this.onSeen = onSeen || (() => {});
    this.rest = null;
    this.pmtPid = -1;
    this.vidPid = -1;
    this.vidType = 0;
    this.pes = [];
    this.pesLen = 0;
  }

  feed(buf) {
    let b = this.rest && this.rest.length ? Buffer.concat([this.rest, buf]) : buf;
    let i = 0;
    while (i < b.length && b[i] !== 0x47) i++; // find the packet grid
    while (i + 188 <= b.length) {
      if (b[i] !== 0x47) { i++; while (i < b.length && b[i] !== 0x47) i++; continue; }
      this._packet(b, i);
      i += 188;
    }
    this.rest = b.length - i > 0 && b.length - i < 188 ? Buffer.from(b.slice(i)) : null;
  }

  _packet(b, o) {
    const pid = ((b[o + 1] & 0x1f) << 8) | b[o + 2];
    const pusi = (b[o + 1] & 0x40) !== 0;
    const afc = (b[o + 3] >> 4) & 3;
    let p = o + 4;
    if (afc & 2) p += 1 + b[o + 4];
    if (!(afc & 1) || p >= o + 188) return;
    const end = o + 188;
    if (pid === 0) { if (this.pmtPid < 0) this._pat(b, p, end, pusi); return; }
    if (pid === this.pmtPid && this.vidPid < 0) { this._pmt(b, p, end, pusi); return; }
    if (pid !== this.vidPid) return;
    if (pusi) this._flush();
    if (this.pesLen < 2 * 1024 * 1024) { this.pes.push(b.slice(p, end)); this.pesLen += end - p; }
  }

  _pat(b, p, end, pusi) {
    if (pusi) p += 1 + b[p];
    if (p + 8 > end) return;
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    for (let q = p + 8; q + 4 <= Math.min(end, p + 3 + len - 4); q += 4) {
      const prog = (b[q] << 8) | b[q + 1];
      if (prog !== 0) { this.pmtPid = ((b[q + 2] & 0x1f) << 8) | b[q + 3]; return; }
    }
  }

  _pmt(b, p, end, pusi) {
    if (pusi) p += 1 + b[p];
    if (p + 12 > end) return;
    const len = ((b[p + 1] & 0x0f) << 8) | b[p + 2];
    const pil = ((b[p + 10] & 0x0f) << 8) | b[p + 11];
    const stop = Math.min(end, p + 3 + len - 4);
    for (let q = p + 12 + pil; q + 5 <= stop;) {
      const type = b[q], pid = ((b[q + 1] & 0x1f) << 8) | b[q + 2], es = ((b[q + 3] & 0x0f) << 8) | b[q + 4];
      if (type === 0x1b || type === 0x02) { this.vidPid = pid; this.vidType = type; return; }
      q += 5 + es;
    }
  }

  _flush() {
    if (!this.pes.length) return;
    const d = Buffer.concat(this.pes);
    this.pes = []; this.pesLen = 0;
    try { this._pesData(d); } catch (e) { /* damaged data: skip this frame */ }
  }

  _pesData(d) {
    if (d.length < 9 || d[0] !== 0 || d[1] !== 0 || d[2] !== 1) return;
    let pts = null;
    if (d[7] & 0x80 && d.length >= 14) {
      pts = ((d[9] >> 1) & 7) * 1073741824 + (((d[10] << 8) | d[11]) >> 1) * 32768 + (((d[12] << 8) | d[13]) >> 1);
    }
    const es = d.slice(9 + d[8]);
    const pairs = this.vidType === 0x1b ? h264Pairs(es) : mpeg2Pairs(es);
    if (pairs) { this.onSeen(); if (pairs.length) this.onPairs(pts, pairs); }
  }
}

// cc_data() triplets -> field 1 pairs. Returns null when this frame has no caption data block at all.
function triplets(d, i, end) {
  if (i + 2 > end) return null;
  const count = d[i] & 0x1f;
  i += 2; // flags/count + em_data
  const out = [];
  for (let k = 0; k < count && i + 3 <= end; k++, i += 3) {
    if ((d[i] & 0x04) && (d[i] & 0x03) === 0) out.push([d[i + 1], d[i + 2]]);
  }
  return out;
}

function h264Pairs(es) {
  let found = null;
  for (let i = 0; i + 4 < es.length; i++) {
    if (es[i] !== 0 || es[i + 1] !== 0 || es[i + 2] !== 1) continue;
    if ((es[i + 3] & 0x1f) !== 6) continue; // SEI only
    let j = i + 4;
    while (j + 3 < es.length && !(es[j] === 0 && es[j + 1] === 0 && (es[j + 2] === 1 || es[j + 2] === 0))) j++;
    const nal = unescape(es.slice(i + 4, Math.min(j, es.length)));
    for (let k = 0; k + 2 < nal.length;) { // SEI messages
      let type = 0; while (k < nal.length && nal[k] === 0xff) { type += 255; k++; }
      type += nal[k++];
      let size = 0; while (k < nal.length && nal[k] === 0xff) { size += 255; k++; }
      size += nal[k++];
      if (type === 4 && size >= 10 && nal[k] === 0xb5 && nal[k + 1] === 0x00 && nal[k + 2] === 0x31 && nal.toString("latin1", k + 3, k + 7) === "GA94" && nal[k + 7] === 0x03) {
        const t = triplets(nal, k + 8, Math.min(nal.length, k + size));
        if (t) found = (found || []).concat(t);
      }
      k += size;
      if (nal[k] === 0x80) break; // rbsp trailing bits
    }
  }
  return found;
}

function mpeg2Pairs(es) {
  let found = null;
  for (let i = 0; i + 10 < es.length; i++) {
    if (es[i] === 0 && es[i + 1] === 0 && es[i + 2] === 1 && es[i + 3] === 0xb2 && es.toString("latin1", i + 4, i + 8) === "GA94" && es[i + 8] === 0x03) {
      let j = i + 9;
      while (j + 3 < es.length && !(es[j] === 0 && es[j + 1] === 0 && es[j + 2] === 1)) j++;
      const t = triplets(es, i + 9, Math.min(es.length, j));
      if (t) found = (found || []).concat(t);
    }
  }
  return found;
}

function unescape(b) { // drop emulation-prevention bytes (00 00 03 -> 00 00)
  const out = Buffer.allocUnsafe(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    if (i >= 2 && b[i] === 3 && b[i - 1] === 0 && b[i - 2] === 0) continue;
    out[n++] = b[i];
  }
  return out.slice(0, n);
}

// ---- shared state between the proxy (producer) and the player's event stream (listeners) ----
const REORDER = 4; // frames held back so caption pairs go in display order (B-frames reorder the video)

class CaptionBus {
  constructor() {
    this.listeners = new Set();
    this.dec = new Cea608((lines) => this._send({ t: "cc", lines }));
    this.avail = false;
    this.q = [];
  }

  reset() {
    this.dec.reset();
    this.q = [];
    this.avail = false;
    this._send({ t: "avail", on: false });
    this._send({ t: "cc", lines: [] });
  }

  // A parser for one stream response (an HLS segment or a whole live TS connection).
  tap() {
    return new TsCaptionParser(
      (pts, pairs) => {
        this.q.push({ pts: pts === null ? Infinity : pts, pairs });
        this.q.sort((a, b) => a.pts - b.pts);
        while (this.q.length > REORDER) this._run(this.q.shift());
      },
      () => { if (!this.avail) { this.avail = true; this._send({ t: "avail", on: true }); } }
    );
  }

  _run(e) { for (const p of e.pairs) this.dec.pair(p[0], p[1]); }

  _send(o) { const s = `data: ${JSON.stringify(o)}\n\n`; for (const l of this.listeners) { try { l.write(s); } catch (e) { /* listener gone */ } } }

  subscribe(res) {
    this.listeners.add(res);
    res.write(`data: ${JSON.stringify({ t: "avail", on: this.avail })}\n\n`);
    return () => this.listeners.delete(res);
  }
}

module.exports = { Cea608, TsCaptionParser, CaptionBus };
