// True playback stats for the player bar: "Video: 1080p · 50 fps · H.264   BitR: 6.2 Mbps".
// Nothing here looks at the channel title. Every value comes from the stream / decoder:
//   resolution  <- the <video> element's decoded size (videoWidth / videoHeight)
//   fps         <- frames the decoder actually produced per second (sliding window), falling back to
//                  the frame rate the stream declares
//   codec       <- the codec string the demuxer read from the stream (avc1.*, hvc1.*, av01.* ...)
//   bitrate     <- compressed video bytes the decoder consumed per second (sliding window), falling back
//                  to what the engine measured while downloading
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.StreamStats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STANDARD_HEIGHTS = [144, 240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320];

  // "1080p". Heights a few pixels off a standard one (coded 1088 etc.) snap to it; anything else is shown as is.
  function qualityLabel(width, height) {
    width = Number(width) || 0; height = Number(height) || 0;
    if (!height) return "";
    let h = height;
    for (const s of STANDARD_HEIGHTS) if (Math.abs(h - s) <= 8) { h = s; break; }
    if (h >= 4320 || width >= 7680) return "8K";
    if (h >= 2160 || width >= 3840) return "4K";
    return h + "p";
  }

  function fpsText(fps) {
    fps = Number(fps);
    if (!Number.isFinite(fps) || fps < 1 || fps > 480) return "";
    return Math.round(fps) + " fps";
  }

  // Codec string (RFC 6381) -> the name people know. Unknown codecs are shown by their family tag.
  function codecName(codec) {
    if (!codec) return "";
    const c = String(codec).split(",")[0].trim().toLowerCase();
    if (/^(avc1|avc3)/.test(c)) return "H.264";
    if (/^(hvc1|hev1)/.test(c)) return "H.265";
    if (/^av01/.test(c)) return "AV1";
    if (/^vp0?9/.test(c)) return "VP9";
    if (/^vp0?8/.test(c)) return "VP8";
    if (/^(mp4v|mpeg4)/.test(c)) return "MPEG-4";
    if (/^(mpeg2|mp2v)/.test(c)) return "MPEG-2";
    return c.split(".")[0].toUpperCase();
  }

  function audioName(codec) {
    if (!codec) return "";
    const c = String(codec).split(",")[0].trim().toLowerCase();
    if (/^mp4a/.test(c)) return "AAC";
    if (c === "ac-3" || c === "ac3") return "AC-3";
    if (c === "ec-3" || c === "eac3") return "E-AC-3";
    if (c === "mp3" || c === "mp2") return c.toUpperCase();
    if (/^opus/.test(c)) return "Opus";
    if (/^flac/.test(c)) return "FLAC";
    return c.split(".")[0].toUpperCase();
  }

  function mimeFor(kind, codec) {
    const c = String(codec).toLowerCase();
    if (kind === "audio" && (c === "mp3" || c === "mp2")) return "audio/mpeg";
    return `${kind}/mp4; codecs="${codec}"`;
  }

  // Why might this stream not play here? info = { codec, audioCodec, hasVideo, hasAudio } as read from the
  // stream; isSupported = MediaSource.isTypeSupported (injected so it can be tested).
  // -> { problems: [..], summary: "Video: H.265 · Audio: AC-3", text: ready-to-show explanation }
  function diagnose(info, isSupported) {
    info = info || {};
    const vName = codecName(info.codec), aName = audioName(info.audioCodec);
    const problems = [];
    if (info.hasVideo === false) {
      problems.push("The stream has no video this player can decode (for example MPEG-2 video) \u2013 sound only.");
    } else if (info.codec && isSupported && !isSupported(mimeFor("video", info.codec))) {
      problems.push(`This PC can't decode the video format (${vName}).` + (vName === "H.265" ? " H.265 needs a GPU / Windows 'HEVC Video Extensions' that support it." : ""));
    }
    if (info.audioCodec && isSupported && !isSupported(mimeFor("audio", info.audioCodec))) {
      problems.push(`This PC can't decode the audio format (${aName}).`);
    }
    const summary = [vName && "Video: " + vName, aName && "Audio: " + aName].filter(Boolean).join(" \u00B7 ");
    let text = problems.join("\n");
    if (!problems.length && summary) text = `${summary}. These formats are supported here, so the cause is more likely the stream or provider (connection limit, unstable source).`;
    return { problems, summary, text };
  }

  function bitrateText(bps) {
    bps = Number(bps);
    if (!Number.isFinite(bps) || bps < 1000) return "";
    if (bps >= 1e6) return (bps / 1e6).toFixed(1) + " Mbps";
    return Math.round(bps / 1000) + " kbps";
  }

  // Keeps the last few (time, frames, bytes) samples. Rates are computed over the whole window, so one
  // stalled second does not make the numbers jump. Counters going backwards (new stream) clear it.
  class Sampler {
    constructor(windowMs = 4000) { this.windowMs = windowMs; this.s = []; }
    reset() { this.s = []; }
    push(t, frames, bytes) {
      const last = this.s[this.s.length - 1];
      if (last && (frames < last.frames || (bytes != null && last.bytes != null && bytes < last.bytes) || t <= last.t)) this.s = [];
      this.s.push({ t, frames, bytes });
      while (this.s.length > 2 && t - this.s[0].t > this.windowMs) this.s.shift();
    }
    // -> { fps, bps } (each 0 when it cannot be known yet; needs >= ~2 s of samples)
    rates() {
      const a = this.s[0], b = this.s[this.s.length - 1];
      if (!a || a === b || b.t - a.t < 1900) return { fps: 0, bps: 0 };
      const sec = (b.t - a.t) / 1000;
      const fps = b.frames > a.frames ? (b.frames - a.frames) / sec : 0;
      const bps = a.bytes != null && b.bytes != null && b.bytes > a.bytes ? ((b.bytes - a.bytes) * 8) / sec : 0;
      return { fps, bps };
    }
  }

  // Everything the bar needs. v = { width, height }, rates = Sampler.rates(), eng = engine.info()
  // -> { video: "1080p · 50 fps · H.264", bitrate: "6.2 Mbps", title: tooltip }  (empty strings when unknown)
  function summarize(v, rates, eng) {
    eng = eng || {}; rates = rates || {};
    const width = v && v.width, height = v && v.height;
    if (!height) return { video: "", bitrate: "", title: "" };
    const fps = rates.fps || Number(eng.fps) || 0;
    const fpsSrc = rates.fps ? "measured" : "declared by the stream";
    const bps = rates.bps || Number(eng.bps) || 0;
    const bpsSrc = rates.bps ? "video, measured at the decoder" : "stream, measured while downloading";
    const parts = [qualityLabel(width, height), fpsText(fps), codecName(eng.codec)].filter(Boolean);
    const title = [
      `Resolution: ${width}\u00D7${height}`,
      fps ? `Frame rate: ${(Math.round(fps * 10) / 10)} fps (${fpsSrc})` : "",
      eng.codec ? `Codec: ${codecName(eng.codec)} (${eng.codec})` : "",
      eng.audioCodec ? `Audio: ${audioName(eng.audioCodec)} (${eng.audioCodec})` : "",
      bps ? `Bitrate: ${bitrateText(bps)} (${bpsSrc})` : ""
    ].filter(Boolean).join("\n");
    return { video: parts.join(" \u00B7 "), bitrate: bitrateText(bps), title };
  }

  return { qualityLabel, fpsText, codecName, audioName, bitrateText, diagnose, Sampler, summarize };
});
