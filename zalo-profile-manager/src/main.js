"use strict";

const { app, BrowserWindow, ipcMain, Menu, nativeImage, net, Notification, safeStorage, screen, session, shell, Tray } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const {
  assertOwnedProfilePath,
  assertResolvedProxyRoute,
  decodeMeta,
  ensurePatched,
  ensureProfileData,
  generateAutomaticIdentity,
  isGlobalIp,
  killProfile,
  launchZalo,
  defaultBrowserPolicy,
  sameLaunchConfig,
  sameBrowserPolicy,
  resolveZaloInstall,
  nextAvailableAppDataId,
  profileTitle,
  processesForAppDataId,
  publicProfile,
  queryZaloProcesses,
  reconcileProfileRuntime,
  sameProxyConfig,
  sanitizeProfile,
  sanitizeProxy,
  waitForProfileProcess,
  watchWindowTitle,
  writeFileAtomic,
} = require("./native-core");
const { boundedJsonRequest } = require("./bounded-json-request");
const { persistGeneratedIdentity } = require("./identity-persistence");
const { AccountAgent } = require("./account/agent");
const { AccountApiClient } = require("./account/api-client");
const { CredentialStore } = require("./account/credential-store");
const { UpdateManager } = require("./update-manager");

const profileRuntime = new Map();
const activeProfileOperations = new Set();
let managerWindow;
let managerForegroundTimer;
let runtimePollTimer;
let runtimeRefreshPromise;
let zaloLaunchQueue = Promise.resolve();
let isQuitting = false;
let accountAgent;
let tray;
let updateManager;
let notifiedUpdateVersion = "";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function profilesPath() {
  return path.join(app.getPath("userData"), "profiles.json");
}

