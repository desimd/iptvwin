# TaZ IPTV for Windows

Desktop port of the Android TV app. Same features: Xtream Codes + M3U sources, categories with
starred/hidden/reordered categories, Favourites, 5-slot EZ List, search index, adult-content
filter at every layer, name cleaning (country/quality chips), three card styles, four colour
schemes, "where was I" restore. It runs natively (Electron), not in an emulator.

## Get the .exe

**Easiest:** install Node.js LTS (https://nodejs.org), then double-click `build-windows.bat`.
You get, in `dist\`:
- `TaZ-IPTV-Setup-1.0.0.exe`: installer
- `TaZ-IPTV-Portable-1.0.0.exe`: one file, no install (copy it to a USB stick or send it)

Windows shows a blue "SmartScreen" warning on first run (the app is unsigned, which is normal
without a paid certificate). Click **More info → Run anyway**.

**No Node on your PC?** Push this folder to a GitHub repo → Actions → "Build desktop apps" → Run →
download the artifact. (The macOS job is there too, but untested.)

**Just try it:** `run-app.bat` runs it from source.

## Keys

| | |
|---|---|
| Arrows + Enter | Move / open / play |
| Right-click | Favourite, EZ List, Open category (search results), star a category |
| Esc / Backspace / mouse Back | Back (closes panels first) |
| Ctrl+F | Filter the channel list |
| `F` / `E` on a channel | Favourite / add to EZ List |
| **Player:** Up / Down | Previous / next channel |
| Left / Right (or `Z`) | Channel panel / EZ panel (keys 1-5 jump to a slot) |
| Enter · Space · `A` · `C` · `M` | Control bar · pause · aspect · captions · mute |
| Mouse wheel · F11 · double-click | Volume · full screen · full screen |

Press `F1` or `?` in the app for the same list.

## Programme info (EPG)

On Xtream sources the player's info bar shows the channel name with **NOW** and **NEXT** (time + title) underneath,
and pops up whenever the channel changes. After you settle on a channel the app quietly fetches the short EPG
(current + next only) for the next 5 channels in the direction you are surfing (starts with Up), so the
info is already there when you switch. M3U sources have no EPG and the bar looks as before.
Tunables are the constants at the top of `renderer/js/player.js` (`EPG_PREFETCH_COUNT`, `SHOW_BAR_ON_SWITCH`, ...).


## Programme guide (Xtream channel lists)

On any Xtream channel list (category, search, favourites) there is a **G** button next to Settings
(or press `G` on a channel). It opens a guide page with one row per channel showing **Now / Next /
After next** (time range, title, and a progress bar for what's on now). Rows load top to bottom, two
requests at a time; rows you scroll to jump the queue, and the header shows "Loading 23 / 150". The
"now" bars and finished programmes refresh once a minute. Click a row to watch; Back returns to the guide.
It shares the same in-memory EPG cache as the player bar, so nothing is stored on disk.

## Video stats

While the control bar is up, the right side shows the real stats of the stream being played, e.g.
`Video: 1080p · 50 fps · H.264   BitR: 6.2 Mbps` (hover for details). Nothing is read from the channel name:
resolution is the decoded picture size, fps is counted from frames the decoder really produced, codec comes from
the stream itself, and the bitrate is the video data the decoder consumed per second (falling back to what the
player measured while downloading). Values appear after a few seconds of playback and are hidden when unknown.

## When a channel won't play

The player now tells a codec problem from a stream problem. It reads the real video and audio codecs from the stream and
asks the browser engine whether it can decode them. On failure the message says e.g. "This PC can't decode the audio
format (AC-3)" or "Video: H.264 \u00B7 Audio: AAC. These formats are supported here, so the cause is more likely the
stream or provider". It also catches a frozen picture (hops over buffer gaps, restarts after 12 s) and sound without a
decoded picture (restarts, then reports after 3 tries). The audio codec is in the stats tooltip.

### How the player picks its engine

Before playing, the local proxy opens the channel address, reads the first bytes and reports what it really is
(HLS playlist, MPEG-TS, MP4, or a text/web page). The player uses the matching engine straight away instead of guessing
from the address and flipping engines on retries, and the connection that was opened is reused for playback, so the
provider sees one connection. If the provider answers with an HTTP error or a message instead of video, that is shown
(for example "Too many connections for this account (HTTP 509)"). If every attempt fails, the message lists what each
attempt said, plus the codecs and state at the moment of failure (data arriving? picture decoded? what is buffered?).

If a channel fails, the next attempt tries the other form of the same Xtream address (`.ts` <-> `.m3u8`). A stream that
starts but never plays although data is buffered is nudged forward (over a start gap, then to the live edge). An empty
answer from the provider is reported as such.

## Download as M3U

Right-click a playlist on the first page -> **Download as M3U...**. For Xtream sources this exports every category
that is ticked in Manage categories (not only favourites), for M3U sources the whole playlist. Pick where to save, then
a progress dialog shows the category being fetched and the channel count (Cancel / Esc stops it and leaves no partial file).
Each channel is only two lines, name + category + link, no logos or other extras:

    #EXTINF:-1 group-title="News",BBC One
    http://server/live/user/pass/123.ts

Adult content stays filtered. A category the provider fails to deliver twice is skipped and listed at the end.
The links contain the account login, so the file should be kept private.

## Search results

- Right-click a channel → **Open category** opens the category it belongs to, on that channel. Back returns to the results.
- Category matches at the top of the results have a **star**: click it to star / unstar the category without leaving the results.

## Games (live + upcoming)

The **⚽︎** button (top right of the categories page) opens the Games page. **Live** shows each game from
**30 minutes before it starts until 30 minutes after it ends** (refreshes itself every 90 s). ESPN gives no end time,
so the end is when the app saw the game finish (or, if it first saw it already finished, start + a typical length for
the sport). The same window is when a stream can be searched. **Upcoming** has Today / Tomorrow /
Next 7 days with a league picker on the left. Covered: EPL, UCL, UEL, LaLiga, MLS, NBA, NHL (add a league with one
line in `src/core/sports.js`). Data comes from ESPN's public scoreboard, with TheSportsDB as a backup per league.

Enter (or click) on a live / about-to-start game searches the playlist for its stream, trying looser searches until
something matches (e.g. "toronto new york" -> "raptors knicks" -> "raptors" + "knicks"), and opens the results
(right-click -> Open category still works on Xtream). Search everywhere matches all words in any order, for channel names and for category names ("uk sports" finds the category "Sports HD UK").

## M3U playlists on the categories page

M3U sources open on the same categories page as Xtream (source button, search, Games, Manage, Recently played, starred
categories). The playlist's **group-titles are the categories**; channels with no group go to **Other**, and a playlist
with no groups at all gets a single **All channels** entry. Starring, hiding (Manage) and favourites work as for Xtream.
Search matches channel names (first 500 hits) plus matching category names, both with all words in any order. There is no search
index to rebuild for M3U. **Show all channels** (under the starred row) lists the whole playlist; unlike the TV app there
is no 500 cap because the list is virtualised.

## Multiple favourite lists

Besides the built-in **Favourites** you can keep any number of named lists (names up to 24 characters, unique,
case-insensitive; "Favourites" itself is taken).

- **Manage** (top right of the categories page) now opens a small menu: **Manage categories** / **Add new favourite list**.
- New lists appear right after Favourites on the categories page, each new one after the existing ones, with their own
  channel count. **Right-click** a list card for **Rename** / **Delete** (Favourites can't be either).
- **Star, F, or right-click -> Favourite lists...** on a channel (channel lists, search results, the player's channel
  panel): with only Favourites it toggles as before; with more lists a picker shows them (star = already in it),
  the current list first, plus **+ New list...**. A channel's star is filled when it is in *any* list.
- Inside a list, the star removes from that list in place. **Reorder** works per list, and resume reopens the same list.
- Existing favourites are untouched: the default list keeps its old storage; extra lists are new.

## Backup & restore

The **cloud** button on the sources page opens **Export backup...** / **Import backup...**. Exporting asks whether to
include logins. The backup is one small JSON file with, per source: all favourite lists (with their channels), starred
categories (in order), hidden categories, the 5 EZ List slots and the EPG shift.

- **With logins:** each source's server / username / password (or playlist URL) and User-Agent are written too, **in
  plain text**, so keep the file private (protect it however you like: encrypted folder, password-protected zip...).
  Importing it on any PC **re-creates the sources that aren't there yet, exactly as they were** (no network check, so
  it works offline), then restores everything into them. The result is identical: same lists, same order, same links.
- **Without logins** (the safer file to share): add the same sources on the other PC first, then import. Sources are
  matched by a hash of server + username (Xtream) or the playlist URL (M3U), and Xtream channel links are stored
  without the server / user / password part, so they relink to a new login.
- Import only ever **adds**: sources that don't exist yet (with-logins files), favourites not already in a list,
  starred/hidden categories not already set, EZ List slots that are empty, and the EPG shift if none is set. A source
  already on the device keeps its own login. Favourite lists are matched by name (created if missing). Importing the
  same file twice changes nothing the second time.
- Sources in the file that can't be matched or re-created are listed and skipped.
- The format is the Android app's (extra fields are simply ignored there), so backups work both ways.

## EPG shift (per playlist)

If a provider's programme times are off (wrong timezone, etc.), open any channel list of an Xtream playlist →
**Settings (gear) → EPG shift** and press **+** / **−** (30-minute steps, up to ±12 h; **Reset** puts it back to 0).
The shift belongs to that playlist only and is remembered. It applies everywhere in the playlist: the player's
NOW/NEXT bar and the Programme guide. When a shift is set, the app reads the provider's full programme table
(`get_simple_data_table`) instead of the short EPG, because a shift needs programmes that already started or are
further ahead; if the provider doesn't offer it, it falls back to the short EPG. M3U playlists have no EPG, so the
option is hidden there.

## Where things live

- Your data: `%APPDATA%\TaZ IPTV\userdata.json` (sources, favourites, EZ list, prefs); cache in `cache\`.
- Code: `src/core` (logic, same behaviour as the Kotlin files, tested), `renderer` (screens), `main.js`.
- Tests: `npm test` (adult filter, name parser and sort cases are ported from the Android unit tests).

## How playback works

Streams go through a tiny local proxy (127.0.0.1, random port + secret token) so the player can
send your source's User-Agent, follow redirects, and play providers that block browsers. Live
`.ts` plays with mpegts.js, `.m3u8` with hls.js, mp4/webm natively. A wrong guess retries with
the other engine.

## Known limits

- **Dolby audio (AC-3 / E-AC-3) and some HEVC streams:** Chromium can't decode them, so you may get
  picture without sound (or no picture on HEVC without hardware support). Fix, if it matters:
  bundle ffmpeg to transcode, or swap the player for libmpv. Heavier, so not done.
- Unsigned app (SmartScreen warning, see above).

## Categories page (home) layout

Top left is the **source button** (layers icon + first word of the source name): it replaces Back + the source name and
goes to the sources page. The search box sits next to it and stretches to the buttons on the right: **⚽︎ games,
reorder, manage** (manage is last). **Recently played** is one compact boxed row of three small cards above Favourites.

## Tests

`npm test` runs the core tests plus a smoke test of the Games page in a fake browser (`test/games.dom.test.js`). That
one needs `jsdom` (`npm i -D jsdom`) and is skipped when it isn't installed.
