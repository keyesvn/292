"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const Module = require("node:module");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const electron = require("electron");
const { app } = electron;
const {
  isCaptureHelper,
  isolateCallArguments,
  isolatePipe,
} = require("./zpool-helper");

const instanceSuffix = `${Date.now()}${process.pid}`;
const originalCreateServer = net.createServer;
const liveZBoxWindows = new Set();
let profileDebugPath = null;

function isZBoxDebugEnabled() {
  if (/^(1|true|yes)$/i.test(process.env.ZPM_ZBOX_DEBUG || "")) return true;
  try {
    return fs.existsSync(path.join(path.dirname(app.getPath("exe")), "ZPM_ZBOX_DEBUG.flag"));
  } catch {
    return false;
  }
}

function writeZBoxDebug(message, details) {
  if (!isZBoxDebugEnabled()) return;
  const payload = details === undefined ? "" : ` ${JSON.stringify(details)}`;
  const line = `[${new Date().toISOString()}] ${message}${payload}\n`;
  for (const target of new Set([profileDebugPath, path.join(app.getPath("userData"), "zbox-debug.log")])) {
    if (!target) continue;
    try { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.appendFileSync(target, line, "utf8"); } catch {}
  }
  try { process.stderr.write(`[zpm:zbox] ${message}${payload}\n`); } catch {}
}

// Zalo's in-app browser (ZBox) is created without a partition, so it lands on
// the default session and never sees the profile login. It must be pinned to
// the same `persist:zalo` session the main window uses.
function isZaloInAppBrowserOptions(options) {
  const webPreferences = options?.webPreferences;
  const matched = options?.width === 1250
    && options?.height === 800
    && options?.show === false
    && webPreferences?.nodeIntegration === false
    && webPreferences?.contextIsolation === true
    && webPreferences?.webSecurity === true
    && webPreferences?.devTools === false
    && !webPreferences.partition
    && !webPreferences.session;
  writeZBoxDebug("in-app-browser fingerprint", {
    matched,
    width: options?.width,
    height: options?.height,
    show: options?.show,
  });
  return matched;
}

function sharedZaloSession() {
  const profileSession = electron.session.fromPartition("persist:zalo");
  writeZBoxDebug("shared session resolved", { partition: "persist:zalo" });
  if (!profileSession.__zpmSharedStorageProtected) {
    // InAppBrowser.dispose() calls clearCache() and clearStorageData() from the
    // window `close` handler, before the window is destroyed. On the shared
    // session that wipes the account login, so it is suppressed for as long as
    // a ZBox window is alive.
    for (const method of ["clearCache", "clearStorageData"]) {
      const native = profileSession[method].bind(profileSession);
      profileSession[method] = (...args) => {
        if (liveZBoxWindowCount() > 0) {
          writeZBoxDebug("blocked zBox session cleanup", { method, argumentCount: args.length });
          return Promise.resolve();
        }
        return native(...args);
      };
    }
    Object.defineProperty(profileSession, "__zpmSharedStorageProtected", { value: true });
  }
  traceSharedCookies(profileSession);
  return profileSession;
}

// Cookie names and URLs only: session token values are credentials.
function traceSharedCookies(profileSession) {
  if (!isZBoxDebugEnabled() || profileSession.__zpmCookieTraced) return;
  const { cookies } = profileSession;
  for (const method of ["set", "remove"]) {
    const native = cookies[method].bind(cookies);
    cookies[method] = (...args) => {
      const [first, second] = args;
      writeZBoxDebug(`shared cookie ${method}`, {
        url: typeof first === "string" ? first : first?.url,
        name: typeof first === "string" ? second : first?.name,
        domain: typeof first === "string" ? undefined : first?.domain,
        liveZBoxWindows: liveZBoxWindowCount(),
      });
      return native(...args);
    };
  }
  Object.defineProperty(profileSession, "__zpmCookieTraced", { value: true });
}

// Vendor dispose() calls removeAllListeners() on the window, so a `closed`
// listener never fires. Liveness is polled instead of tracked by event.
function liveZBoxWindowCount() {
  for (const window of liveZBoxWindows) {
    if (window.isDestroyed()) liveZBoxWindows.delete(window);
  }
  return liveZBoxWindows.size;
}

function trackZBoxWindow(window) {
  liveZBoxWindows.add(window);
  // ZaloPC gives ZBox a dedicated `ZaloPC` User-Agent that the account SSO
  // relies on. The external-UA normalization in zpool.js runs on every web
  // contents, so ZBox is flagged here to be left alone.
  window.webContents.__zpmZBox = true;
  writeZBoxDebug("zBox window tracked", { liveWindows: liveZBoxWindowCount() });
  traceZBoxCookieJar(window.webContents.session);
  window.webContents.on("did-navigate", (_event, url) => {
    writeZBoxDebug("zBox navigated", safeLocation(url));
  });
  return window;
}

// Names and domains only: cookie values are credentials. This answers whether
// the zBox window actually sees the account cookies at navigation time.
function traceZBoxCookieJar(zBoxSession) {
  if (!isZBoxDebugEnabled()) return;
  zBoxSession.cookies.get({})
    .then((cookies) => {
      writeZBoxDebug("zBox cookie jar", {
        total: cookies.length,
        domains: [...new Set(cookies.map((cookie) => cookie.domain))].join(","),
        names: [...new Set(cookies.map((cookie) => cookie.name))].join(","),
      });
    })
    .catch((error) => writeZBoxDebug("zBox cookie jar read failed", { message: error?.message }));
}