function nativeDataIds() {
  try {
    return fs.readdirSync(app.getPath("appData"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^ZaloData_[1-9]\d{0,8}$/.test(entry.name))
      .map((entry) => Number(entry.name.slice("ZaloData_".length)));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Không thể đọc danh sách ZaloData:", error.message);
    return [];
  }
}

function readProfiles() {
  try {
    const data = JSON.parse(fs.readFileSync(profilesPath(), "utf8"));
    if (!Array.isArray(data)) return [];
    const used = new Set();
    const reserved = new Set(nativeDataIds());
    let changed = false;
    for (const profile of data) {
      const current = Number(profile.appDataId);
      if (Number.isSafeInteger(current) && current > 0 && current <= 999999999 && !used.has(current)) {
        used.add(current);
        continue;
      }
      let candidate = 1000;
      while (used.has(candidate) || reserved.has(candidate)) candidate += 1;
      profile.appDataId = candidate;
      used.add(candidate);
      changed = true;
    }
    if (changed) writeFileAtomic(profilesPath(), JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Không thể đọc registry profiles.json: ${error.message}`);
    return [];
  }
}

function writeProfiles(profiles) {
  writeFileAtomic(profilesPath(), JSON.stringify(profiles, null, 2));
}

function runtimeFor(profile) {
  return profileRuntime.get(profile.id) || { status: "idle" };
}

function visibleProfiles() {
  return readProfiles().map((profile) => publicProfile(profile, runtimeFor(profile)));
}

function notifyProfilesChanged() {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send("profiles:changed", visibleProfiles());
}

function assertTrustedSender(event) {
  if (!managerWindow || managerWindow.isDestroyed() || event.sender !== managerWindow.webContents) throw new Error("IPC sender không hợp lệ.");
  const expected = pathToFileURL(path.join(__dirname, "index.html")).href;
  if (event.senderFrame?.url !== expected) throw new Error("IPC frame không hợp lệ.");
}

function guarded(channel, operation, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    assertTrustedSender(event);
    accountAgent.assertAllowed(operation);
    const result = await handler(event, ...args);
    try {
      accountAgent.assertAllowed(operation);
    } catch (error) {
      if (operation === "open" || operation === "restart") await killManagedProfiles();
      throw error;
    }
    return result;
  });
}

async function killManagedProfiles() {
  activeProfileOperations.clear();
  const failures = [];
  for (const profile of readProfiles()) {
    let lastError;
    for (const delay of [0, 250, 750]) {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      try {
        await killProfile(profile.appDataId);
        const remaining = (await queryZaloProcesses(profile.appDataId)).filter((item) => item.appDataId === Number(profile.appDataId));
        if (remaining.length === 0) { lastError = null; break; }
        lastError = new Error(`${remaining.length} process vẫn đang chạy.`);
      } catch (error) { lastError = error; }
    }
    if (lastError) failures.push(`${profile.id}: ${lastError.message}`);
    else profileRuntime.delete(profile.id);
  }
  notifyProfilesChanged();
  if (failures.length) throw new Error(`Không thể xác minh đã dừng profiles: ${failures.join("; ")}`);
}

function notifyAccountChanged(account) {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send("account:changed", account);
}

function notifyUpdateChanged(update) {
  if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.send("update:changed", update);
  if (update.status === "downloaded" && update.latestVersion !== notifiedUpdateVersion) {
    notifiedUpdateVersion = update.latestVersion;
    if (Notification.isSupported()) {
      const notification = new Notification({
        title: `ZPool ${update.latestVersion} đã sẵn sàng`,
        body: "Bộ cài đã tải xong. Mở mục Cập nhật để cài phiên bản mới.",
        icon: path.join(__dirname, "Img", "logoZP.ico"),
      });
      notification.on("click", () => { createManagerWindow(); notifyUpdateChanged(updateManager.projection()); });
      notification.show();
    }
  }
}

function readActiveRoute(appDataId) {
  const meta = decodeMeta(fs.readFileSync(path.join(app.getPath("appData"), `ZaloData_${appDataId}`, "meta.bin"), "utf8"));
  const proxy = meta.proxyConfig || {};
  const bp = meta.browserPolicy || {};
  const perm = bp.permissions || {};
  return {
    proxy: {
      enabled: Boolean(proxy.enabled),
      protocol: proxy.protocol || "http",
      host: proxy.host || "",
      port: proxy.port || "",
      useAuthentication: Boolean(proxy.useAuthentication),
      username: proxy.username || "",
      password: proxy.password || "",
    },
    proxyPublicIp: meta.proxyPublicIp || "",
    browserPolicy: {
      permissions: {
        geolocation: Boolean(perm.geolocation),
        camera: Boolean(perm.camera),
        microphone: Boolean(perm.microphone),
        notifications: Boolean(perm.notifications),
      },
      userAgent: bp.userAgent || "",
    },
    automaticIdentity: meta.automaticIdentity || null,
  };
}

async function refreshRuntime() {
  if (runtimeRefreshPromise) return runtimeRefreshPromise;
  runtimeRefreshPromise = refreshRuntimeOnce().finally(() => { runtimeRefreshPromise = null; });
  return runtimeRefreshPromise;
}

async function refreshRuntimeOnce() {
  let processes;
  try { processes = await queryZaloProcesses(); } catch (error) {
    console.warn("Process discovery unavailable:", error.message);
    return false;
  }
  const profiles = readProfiles();
  const runtimeProfiles = profiles.map((profile) => {
    try {
      const activeRoute = readActiveRoute(profile.appDataId);
      return {
        ...profile,
        activeProxy: activeRoute.proxy,
        activeProxyPublicIp: activeRoute.proxyPublicIp,
        activeBrowserPolicy: activeRoute.browserPolicy,
        activeAutomaticIdentity: activeRoute.automaticIdentity,
      };
    } catch {
      return profile;
    }
  });
  return reconcileProfileRuntime(profileRuntime, runtimeProfiles, processes, activeProfileOperations);
}

async function pollRuntime() {
  try {
    if (await refreshRuntime()) notifyProfilesChanged();
  } catch (error) {
    console.warn("Runtime refresh unavailable:", error.message);
  } finally {
    if (!isQuitting) runtimePollTimer = setTimeout(pollRuntime, 1500);
  }
}

function launchProfileProcess(executable, appDataId) {
  const operation = zaloLaunchQueue.then(async () => {
    launchZalo(executable, appDataId);
    try {
      return await waitForProfileProcess(appDataId, { executable });
    } finally {
      // Let Chromium finish expanding its process tree before starting another profile.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  });
  zaloLaunchQueue = operation.catch(() => {});
  return operation;
}

async function openProfile(id) {
  accountAgent.assertAllowed("open");
  if (activeProfileOperations.has(id)) throw new Error("Profile đang được mở; vui lòng chờ thao tác hiện tại hoàn tất.");
  const profiles = readProfiles();
  const index = profiles.findIndex((profile) => profile.id === id);
  if (index < 0) throw new Error("Không tìm thấy profile.");
  const profile = profiles[index];
  const hookRoot = path.join(__dirname, "zpool");
  const install = resolveZaloInstall(process.resourcesPath, undefined, undefined, undefined, hookRoot);

  activeProfileOperations.add(id);
  profileRuntime.set(id, { status: "starting" });
  notifyProfilesChanged();
  try {
    const patchResult = install.bundled
      ? { changed: false }
      : await ensurePatched(install.archive, hookRoot);
    const existing = processesForAppDataId(await queryZaloProcesses(profile.appDataId), profile.appDataId, install.executable);
    if (existing.length > 0) {
      const roots = existing.filter((item) => !existing.some((child) => child.pid === item.parentPid));
      if (roots.length !== 1) throw new Error("Không thể xác định process Zalo của profile.");
      const activeRoute = readActiveRoute(profile.appDataId);
      const activeProfile = {
        ...profile,
        proxy: activeRoute.proxy,
        proxyPublicIp: activeRoute.proxyPublicIp,
        browserPolicy: activeRoute.browserPolicy,
        automaticIdentity: activeRoute.automaticIdentity,
      };
      ensureProfileData(app.getPath("appData"), activeProfile);
      profileRuntime.set(id, {
        status: !patchResult.changed && sameLaunchConfig(activeProfile, profile) ? "running" : "restart-required",
        pid: roots[0].pid,
        activeProxy: activeProfile.proxy,
        proxyPublicIp: activeProfile.proxyPublicIp,
        activeBrowserPolicy: activeProfile.browserPolicy,
        activeAutomaticIdentity: activeProfile.automaticIdentity,
      });
      void watchWindowTitle(profile.appDataId, profileTitle(activeProfile));
      notifyProfilesChanged();
      return true;
    }
    let launchProfile = { ...profile };
    if (!launchProfile.automaticIdentity) {
      const identityResult = await generateIdentityForProfile(profile);
      accountAgent.assertAllowed("open");
      ({ launchProfile } = persistGeneratedIdentity({
        id,
        expectedProfile: profile,
        identityResult,
        readProfiles,
        readRegistry: () => fs.readFileSync(profilesPath()),
        writeProfiles,
        restoreRegistry: (content) => writeFileAtomic(profilesPath(), content),
        ensureProfileData: (committedProfile) => ensureProfileData(app.getPath("appData"), committedProfile),
        sameGenerationConfig: (expected, current) => Number(expected.appDataId) === Number(current.appDataId)
          && sameProxyConfig(expected.proxy, current.proxy)
          && sameBrowserPolicy(expected.browserPolicy || defaultBrowserPolicy(), current.browserPolicy || defaultBrowserPolicy()),
      }));
    } else {
      accountAgent.assertAllowed("open");
      ensureProfileData(app.getPath("appData"), launchProfile);
    }
    accountAgent.assertAllowed("open");
    const processInfo = await launchProfileProcess(install.executable, profile.appDataId);
    profileRuntime.set(id, {
      status: "running",
      pid: processInfo.pid,
      activeProxy: launchProfile.proxy,
      proxyPublicIp: launchProfile.proxyPublicIp || "",
      activeBrowserPolicy: launchProfile.browserPolicy || defaultBrowserPolicy(),
      activeAutomaticIdentity: launchProfile.automaticIdentity,
    });
    const latestProfiles = readProfiles();
    const latestIndex = latestProfiles.findIndex((item) => item.id === id);
    if (latestIndex >= 0) {
      latestProfiles[latestIndex] = { ...latestProfiles[latestIndex], proxyPublicIp: launchProfile.proxyPublicIp || "", lastOpenedAt: new Date().toISOString() };
      writeProfiles(latestProfiles);
    }
    void watchWindowTitle(profile.appDataId, profileTitle(launchProfile));
    notifyProfilesChanged();
    return true;
  } catch (error) {
    profileRuntime.set(id, { status: "error", error: error.message });
    notifyProfilesChanged();
    throw error;
  } finally {
    activeProfileOperations.delete(id);
  }
}

async function closeProfile(id) {
  const profile = readProfiles().find((item) => item.id === id);
  if (!profile) return false;
  activeProfileOperations.add(id);
  profileRuntime.set(id, { status: "stopping" });
  notifyProfilesChanged();
  try {
    const stopped = await killProfile(profile.appDataId);
    profileRuntime.delete(id);
    notifyProfilesChanged();
    return stopped;
  } catch (error) {
    profileRuntime.set(id, { status: "error", error: error.message });
    notifyProfilesChanged();
    throw error;
  } finally {
    activeProfileOperations.delete(id);
  }
}

function bringManagerWindowToForeground() {
  if (managerForegroundTimer) clearTimeout(managerForegroundTimer);
  if (managerWindow.isMinimized()) managerWindow.restore();
  managerWindow.show();
  managerWindow.setAlwaysOnTop(true);
  managerWindow.moveTop();
  managerWindow.focus();
  const window = managerWindow;
  managerForegroundTimer = setTimeout(() => {
    managerForegroundTimer = null;
    if (!window.isDestroyed()) window.setAlwaysOnTop(false);
  }, 1000);
}

function createManagerWindow() {
  if (managerWindow && !managerWindow.isDestroyed()) {
    bringManagerWindowToForeground();
    return managerWindow;
  }
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.min(1280, workWidth);
  const windowHeight = Math.min(900, workHeight);
  managerWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.min(640, workWidth),
    minHeight: Math.min(450, workHeight),
    useContentSize: true,
    resizable: true,
    maximizable: true,
    fullscreenable: false,
    title: "ZPool",
    icon: path.join(__dirname, "Img", "logoZP.ico"),
    backgroundColor: "#f5f7f6",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      zoomFactor: 1,
    },
  });
  managerWindow.webContents.setVisualZoomLevelLimits(1, 1);
  managerWindow.webContents.on("before-input-event", (event, input) => {
    if ((input.control || input.meta) && ["+", "=", "-", "0"].includes(input.key)) event.preventDefault();
  });
  managerWindow.webContents.on("zoom-changed", (event) => {
    event.preventDefault();
    if (managerWindow && !managerWindow.isDestroyed()) managerWindow.webContents.setZoomFactor(1);
  });
  const sendContentSize = () => {
    if (!managerWindow || managerWindow.isDestroyed() || managerWindow.webContents.isLoading()) return;
    managerWindow.webContents.send("window:content-size", managerWindow.getContentSize());
  };
  managerWindow.webContents.on("did-finish-load", sendContentSize);
  managerWindow.on("resize", sendContentSize);
  managerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  managerWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== pathToFileURL(path.join(__dirname, "index.html")).href) event.preventDefault();
  });
  managerWindow.loadFile(path.join(__dirname, "index.html"));
  managerWindow.on("close", (event) => {
    if (!isQuitting) {
      event.preventDefault();
      managerWindow.hide();
    }
  });
  managerWindow.on("closed", () => { managerWindow = null; });
  return managerWindow;
}

function createTray() {
  const iconPath = path.join(__dirname, "Img", "logoZP.ico");
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip("ZPool");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Mở ZPool", click: () => createManagerWindow() },
    { type: "separator" },
    { label: "Thoát ZPool và dừng profiles", click: () => app.quit() },
  ]));
  tray.on("double-click", () => createManagerWindow());
}

async function configureIdentitySession(targetSession, proxy) {
  if (proxy.enabled) {
    await targetSession.setProxy({ proxyRules: `${proxy.protocol}://${proxy.host}:${proxy.port}` });
  } else {
    await targetSession.setProxy({ mode: "direct" });
  }
  await targetSession.closeAllConnections();
}

async function requestPublicIp(targetSession, proxy) {
  const response = await boundedJsonRequest(net.request, {
    url: "https://api64.ipify.org?format=json",
    session: targetSession,
    proxy,
  });
  if (!isGlobalIp(response.ip)) throw new Error("Route không trả về IP public global hợp lệ.");
  return response.ip;
}

async function generateIdentityForProfile(profile) {
  const proxy = sanitizeProxy(profile.proxy, profile.proxy);
  const identitySession = session.fromPartition(`identity-${crypto.randomUUID()}`, { cache: false });
  try {
    await configureIdentitySession(identitySession, proxy);
    const route = assertResolvedProxyRoute(await identitySession.resolveProxy("https://api64.ipify.org/"), proxy);
    const ip = await requestPublicIp(identitySession, proxy);
    const geoIp = await boundedJsonRequest(net.request, {
      url: `https://ipwho.is/${ip}`,
      session: identitySession,
      proxy,
    });
    return { ip, route, identity: generateAutomaticIdentity(ip, geoIp) };
  } finally {
    await identitySession.closeAllConnections().catch(() => {});
    await identitySession.clearStorageData().catch(() => {});
  }
}

async function testProxyConnection(input) {
  const proxy = sanitizeProxy({ ...input, enabled: true }, input);
  const testSession = session.fromPartition(`proxy-test-${crypto.randomUUID()}`, { cache: false });
  const startedAt = Date.now();
  try {
    await configureIdentitySession(testSession, proxy);
    const route = assertResolvedProxyRoute(await testSession.resolveProxy("https://api64.ipify.org/"), proxy);
    const ip = await requestPublicIp(testSession, proxy);
    return { ok: true, ip, route, latency: Date.now() - startedAt, status: 200 };
  } catch (error) {
    return { ok: false, message: error.message };
  } finally {
    await testSession.clearStorageData();
  }
}

ipcMain.handle("profiles:list", async (event) => {
  assertTrustedSender(event);
  await refreshRuntime();
  return visibleProfiles();
});

guarded("profiles:save", "save", async (_event, input) => {
  const profiles = readProfiles();
  const index = input?.id ? profiles.findIndex((profile) => profile.id === input.id) : -1;
  const existing = index >= 0 ? profiles[index] : {};
  const appDataId = existing.appDataId || nextAvailableAppDataId(profiles, 1000, nativeDataIds());
  const saved = sanitizeProfile(input || {}, existing, appDataId);
  if (index >= 0) profiles[index] = saved;
  else profiles.unshift(saved);
  writeProfiles(profiles);

  const runtime = runtimeFor(saved);
  if (runtime.status === "running" || runtime.status === "restart-required") {
    const activeProfile = {
      ...saved,
      proxy: runtime.activeProxy || existing.proxy || saved.proxy,
      proxyPublicIp: runtime.proxyPublicIp || existing.proxyPublicIp || "",
      browserPolicy: runtime.activeBrowserPolicy || existing.browserPolicy || saved.browserPolicy || defaultBrowserPolicy(),
      automaticIdentity: Object.hasOwn(runtime, "activeAutomaticIdentity")
        ? runtime.activeAutomaticIdentity
        : existing.automaticIdentity || saved.automaticIdentity,
    };
    ensureProfileData(app.getPath("appData"), activeProfile);
    profileRuntime.set(saved.id, {
      ...runtime,
      status: sameLaunchConfig(activeProfile, saved) ? "running" : "restart-required",
    });
    if (runtime.pid) void watchWindowTitle(saved.appDataId, profileTitle(activeProfile));
  }
  notifyProfilesChanged();
  return publicProfile(saved, runtimeFor(saved));
});

guarded("profiles:delete", "delete", async (_event, id) => {
  const profiles = readProfiles();
  const profile = profiles.find((item) => item.id === id);
  if (!profile) return false;
  await closeProfile(id);
  const dataPath = assertOwnedProfilePath(
    app.getPath("appData"),
    path.join(app.getPath("appData"), `ZaloData_${Number(profile.appDataId)}`),
    profile.appDataId,
    profiles.map((item) => item.appDataId)
  );
  fs.rmSync(dataPath, { recursive: true, force: true });
  writeProfiles(profiles.filter((item) => item.id !== id));
  profileRuntime.delete(id);
  notifyProfilesChanged();
  return true;
});

guarded("profiles:open", "open", (_event, id) => openProfile(id));
ipcMain.handle("profiles:close", (event, id) => { assertTrustedSender(event); return closeProfile(id); });
guarded("profiles:restart", "restart", async (_event, id) => { await closeProfile(id); accountAgent.assertAllowed("restart"); return openProfile(id); });

guarded("proxy:test", "test-proxy", async (_event, input) => {
  return testProxyConnection(input);
});

ipcMain.handle("account:get", (event) => { assertTrustedSender(event); return accountAgent.projection(); });
ipcMain.handle("account:activate", (event, key) => { assertTrustedSender(event); return accountAgent.activate(key); });
ipcMain.handle("account:logout", (event) => { assertTrustedSender(event); return accountAgent.logout(); });
ipcMain.handle("account:recover", (event) => { assertTrustedSender(event); return accountAgent.recover(); });
ipcMain.handle("external:telegram", async (event) => {
  assertTrustedSender(event);
  return shell.openExternal("https://t.me/Trung292sv");
});
ipcMain.handle("update:get", (event) => { assertTrustedSender(event); return updateManager.projection(); });
ipcMain.handle("update:check", (event) => { assertTrustedSender(event); return updateManager.check(); });
ipcMain.handle("update:install", async (event) => {
  assertTrustedSender(event);
  const installer = updateManager.installerPath();
  if (!installer) throw new Error("Bộ cài mới chưa sẵn sàng.");
  await killManagedProfiles();
  spawn(installer, [], { detached: true, stdio: "ignore" }).unref();
  isQuitting = true;
  updateManager.stop();
  accountAgent?.stop();
  tray?.destroy();
  app.quit();
  return true;
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  Menu.setApplicationMenu(null);
  const store = new CredentialStore({ safeStorage, filePath: path.join(app.getPath("userData"), "account.secure") });
  let api = null;
  const accountApiUrl = process.env.ACCOUNT_API_URL || "https://103-253-23-106.sslip.io";
  try { api = new AccountApiClient(accountApiUrl); } catch (error) { console.error("Account API configuration invalid:", error.message); }
  accountAgent = new AccountAgent({ store, api, onState: notifyAccountChanged, onEnforce: killManagedProfiles });
  updateManager = new UpdateManager({
    currentVersion: app.getVersion(),
    downloadDirectory: path.join(app.getPath("userData"), "updates"),
    fetchImpl: (...args) => net.fetch(...args),
  });
  updateManager.on("state", notifyUpdateChanged);
  await accountAgent.initialize();
  await refreshRuntime();
  createTray();
  createManagerWindow();
  runtimePollTimer = setTimeout(pollRuntime, 1500);
  updateManager.start();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createManagerWindow(); });
});

app.on("second-instance", () => createManagerWindow());
app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  clearTimeout(runtimePollTimer);
  void killManagedProfiles().then(() => {
    accountAgent?.stop();
    updateManager?.stop();
    tray?.destroy();
    app.quit();
  }).catch((error) => {
    console.error("Shutdown enforcement failed:", error.message);
    isQuitting = false;
    runtimePollTimer = setTimeout(pollRuntime, 1500);
    const window = createManagerWindow();
    if (window?.webContents.isLoading()) {
      window.webContents.once("did-finish-load", () => window.webContents.send("shutdown:error", error.message));
    } else {
      window?.webContents.send("shutdown:error", error.message);
    }
  });
});
app.on("window-all-closed", () => {});
