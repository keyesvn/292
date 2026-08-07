const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("profilesApi", {
  list: () => ipcRenderer.invoke("profiles:list"),
  save: (profile) => ipcRenderer.invoke("profiles:save", profile),
  remove: (id) => ipcRenderer.invoke("profiles:delete", id),
  open: (id) => ipcRenderer.invoke("profiles:open", id),
  close: (id) => ipcRenderer.invoke("profiles:close", id),
  restart: (id) => ipcRenderer.invoke("profiles:restart", id),
  testProxy: (proxy) => ipcRenderer.invoke("proxy:test", proxy),
  onChanged: (callback) => {
    const handler = (_event, profiles) => callback(profiles);
    ipcRenderer.on("profiles:changed", handler);
    return () => ipcRenderer.removeListener("profiles:changed", handler);
  },
  onShutdownError: (callback) => {
    const handler = (_event, message) => callback(message);
    ipcRenderer.on("shutdown:error", handler);
    return () => ipcRenderer.removeListener("shutdown:error", handler);
  },
});

contextBridge.exposeInMainWorld("accountApi", {
  get: () => ipcRenderer.invoke("account:get"),
  activate: (key) => ipcRenderer.invoke("account:activate", key),
  logout: () => ipcRenderer.invoke("account:logout"),
  recover: () => ipcRenderer.invoke("account:recover"),
  onChanged: (callback) => {
    const handler = (_event, account) => callback(account);
    ipcRenderer.on("account:changed", handler);
    return () => ipcRenderer.removeListener("account:changed", handler);
  },
});

contextBridge.exposeInMainWorld("externalApi", {
  openTelegram: () => ipcRenderer.invoke("external:telegram"),
});

contextBridge.exposeInMainWorld("updateApi", {
  get: () => ipcRenderer.invoke("update:get"),
  check: () => ipcRenderer.invoke("update:check"),
  install: () => ipcRenderer.invoke("update:install"),
  onChanged: (callback) => {
    const handler = (_event, update) => callback(update);
    ipcRenderer.on("update:changed", handler);
    return () => ipcRenderer.removeListener("update:changed", handler);
  },
});

contextBridge.exposeInMainWorld("windowApi", {
  onContentSize: (callback) => {
    const handler = (_event, size) => callback(size);
    ipcRenderer.on("window:content-size", handler);
    return () => ipcRenderer.removeListener("window:content-size", handler);
  },
});
