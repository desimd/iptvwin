const { contextBridge, ipcRenderer } = require("electron");

// One generic bridge; main only runs names from its own allow-list.
async function call(name, ...args) {
  try {
    return await ipcRenderer.invoke("api", name, args);
  } catch (e) {
    // Electron wraps errors as "Error invoking remote method 'api': Error: msg" - keep just msg.
    throw new Error(String(e && e.message || e).replace(/^Error invoking remote method '[^']*': (Error: )?/, ""));
  }
}

contextBridge.exposeInMainWorld("api", {
  call,
  onFullscreen: (cb) => ipcRenderer.on("fullscreen", (_e, on) => cb(on)),
  onExportProgress: (cb) => ipcRenderer.on("export-progress", (_e, p) => cb(p))
});
