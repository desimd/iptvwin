# TaZ IPTV for Windows

A native desktop port of the Android TV IPTV app, built with **Electron**. It runs natively on Windows without requiring an emulator, delivering the same layout and feature set as the Android TV version.

---

## Features

* **Dual Source Support:** Full compatibility with **Xtream Codes API** and **M3U playlists**.
* **Smart Organization:** Custom categories (star, hide, reorder), multiple custom favourite lists, and a 5-slot **EZ List**.
* **Content Filtering:** Built-in adult-content filter applied uniformly across all layers.
* **Intelligent Video Player:** Automatic stream-type detection via a local proxy, codec validation, video/audio stats overlay, and automatic fallback engines (`mpegts.js`, `hls.js`, and native HTML5).
* **EPG & Programme Guide:** Live Now/Next preview bar, prefetching for fast zapping, full programme guide view, and per-playlist EPG time shifting.
* **Live Sports Integration:** Built-in Games schedule (backed by ESPN and TheSportsDB) with automatic stream matching for major leagues (EPL, UCL, LaLiga, MLS, NBA, NHL, etc.).
* **Backup & Restore:** Seamless JSON-based backup support (with or without credentials) that matches the Android app format.

---

## Getting Started

### Option 1: Quick Install (Easiest)
1. Install [Node.js LTS](https://nodejs.org).
2. Double-click `build-windows.bat`.
3. Find your built files in the `dist\` folder:
   * `TaZ-IPTV-Setup-1.0.0.exe` — Standard installer.
   * `TaZ-IPTV-Portable-1.0.0.exe` — Standalone portable executable.

> **Note:** Windows SmartScreen may show an untrusted publisher warning on first run because the app is unsigned (normal for local or open-source builds). Click **More info → Run anyway**.

### Option 2: Build via GitHub Actions
Push this folder to a GitHub public repository, navigate to **Actions → Build desktop apps**, and run the workflow to download the compiled artifacts.

### Option 3: Run from Source
To test or run the application directly from source code:
```bash
npm install
npm start

Or simply double-click run-app.bat.
Keyboard Shortcuts & Navigation
| Key / Action | Function |
|---|---|
| Arrow Keys + Enter | Move, open, or play content |
| Right-Click | Open context menu (Favourites, EZ List, category actions) |
| Esc / Backspace / Mouse Back | Go back (closes active panels first) |
| Ctrl + F | Filter the current channel list |
| F / E | Toggle Favourite / Add to EZ List |
| Up / Down (Player) | Previous / next channel |
| Left / Right / Z (Player) | Open channel or EZ panel (keys 1–5 jump directly to slots) |
| Enter · Space · A · C · M | Control bar · Pause · Aspect ratio · Captions · Mute |
| Mouse Wheel / F11 | Adjust volume / Toggle full screen |
Press F1 or ? inside the application to view the full interactive shortcut list.
Advanced Usage
Programme Guide & EPG
 * Now / Next Bar: Xtream sources display current and upcoming programme information directly in the player info bar. The app pre-fetches EPG data for upcoming channels to eliminate lag during channel surfing.
 * Programme Guide (G): Press G or click the guide button on any Xtream list to view a multi-row schedule with live progress bars. Click any entry to switch directly to that broadcast.
 * EPG Shift: If provider timestamps are offset by a specific timezone or delay, go to Settings → EPG shift on any Xtream list to adjust times in 30-minute increments (\pm 12 hours).
Live Sports Schedule
Click the ⚽︎ icon on the categories page to open the live and upcoming games tracker.
 * Live view: Updates automatically every 90 seconds. Selecting a match attempts to automatically search and launch the corresponding live stream using smart fuzzy matching.
 * Upcoming view: Browse fixtures for today, tomorrow, or the next 7 days filtered by league.
Video Stats & Diagnostics
While the control bar is active, real-time stream diagnostics are displayed on the right (e.g., 1080p · 50 fps · H.264 · 6.2 Mbps).
 * The built-in diagnostics engine distinguishes between codec mismatches and provider stream failures, providing clear messages if a codec (such as AC-3 or HEVC) is unsupported by the local Chromium engine.
Backup & Restore
Access the cloud icon on the sources page to export or import your configuration.
 * With Logins: Exports server credentials, playlists, custom lists, and preferences in plain JSON format. Keep this file private.
 * Without Logins: Safe to share; links configurations to newly provided credentials automatically upon import.
Project Structure
 * src/core/ — Core business logic, parsers, adult filters, and sports integration tests.
 * renderer/ — UI screens, player interface, and styling.
 * main.js — Electron main process and local stream proxy handler.
Running Tests
Run the core test suite (including adult filter, name parsing, and sorting logic ported from Android tests):
npm test

To run DOM-based component tests (such as the Games page test):
npm install -D jsdom
npm test

Known Limitations
 * Dolby Audio (AC-3 / E-AC-3) & HEVC: Chromium lacks native codecs for certain proprietary audio formats and hardware-dependent video streams. Audio may play without sound or video depending on system hardware support.
 * Unsigned Executable: Requires bypassing the standard Windows SmartScreen prompt on initial launch.

