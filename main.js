// Electron main process: window, local stream proxy, data service, IPC.
const { app, BrowserWindow, ipcMain, powerSaveBlocker, Menu, shell, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const { Service } = require("./src/core/service");
const { createProxy } = require("./src/core/streamProxy");
const { safeFileName } = require("./src/core/m3uExport");
const sports = require("./src/core/sports");

const DEV = process.argv.includes("--dev") || process.env.IPTV_DEV === "1";
if (process.env.IPTV_DATA) app.setPath("userData", process.env.IPTV_DATA); // tests / portable use

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
let service = null;
let proxy = null;
let blockerId = null;
let exporting = false, exportCancel = false;

const handlers = {
  info: () => ({ proxyBase: proxy.base(), platform: process.platform, version: app.getVersion() }),
  "sources.list": () => service.listSources(),
  "sources.save": (f) => service.saveSource(f),
  "sources.markUsed": (id) => service.markUsed(id),
  "sources.remove": (id) => service.removeSource(id),
  "sources.refresh": (id) => service.refreshSource(id),
  "categories.get": (sid) => service.getCategories(sid),
  "categories.toggleStar": (sid, id) => service.toggleStar(sid, id),
  "categories.saveStarOrder": (sid, ids) => service.store.saveStarOrder(sid, ids),
  "categories.setHidden": (sid, ids) => service.store.setHidden(sid, ids),
  "list.load": (sid, spec) => service.loadList(sid, spec),
  "list.refreshSearch": (sid, q) => service.refreshSearch(sid, q),
  "sports.leagues": () => service.sportsLeagues(),
  "sports.near": () => sports.loadNear(),
  "sports.rest": (ids) => sports.loadRest(ids),
  "sports.live": () => sports.loadLive(),
  "sports.find": (sid, game) => service.findGameStreams(sid, game),
  "epg.get": (sid, url) => service.getEpg(sid, url),
  "epg.prefetch": (sid, urls) => { service.prefetchEpg(sid, urls); },
  "epgShift.get": (sid) => service.getEpgShift(sid),
  "epgShift.set": (sid, minutes) => service.setEpgShift(sid, minutes),
  // Download as M3U: ask where to save first (so a cancel wastes nothing), then prepare with progress events.
  "export.m3u": async (sid) => {
    if (exporting) throw new Error("An export is already running");
    const src = service.store.getSource(sid);
    if (!src) throw new Error("Source not found");
    const r = await dialog.showSaveDialog(win, {
      title: "Save playlist",
      defaultPath: path.join(app.getPath("downloads"), safeFileName(src.name) + ".m3u"),
      filters: [{ name: "M3U playlist", extensions: ["m3u", "m3u8"] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    exporting = true; exportCancel = false;
    try {
      win.webContents.send("export-progress", { done: 0, total: 0, channels: 0, group: "" });
      return await service.exportM3u(sid, r.filePath, {
        onProgress: (p) => { if (win && !win.isDestroyed()) win.webContents.send("export-progress", p); },
        isCancelled: () => exportCancel
      });
    } finally { exporting = false; }
  },
  // Backup & restore: one JSON file (favourite lists, starred/hidden categories, EZ List, EPG shift; no logins).
  "backup.export": async (opts) => {
    const backup = require("./src/core/backup");
    const r = await dialog.showSaveDialog(win, {
      title: "Save backup",
      defaultPath: path.join(app.getPath("downloads"), backup.fileName()),
      filters: [{ name: "IPTV Lite backup", extensions: ["json"] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, service.exportBackup(!!(opts && opts.includeLogins)), "utf8");
    return { path: r.filePath };
  },
  "backup.import": async () => {
    const r = await dialog.showOpenDialog(win, {
      title: "Choose a backup file",
      defaultPath: app.getPath("downloads"),
      properties: ["openFile"],
      filters: [{ name: "IPTV Lite backup", extensions: ["json"] }]
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const f = r.filePaths[0];
    if (fs.statSync(f).size > 50 * 1024 * 1024) throw new Error("That file is too big to be a backup");
    return service.importBackup(fs.readFileSync(f, "utf8"));
  },
  "export.cancel": () => { exportCancel = true; },
  "export.reveal": (p) => { if (typeof p === "string" && /\.m3u8?$/i.test(p)) shell.showItemInFolder(p); },
  "favourites.get": (sid, listId) => service.store.getFavourites(sid, listId),
  "favourites.toggle": (sid, ch, listId) => service.store.toggleFavourite(sid, ch, listId),
  "favourites.saveOrder": (sid, chs, listId) => service.store.saveFavouritesOrder(sid, chs, listId),
  "favourites.membership": (sid, url) => service.store.favMembership(sid, url),
  "favourites.allUrls": (sid) => service.store.allFavouriteUrls(sid),
  "favlists.get": (sid) => service.store.listFavLists(sid),
  "favlists.create": (sid, name) => service.store.createFavList(sid, name),
  "favlists.rename": (sid, id, name) => service.store.renameFavList(sid, id, name),
  "favlists.delete": (sid, id) => service.store.deleteFavList(sid, id),
  "recent.get": (sid) => service.store.getRecent(sid),
  "recent.add": (sid, ch) => { service.store.addRecent(sid, ch); },
  "ez.get": (sid) => service.store.getEz(sid),
  "ez.set": (sid, slot, ch) => service.store.setEzSlot(sid, slot, ch),
  "ui.get": () => service.store.getUi(),
  "ui.set": (patch) => service.store.setUi(patch),
  "session.load": () => service.store.getSession(),
  "session.save": (s) => service.store.setSession(s),
  "session.clear": () => service.store.clearSession(),
  "player.active": (on) => {
    if (on && blockerId === null) blockerId = powerSaveBlocker.start("prevent-display-sleep");
    if (!on && blockerId !== null) { powerSaveBlocker.stop(blockerId); blockerId = null; }
  },
  "win.toggleFullscreen": () => { win.setFullScreen(!win.isFullScreen()); return win.isFullScreen(); },
  "win.setFullscreen": (on) => { win.setFullScreen(!!on); return win.isFullScreen(); },
  "win.isFullscreen": () => win.isFullScreen()
};

function trustedSender(e) {
  const url = e.senderFrame && e.senderFrame.url;
  return typeof url === "string" && url.startsWith("file://");
}

function createWindow() {
  const ui = service.store.getUi();
  const b = ui.window || {};
  win = new BrowserWindow({
    width: b.width || 1280, height: b.height || 760, x: b.x, y: b.y,
    minWidth: 720, minHeight: 480,
    backgroundColor: "#121212",
    title: "TaZ IPTV",
    icon: path.join(__dirname, "build", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false,
      autoplayPolicy: "no-user-gesture-required"
    }
  });
  if (b.maximized) win.maximize();
  if (!DEV) Menu.setApplicationMenu(null);

  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("enter-full-screen", () => win.webContents.send("fullscreen", true));
  win.on("leave-full-screen", () => win.webContents.send("fullscreen", false));
  win.on("close", () => {
    if (win.isFullScreen() || win.isMinimized()) return;
    service.store.setUi({ window: Object.assign(win.getNormalBounds(), { maximized: win.isMaximized() }) });
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  if (DEV) win.webContents.openDevTools({ mode: "detach" });
  return win;
}

app.whenReady().then(async () => {
  service = new Service(app.getPath("userData"));
  proxy = createProxy();
  await proxy.start();

  ipcMain.handle("api", async (e, name, args) => {
    if (!trustedSender(e) || !Object.prototype.hasOwnProperty.call(handlers, name)) throw new Error("Blocked");
    return handlers[name](...(Array.isArray(args) ? args : []));
  });
  createWindow();
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => { if (proxy) proxy.close(); app.quit(); });
app.on("web-contents-created", (_e, contents) => contents.on("will-attach-webview", (ev) => ev.preventDefault()));
