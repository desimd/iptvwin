// Compact M3U export. Each channel is just two lines (no logos, ids, EPG links or other extras):
//   #EXTINF:-1 group-title="Category",Channel name
//   http://server/live/user/pass/123.ts
// The category name is kept (group-title) because that is what lets other players show the channels grouped.

const cleanText = (s) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
const cleanGroup = (s) => cleanText(s).replace(/"/g, "'");
const safeFileName = (s) => (String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "playlist");

function entry(name, group, url) {
  const g = cleanGroup(group);
  return `#EXTINF:-1${g ? ` group-title="${g}"` : ""},${cleanText(name) || "Channel"}\n${String(url).trim()}\n`;
}

const cancelled = () => Object.assign(new Error("Cancelled"), { cancelled: true });

// batches: [{ group, load: async () => [{name, url, group?}] }]   (one per category, in the order to write)
// write(text) receives the file content piece by piece, so nothing has to be held in memory.
// onProgress({ done, total, channels, group }) after every step; isCancelled() is checked between steps.
// Several batches load at once (concurrency) but are always written in order. A batch that fails twice is
// skipped and reported instead of failing the whole export.
// -> { channels, skipped: [group names] }   throws an Error with .cancelled = true when cancelled
async function exportPlaylist(batches, { write, onProgress, isCancelled, concurrency = 3, retries = 1 }) {
  const total = batches.length;
  let channels = 0;
  const skipped = [];
  write("#EXTM3U\n");
  if (onProgress) onProgress({ done: 0, total, channels: 0, group: "" });
  for (let i = 0; i < total; i += concurrency) {
    if (isCancelled && isCancelled()) throw cancelled();
    const slice = batches.slice(i, i + concurrency);
    const results = await Promise.all(slice.map(async (b) => {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (isCancelled && isCancelled()) return null;
        try { return await b.load(); } catch (e) { /* retry once, then skip */ }
      }
      return undefined;
    }));
    if (isCancelled && isCancelled()) throw cancelled();
    results.forEach((list, j) => {
      const b = slice[j];
      if (list === undefined) { skipped.push(b.group); return; }
      let text = "";
      for (const c of list || []) {
        if (!c || !c.url) continue;
        text += entry(c.name, c.group || b.group, c.url);
        channels++;
      }
      if (text) write(text);
    });
    if (onProgress) onProgress({ done: Math.min(i + concurrency, total), total, channels, group: slice[slice.length - 1].group });
  }
  return { channels, skipped };
}

module.exports = { exportPlaylist, entry, safeFileName };