// Path is needed to tell an SSO bounce apart from a real login page. Query and
// fragment are dropped because they carry one-time auth tokens.
function safeLocation(value) {
  try {
    const { origin, pathname, searchParams } = new URL(value);
    return { origin, pathname, queryKeys: [...searchParams.keys()].join(",") };
  } catch {
    return { origin: "invalid" };
  }
}

function patchZaloInAppBrowserSession() {
  const NativeBrowserWindow = electron.BrowserWindow;
  if (!NativeBrowserWindow || Module._load.__zpmInAppBrowserPatched) return;
  function ProfileBrowserWindow(options, ...rest) {
    if (!isZaloInAppBrowserOptions(options)) return new NativeBrowserWindow(options, ...rest);
    writeZBoxDebug("assigning persist:zalo session to zBox");
    const profileSession = sharedZaloSession();
    const profileOptions = { ...options, webPreferences: { ...options.webPreferences, session: profileSession } };
    return trackZBoxWindow(new NativeBrowserWindow(profileOptions, ...rest));
  }
  ProfileBrowserWindow.prototype = NativeBrowserWindow.prototype;
  Object.setPrototypeOf(ProfileBrowserWindow, NativeBrowserWindow);
  const profileElectron = new Proxy(electron, {
    get(target, property, receiver) {
      if (property === "BrowserWindow") return ProfileBrowserWindow;
      return Reflect.get(target, property, receiver);
    },
  });
  const nativeLoad = Module._load;
  function loadWithProfileBrowserWindow(request, parent, isMain) {
    const loaded = nativeLoad.call(this, request, parent, isMain);
    return request === "electron" ? profileElectron : loaded;
  }
  Object.defineProperty(loadWithProfileBrowserWindow, "__zpmInAppBrowserPatched", { value: true });
  Module._load = loadWithProfileBrowserWindow;
}

function configureProfileUserData(argument) {
  if (!/^--appdata-id=[1-9]\d{0,8}$/.test(argument || "")) return "";
  const appDataId = argument.slice(argument.indexOf("=") + 1);
  global.appDataId = appDataId;
  global.isCloneApp = 1;
  const userDataPath = path.join(app.getPath("appData"), `ZaloData_${appDataId}`);
  profileDebugPath = path.join(userDataPath, "zbox-debug.log");
  app.setPath("userData", userDataPath);
  writeZBoxDebug("profile user data configured", { appDataId, userDataPath, executable: app.getPath("exe") });
  return appDataId;
}

net.createServer = function createIsolatedServer(...createArgs) {
  const server = originalCreateServer.apply(net, createArgs);
  const originalListen = server.listen;
  server.listen = function listenWithIsolatedPipe(...listenArgs) {
    return originalListen.apply(server, listenArgs.map((value) => isolatePipe(value, instanceSuffix)));
  };
  return server;
};

const argument = process.argv.find((value) => /^--appdata-id=[1-9]\d{0,8}$/.test(value));
configureProfileUserData(argument);

patchZaloInAppBrowserSession();

const pcNameArgument = process.argv.find((value) => value.startsWith("--pc-name="));
if (pcNameArgument) {
  const pcName = Buffer.from(pcNameArgument.slice("--pc-name=".length), "base64").toString("utf8");
  if (pcName) {
    global.pcName = pcName;
    process.env.ZPOOL_PC_NAME = pcName;
    os.hostname = () => pcName;
  }
}

if (!process.argv.includes("--restore-session")) {
  const originalSpawn = childProcess.spawn;
  const captureLock = process.platform === "win32"
    ? path.join(path.dirname(app.getPath("exe")), "plugins", "capture", "capture.lock")
    : path.join(path.dirname(app.getPath("exe")), "..", "ZaloCapture.app", "Contents", "MacOS", "capture.lock");
  let captureHeartbeat = null;
  let ownedCapturePid = null;

  function readCurrentCaptureLock() {
    try {
      const lock = JSON.parse(fs.readFileSync(captureLock, "utf8"));
      if (lock?.id && lock?.time && Date.now() - Number(lock.time) <= 10000) return lock;
    } catch {}
    try { fs.unlinkSync(captureLock); } catch {}
    return null;
  }

  function stopCaptureHeartbeat(pid) {
    if (Number(pid) !== ownedCapturePid) return;
    if (captureHeartbeat) clearInterval(captureHeartbeat);
    captureHeartbeat = null;
    try {
      const lock = JSON.parse(fs.readFileSync(captureLock, "utf8"));
      if (Number(lock?.id) === ownedCapturePid) fs.unlinkSync(captureLock);
    } catch {}
    ownedCapturePid = null;
  }

  childProcess.spawn = function spawnWithProfileHelpers(command, args, options) {
    let executable = command;
    const isolatedArgs = isolateCallArguments(command, args, instanceSuffix);
    const capture = isCaptureHelper(command);
    const currentLock = capture ? readCurrentCaptureLock() : null;
    if (capture && currentLock) executable = "./zalocap";

    const child = originalSpawn(executable, isolatedArgs, options);
    if (capture && !currentLock && child?.pid) {
      ownedCapturePid = child.pid;
      const writeLock = () => {
        try {
          fs.mkdirSync(path.dirname(captureLock), { recursive: true });
          fs.writeFileSync(captureLock, JSON.stringify({ id: child.pid, time: Date.now() }), "utf8");
        } catch {}
      };
      writeLock();
      captureHeartbeat = setInterval(writeLock, 5000);
    }
    if (capture && child?.once) child.once("exit", () => stopCaptureHeartbeat(child.pid));
    return child;
  };

  app.on("before-quit", () => stopCaptureHeartbeat(ownedCapturePid));
}
