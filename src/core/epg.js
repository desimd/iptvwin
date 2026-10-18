// In-memory short-EPG cache for Xtream live channels: "now" + "next" per stream.
// - get(): returns instantly from cache when the entry is still valid, otherwise fetches (deduped).
// - prefetch(): warms the cache for a handful of channels, one request at a time, so a fast channel
//   switch finds its programme info already waiting. A newer prefetch call replaces an older one.
// Nothing is written to disk; programme data is short-lived.

const MAX_ENTRIES = 600;
const FULL_TTL = 30 * 60 * 1000;      // now+next known: re-check after 30 min at the latest
const PARTIAL_TTL = 5 * 60 * 1000;    // only "now" known (or provider returned nothing): try again sooner
const FAILED_TTL = 60 * 1000;         // request failed: don't hammer the server
const PREFETCH_GAP_MS = 150;

// ".../live/<user>/<pass>/<streamId>.<ext>" -> streamId (null for anything else)
function streamIdFromUrl(url) {
  const m = /\/live\/[^/]+\/[^/]+\/(\d+)\.[A-Za-z0-9]+(?:[?#].*)?$/.exec(String(url || ""));
  return m ? m[1] : null;
}

class Epg {
  constructor(fetchFn) {
    this.fetchFn = fetchFn;        // (src, streamId) -> Promise<[{title,start,stop}]>
    this.map = new Map();          // "sid|streamId" -> { listings, at, failed }
    this.inflight = new Map();     // same key -> Promise
    this.prefetchGen = 0;
  }

  _key(sid, streamId) { return sid + "|" + streamId; }

  static view(listings, t) {
    const sorted = listings.slice().sort((a, b) => a.start - b.start);
    const cur = sorted.find((p) => p.start <= t && t < p.stop) || null;
    const upcoming = sorted.filter((p) => p.start > t && (!cur || p.start >= cur.stop));
    return { now: cur, next: upcoming[0] || null, after: upcoming[1] || null }; // "after" = after next (Guide page)
  }

  _fresh(e, t) {
    if (!e) return false;
    const age = t - e.at;
    if (e.failed) return age < FAILED_TTL;
    if (!e.listings.length) return age < PARTIAL_TTL;
    const v = Epg.view(e.listings, t);
    if (!v.now) return false;                  // programme ended / nothing airing -> refetch
    return age < (v.next ? FULL_TTL : PARTIAL_TTL);
  }

  _store(key, entry) {
    this.map.delete(key);                      // re-insert = newest
    this.map.set(key, entry);
    while (this.map.size > MAX_ENTRIES) this.map.delete(this.map.keys().next().value);
  }

  async _load(src, streamId) {
    const key = this._key(src.id, streamId);
    if (this.inflight.has(key)) return this.inflight.get(key);
    let p;
    p = (async () => {
      try {
        const listings = await this.fetchFn(src, streamId);
        if (this.inflight.get(key) === p) this._store(key, { listings, at: Date.now(), failed: false });
      } catch (e) {
        if (this.inflight.get(key) === p) {
          const old = this.map.get(key);
          this._store(key, { listings: old ? old.listings : [], at: Date.now(), failed: true });
        }
      } finally {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }

  // -> { now, next, after } | null (null = not an Xtream live URL)
  async get(src, url) {
    const streamId = streamIdFromUrl(url);
    if (!streamId) return null;
    const key = this._key(src.id, streamId);
    if (!this._fresh(this.map.get(key), Date.now())) await this._load(src, streamId);
    const e = this.map.get(key);
    return e ? Epg.view(e.listings, Date.now()) : { now: null, next: null, after: null };
  }

  // Warm the cache for these channel URLs (in order). Returns immediately.
  prefetch(src, urls) {
    const gen = ++this.prefetchGen;
    const ids = [...new Set(urls.map(streamIdFromUrl).filter(Boolean))];
    (async () => {
      for (const id of ids) {
        if (gen !== this.prefetchGen) return;  // superseded by a newer prefetch
        if (this._fresh(this.map.get(this._key(src.id, id)), Date.now())) continue;
        await this._load(src, id);
        await new Promise((r) => setTimeout(r, PREFETCH_GAP_MS));
      }
    })().catch(() => {});
  }

  clearForSource(sid) {
    this.prefetchGen++;
    for (const k of [...this.map.keys()]) if (k.startsWith(sid + "|")) this.map.delete(k);
    for (const k of [...this.inflight.keys()]) if (k.startsWith(sid + "|")) this.inflight.delete(k); // don't let an old-shift fetch land
  }
}

module.exports = { Epg, streamIdFromUrl };
