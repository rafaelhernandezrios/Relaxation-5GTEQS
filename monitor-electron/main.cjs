const { app, BrowserWindow, ipcMain } = require("electron");

app.commandLine.appendSwitch("ignore-certificate-errors", "true");
const path = require("path");
const WebSocket = require("ws");

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {WebSocket | null} */
let ws = null;
let wsUrl = "wss://127.0.0.1:8765";

function connectWs() {
  if (!mainWindow) return;
  try {
    ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
  } catch (e) {
    mainWindow.webContents.send("ws:status", { state: "error", detail: String(e) });
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    mainWindow.webContents.send("ws:status", { state: "open" });
  });
  ws.on("message", (data) => {
    mainWindow.webContents.send("ws:message", data.toString());
  });
  ws.on("close", () => {
    mainWindow.webContents.send("ws:status", { state: "closed" });
    scheduleReconnect();
  });
  ws.on("error", () => {
    mainWindow.webContents.send("ws:status", { state: "error" });
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 2000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    title: "Relaxation Lab Monitor",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (!app.isPackaged) {
    mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    mainWindow.loadFile(path.join(__dirname, "dist", "index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  connectWs();
}

ipcMain.handle("ws-set-url", (_e, url) => {
  wsUrl = url || wsUrl;
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
    ws = null;
  }
  connectWs();
  return wsUrl;
});

ipcMain.on("ws-send", (_e, payload) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
