const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("recorderBridge", {
  setWsUrl: (url) => ipcRenderer.invoke("ws-set-url", url),
  send: (obj) => ipcRenderer.send("ws-send", obj),
  onMessage: (handler) => {
    const wrap = (_event, data) => {
      try {
        handler(JSON.parse(data));
      } catch {
        handler(null);
      }
    };
    ipcRenderer.on("ws:message", wrap);
    return () => ipcRenderer.removeListener("ws:message", wrap);
  },
  onStatus: (handler) => {
    const wrap = (_event, data) => handler(data);
    ipcRenderer.on("ws:status", wrap);
    return () => ipcRenderer.removeListener("ws:status", wrap);
  },
});
