"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow, session, webContents } = require("electron");

// Persisted codec key. Its legacy value must remain unchanged for existing meta.bin files.
const LEGACY_META_KEY = Buffer.from("ZaX_Meta_2025_16", "utf8");
const IV = Buffer.alloc(16);
const IDENTITY_RADIUS_METERS = 500;
const IDENTITY_ACCURACY_METERS = 100;
const AUTOMATIC_USER_AGENTS = new Set([
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
]);
const profileDataPath = app.getPath("userData");

// --- External web User-Agent normalization ---
//
// ZaloPC ships an old Chromium and its default UA carries `Electron/<x>` and the
// ZaloPC token. Any web page opened in an in-app web view therefore sees a UA no
// real browser emits, which is what gets the client flagged as a fake device and
// breaks pages such as the Zalo Business upgrade flow.
//
// The UA advertised here is derived from the Chromium actually running, never a
// newer invented version: a UA claiming a version the engine does not implement
// disagrees with the JS feature set and TLS fingerprint, which is a stronger
// fake-device signal than the stale UA it replaces. Client hints are emitted from
// the same version so the two can never disagree.
//
// Scope is limited to non-Zalo http(s) web contents. Zalo-owned pages need the
// native ZaloPC UA to preserve their first-party login/session behaviour, while
// the earlier Business rendering regression was fixed by permission handling.
// Zalo's own renderer is file:// and also keeps its native UA.

const CHROME_VERSION = String(process.versions?.chrome || "");
const CHROME_MAJOR = CHROME_VERSION.split(".")[0] || "";

function externalUserAgent() {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(CHROME_VERSION)) return "";
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + `(KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`;
}

// Chromium's GREASE brand list format. The greased entry is fixed rather than
// randomized so the value stays stable for the lifetime of a profile.
function externalBrands() {
  if (!CHROME_MAJOR) return "";
  return `"Not?A_Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;
}

const EXTERNAL_USER_AGENT = externalUserAgent();
const EXTERNAL_BRANDS = externalBrands();
const externalContentsIds = new Set();

function isWebUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function isZaloOwnedUrl(value) {
  if (!isWebUrl(value)) return false;
  try {
    const { hostname } = new URL(value);
    return /(^|\.)(?:zalo\.me|zaloapp\.com|zalo\.cloud|zalo\.ai|zalo\.vn)$/i.test(hostname);
  } catch {
    return false;
  }
}

function shouldUseExternalUserAgent(url) {
  return isWebUrl(url) && !isZaloOwnedUrl(url);
}

// The header rewrite alone leaves `navigator.userAgent` reporting the Electron
// token, and pages routinely compare the two. Setting it on the web contents
// keeps the JS-visible value and the request headers in agreement without
// patching `navigator` from injected JavaScript.
function applyExternalUserAgent(contents) {
  if (!contents || contents.isDestroyed() || !EXTERNAL_USER_AGENT) return;
  try {
    if (contents.getUserAgent() !== EXTERNAL_USER_AGENT) contents.setUserAgent(EXTERNAL_USER_AGENT);
  } catch {}
}

function restoreNativeUserAgent(contents) {
  if (!contents || contents.isDestroyed()) return;
  try {
    const native = app.userAgentFallback;
    if (native && contents.getUserAgent() !== native) contents.setUserAgent(native);
  } catch {}
}

function syncExternalUserAgent(contents, url) {
  if (!contents || contents.isDestroyed() || !EXTERNAL_USER_AGENT) return;
  // ZBox is a Zalo surface whose UA is set by ZaloPC itself; overwriting it
  // breaks the account SSO handoff and drops the in-app browser at the login page.
  if (contents.__zpmZBox) return;
  if (shouldUseExternalUserAgent(url)) applyExternalUserAgent(contents);
  else restoreNativeUserAgent(contents);
}

function applyExternalHeaders(headers) {
  for (const key of Object.keys(headers)) {
    const name = key.toLowerCase();
    if (name === "user-agent" || name === "sec-ch-ua" || name === "sec-ch-ua-mobile"
      || name === "sec-ch-ua-platform" || name === "sec-ch-ua-full-version"
      || name === "sec-ch-ua-full-version-list" || name === "sec-ch-ua-platform-version") {
      delete headers[key];
    }
  }
  headers["User-Agent"] = EXTERNAL_USER_AGENT;
  headers["sec-ch-ua"] = EXTERNAL_BRANDS;
  headers["sec-ch-ua-mobile"] = "?0";
  headers["sec-ch-ua-platform"] = "\"Windows\"";
  return headers;
}

function isZBoxContentsId(id) {
  if (id === undefined) return false;
  try {
    return webContents.fromId(id)?.__zpmZBox === true;
  } catch {
    return false;
  }
}

function configureExternalUserAgent(ses) {
  if (!ses || !EXTERNAL_USER_AGENT || !EXTERNAL_BRANDS) return;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    const id = details.webContentsId;
    // ZBox shares the profile session, so the header rewrite has to skip it too:
    // its requests must keep the ZaloPC UA that the account SSO expects.
    if (isZBoxContentsId(id)) {
      callback({ requestHeaders: headers });
      return;
    }
    // A non-Zalo http(s) main-frame navigation is treated as external; remember
    // web contents so its subframes and subresources stay consistent with it.
    if (details.resourceType === "mainFrame") {
      if (!shouldUseExternalUserAgent(details.url)) {
        if (id !== undefined) externalContentsIds.delete(id);
        callback({ requestHeaders: headers });
        return;
      }
      if (id !== undefined) externalContentsIds.add(id);
      callback({ requestHeaders: applyExternalHeaders(headers) });
      return;
    }
    if (id !== undefined && externalContentsIds.has(id)) {
      callback({ requestHeaders: applyExternalHeaders(headers) });
      return;
    }
    callback({ requestHeaders: headers });
  });
}

function readMeta() {
  if (!global.appDataId || global.appDataId === "default") return null;
  try {
    const value = fs.readFileSync(path.join(profileDataPath, "meta.bin"), "utf8");
    if (!value.startsWith("v2:")) {
      return JSON.parse(decodeURIComponent(Buffer.from(value, "base64").toString("utf8")));
    }
    const decipher = crypto.createDecipheriv("aes-128-cbc", LEGACY_META_KEY, IV);
    const plain = Buffer.concat([decipher.update(Buffer.from(value.slice(3), "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return null;
  }
}

const meta = readMeta();

function parseIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const bytes = value.split(".").map(Number);
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function parseIpv6(value) {
  if (typeof value !== "string" || value.includes("%") || (value.match(/::/g) || []).length > 1) return null;
  let [left = "", right = ""] = value.toLowerCase().split("::");
  const expandIpv4 = (part) => {
    if (!part.includes(".")) return part;
    const separator = part.lastIndexOf(":");
    const ipv4 = parseIpv4(part.slice(separator + 1));
    if (!ipv4) return null;
    const groups = [(ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]].map((group) => group.toString(16));
    return `${separator >= 0 ? `${part.slice(0, separator)}:` : ""}${groups.join(":")}`;
  };
  left = expandIpv4(left);
  right = expandIpv4(right);
  if (left === null || right === null) return null;
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  if (![...leftGroups, ...rightGroups].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if ((value.includes("::") && missing < 1) || (!value.includes("::") && missing !== 0)) return null;
  const groups = [...leftGroups, ...Array(Math.max(0, missing)).fill("0"), ...rightGroups].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 ? groups.flatMap((group) => [group >> 8, group & 0xff]) : null;
}

function isGlobalIp(value) {
  const ipv4 = parseIpv4(value);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  const ipv6 = parseIpv6(value);
  if (!ipv6) return false;
  const ipv4Mapped = ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
  if (ipv4Mapped) return isGlobalIp(ipv6.slice(12).join("."));
  return !(ipv6.slice(0, 12).every((byte) => byte === 0)
    || ipv6.slice(0, 8).every((byte, index) => byte === (index === 0 ? 1 : 0))
    || (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0 && ipv6[3] === 0x02 && ipv6[4] === 0 && ipv6[5] === 0)
    || (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0 && ((ipv6[3] & 0xf0) === 0x10 || (ipv6[3] & 0xf0) === 0x20))
    || ipv6[0] === 0xff || (ipv6[0] & 0xfe) === 0xfc || (ipv6[0] === 0xfe && (ipv6[1] & 0xc0) === 0x80)
    || (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8));
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function validateAutomaticIdentity(input) {
  if (!input || typeof input !== "object" || !isGlobalIp(input.sourceIp)) return null;
  const version = parseIpv4(input.sourceIp) ? 4 : parseIpv6(input.sourceIp) ? 6 : 0;
  const coordinateKeys = ["providerLatitude", "providerLongitude", "latitude", "longitude"];
  if (input.ipVersion !== version || !coordinateKeys.every((key) => typeof input[key] === "number" && Number.isFinite(input[key]))) return null;
  if (input.providerLatitude < -90 || input.providerLatitude > 90 || input.latitude < -90 || input.latitude > 90
    || input.providerLongitude < -180 || input.providerLongitude > 180 || input.longitude < -180 || input.longitude > 180) return null;
  if (input.radiusMeters !== IDENTITY_RADIUS_METERS || input.accuracyMeters !== IDENTITY_ACCURACY_METERS
    || !AUTOMATIC_USER_AGENTS.has(input.userAgent) || typeof input.generatedAt !== "string"
    || Number.isNaN(new Date(input.generatedAt).getTime())) return null;
  if (distanceMeters(input.providerLatitude, input.providerLongitude, input.latitude, input.longitude) > IDENTITY_RADIUS_METERS + 0.01) return null;
  for (const key of ["country", "countryCode", "region", "city"]) if (typeof input[key] !== "string") return null;
  return { ...input };
}

global.__zpmValidateAutomaticIdentity = validateAutomaticIdentity;

const hasAutomaticIdentityMetadata = meta?.automaticIdentity !== undefined && meta?.automaticIdentity !== null;
const automaticIdentity = validateAutomaticIdentity(meta?.automaticIdentity);

function currentTitle() {
  const proxy = meta?.proxyConfig;
  const route = proxy?.enabled && proxy.host && proxy.port
    ? meta?.proxyPublicIp || proxy.host
    : "DIRECT";
  return meta?.name ? `${meta.name} | ${route}` : "Zalo";
}

// --- Browser policy (snapshot once at startup) ---

const DEFAULT_PERMISSIONS = { geolocation: false, camera: false, microphone: false, notifications: false };

function resolvePolicy() {
  const bp = meta?.browserPolicy;
  if (!bp) return { permissions: { ...DEFAULT_PERMISSIONS }, userAgent: "" };
  const perm = bp.permissions || {};
  return {
    permissions: {
      geolocation: Boolean(perm.geolocation),
      camera: Boolean(perm.camera),
      microphone: Boolean(perm.microphone),
      notifications: Boolean(perm.notifications),
    },
    userAgent: automaticIdentity?.userAgent || (!hasAutomaticIdentityMetadata && typeof bp.userAgent === "string" ? bp.userAgent.trim() : ""),
  };
}

const policy = resolvePolicy();
const configuredSessions = new WeakSet();
const proxiedSessions = new WeakSet();
const geolocationReady = new WeakSet();
const geolocationPending = new WeakSet();
const geolocationRetryTimers = new WeakMap();

// Permissions ZPool actually has a per-profile policy for. Anything outside this
// set is not ours to decide: denying it silently strips capabilities ZaloPC
// normally has (clipboard, openExternal, fullscreen, pointerLock, ...), which is
// what stops external web views such as the Zalo Business upgrade flow from
// rendering. Stock ZaloPC and ZaX install no permission handler at all and those
// pages load fine on the very same Chromium, so the handler — not the engine
// version — was the regression. Unmanaged permissions therefore fall through to
// Chromium's own default rather than being refused.
//
// Fail-closed still applies in full to the three managed permissions, including
// unknown or malformed media types and stale metadata.
const MANAGED_PERMISSIONS = new Set(["geolocation", "notifications", "media"]);

function isPermissionManaged(permission) {
  return MANAGED_PERMISSIONS.has(permission);
}

function isPermissionAllowed(policyArg, permission, details, webContents) {
  const perm = policyArg.permissions;
  if (permission === "geolocation") return perm.geolocation && geolocationReady.has(webContents);
  if (permission === "notifications") return perm.notifications;
  if (permission === "media") {
    const types = details?.mediaTypes;
    if (!Array.isArray(types) || types.length === 0) return false;
    const mediaMap = { audio: "microphone", video: "camera" };
    for (const type of types) {
      const key = mediaMap[type];
      if (!key) return false;
      if (!perm[key]) return false;
    }
    return true;
  }
  return undefined;
}

function isPermissionCheckAllowed(policyArg, permission, details, webContents) {
  const perm = policyArg.permissions;
  if (permission === "geolocation") return perm.geolocation && geolocationReady.has(webContents);
  if (permission === "notifications") return perm.notifications;
  if (permission === "media") {
    const mediaMap = { audio: "microphone", video: "camera" };
    const key = mediaMap[details?.mediaType];
    return key ? Boolean(perm[key]) : false;
  }
  return undefined;
}

function configureSession(ses) {
  if (!ses || configuredSessions.has(ses)) return;
  // Electron has no "defer to Chromium" return value: once a handler is installed
  // it decides every permission. `undefined` from the decision functions means the
  // permission is outside ZPool's policy, so it is granted here to preserve the
  // behaviour ZaloPC has with no handler installed at all.
  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const decision = isPermissionAllowed(policy, permission, details, webContents);
    callback(isPermissionManaged(permission) ? Boolean(decision) : true);
  });
  ses.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const decision = isPermissionCheckAllowed(policy, permission, details, webContents);
    return isPermissionManaged(permission) ? Boolean(decision) : true;
  });
  try { configureExternalUserAgent(ses); } catch {}
  configuredSessions.add(ses);
}

function configureProxy(ses) {
  if (!ses || proxiedSessions.has(ses) || ses === session.defaultSession) return;
  const proxy = meta?.proxyConfig;
  if (!proxy?.enabled || !proxy.host || !proxy.port) return;
  const protocol = proxy.protocol === "socks" ? "socks4" : proxy.protocol;
  proxiedSessions.add(ses);
  ses.setProxy({ proxyRules: `${protocol}://${proxy.host}:${proxy.port}` })
    .catch(() => proxiedSessions.delete(ses));
}

app.on("session-created", (ses) => {
  try { configureSession(ses); } catch {}
  try { configureProxy(ses); } catch {}
});

function scheduleGeolocationOverride(contents, delayMs = 250) {
  if (!contents || contents.isDestroyed() || geolocationRetryTimers.has(contents)) return;
  const timer = setTimeout(() => {
    geolocationRetryTimers.delete(contents);
    applyGeolocationOverride(contents);
  }, delayMs);
  timer.unref?.();
  geolocationRetryTimers.set(contents, timer);
}

function applyGeolocationOverride(contents) {
  if (!contents || contents.isDestroyed() || geolocationReady.has(contents) || geolocationPending.has(contents)) return;
  if (!policy.permissions.geolocation || !automaticIdentity) return;
  const { latitude, longitude, accuracyMeters: accuracy } = automaticIdentity;
  if (![latitude, longitude, accuracy].every(Number.isFinite)) return;
  geolocationPending.add(contents);
  try {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    contents.debugger.once("detach", () => {
      geolocationReady.delete(contents);
      scheduleGeolocationOverride(contents);
    });
    contents.debugger.sendCommand("Emulation.setGeolocationOverride", { latitude, longitude, accuracy })
      .then(() => geolocationReady.add(contents))
      .catch(() => {
        geolocationReady.delete(contents);
        scheduleGeolocationOverride(contents, 1000);
      })
      .finally(() => geolocationPending.delete(contents));
  } catch {
    geolocationPending.delete(contents);
    geolocationReady.delete(contents);
    scheduleGeolocationOverride(contents, 1000);
  }
}


function visibleTitleScript(title) {
  const serializedTitle = JSON.stringify(title);
  return `(() => {
    const desiredTitle = ${serializedTitle};
    const stateKey = "__zpmVisibleTitleState";
    let state = window[stateKey];
    const apply = () => {
      const activeTitle = state?.title || desiredTitle;
      if (document.title !== activeTitle) document.title = activeTitle;
      const zaloTitle = document.querySelector("#titleBar .title-name");
      const loginTitle = document.querySelector(".login-title-bar");
      if (zaloTitle || loginTitle) {
        document.querySelector("[data-zpm-title-label]")?.remove();
        const titleHost = zaloTitle || loginTitle;
        titleHost.style.removeProperty("display");
        titleHost.style.setProperty("min-width", "0", "important");
        titleHost.style.setProperty("overflow", "hidden", "important");
        titleHost.style.setProperty("text-overflow", "ellipsis", "important");
        titleHost.style.setProperty("white-space", "nowrap", "important");
        titleHost.style.setProperty("font-size", "125%", "important");
        titleHost.style.setProperty("font-weight", "600", "important");
        let textNode = Array.from(titleHost.childNodes).find((node) => node.nodeType === Node.TEXT_NODE);
        if (!textNode) {
          textNode = document.createTextNode("");
          titleHost.insertBefore(textNode, titleHost.firstChild);
        }
        if (textNode.nodeValue !== activeTitle) textNode.nodeValue = activeTitle;
      }

      document.querySelector("[data-zpm-login-title]")?.remove();
    };

    if (!state) {
      state = { title: desiredTitle, scheduled: false };
      const schedule = () => {
        if (state.scheduled) return;
        state.scheduled = true;
        requestAnimationFrame(() => {
          state.scheduled = false;
          apply();
        });
      };
      state.observer = new MutationObserver(schedule);
      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window[stateKey] = state;
    }
    state.title = desiredTitle;
    apply();
    return Boolean(document.querySelector("#titleBar .title-name") || document.querySelector(".login-title-bar"));
  })()`;
}

function injectVisibleTitle(contents, title = currentTitle()) {
  if (!contents || contents.isDestroyed()) return;
  contents.executeJavaScript(visibleTitleScript(title), true)
    .catch(() => {});
}

function attachWebContents(contents) {
  if (!contents || contents.isDestroyed() || contents.__zpmTitleAttached) return;
  contents.__zpmTitleAttached = true;
  applyGeolocationOverride(contents);
  const reapplyIdentity = () => {
    geolocationReady.delete(contents);
    scheduleGeolocationOverride(contents);
  };
  const inject = () => injectVisibleTitle(contents);
  // `will-navigate` fires before the request leaves, so the UA is already correct
  // for the very first external navigation rather than only after a redirect.
  contents.on("will-navigate", (_event, url) => syncExternalUserAgent(contents, url));
  contents.on("did-start-navigation", (_event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame) return;
    syncExternalUserAgent(contents, url);
    reapplyIdentity();
  });
  // Zalo installs its own window-open handler to control how popups (payment and
  // upgrade flows among them) are created. Overwriting it with a blanket allow
  // discards that configuration, so the UA is set without replacing the handler.
  contents.on("did-create-window", (window, details) => {
    try {
      if (window && !window.isDestroyed()) syncExternalUserAgent(window.webContents, details?.url);
    } catch {}
  });
  contents.on("dom-ready", () => { applyGeolocationOverride(contents); inject(); });
  contents.on("did-finish-load", () => { applyGeolocationOverride(contents); inject(); });
  contents.on("did-navigate", inject);
  contents.on("did-navigate-in-page", inject);
  contents.once("destroyed", () => {
    try { externalContentsIds.delete(contents.id); } catch {}
  });
  contents.on("render-process-gone", () => {
    geolocationReady.delete(contents);
    geolocationPending.delete(contents);
    const timer = geolocationRetryTimers.get(contents);
    if (timer) clearTimeout(timer);
    geolocationRetryTimers.delete(contents);
  });
  inject();
}

function attachTitle(window) {
  if (!window || window.isDestroyed() || window.__zpmTitleAttached) return;
  window.__zpmTitleAttached = true;
  const nativeSetTitle = window.setTitle.bind(window);
  const setManagedTitle = () => {
    if (!window.isDestroyed()) nativeSetTitle(currentTitle());
  };
  window.setTitle = setManagedTitle;
  const applyTitle = (event) => {
    event?.preventDefault?.();
    setManagedTitle();
  };
  window.on("page-title-updated", applyTitle);
  window.on("ready-to-show", applyTitle);
  window.webContents.on("page-title-updated", applyTitle);
  attachWebContents(window.webContents);
  applyTitle();
}

function refreshTitles() {
  const title = currentTitle();
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      attachTitle(window);
      if (!window.isDestroyed()) {
        window.setTitle();
        injectVisibleTitle(window.webContents, title);
      }
    } catch {}
  }
}

app.on("browser-window-created", (_event, window) => {
  attachTitle(window);
});
app.on("web-contents-created", (_event, contents) => {
  applyGeolocationOverride(contents);
  attachWebContents(contents);
  try { configureSession(contents.session); } catch {}
  try { configureProxy(contents.session); } catch {}
});
app.whenReady().then(() => {
  try { refreshTitles(); } catch {}
  try { configureSession(session.defaultSession); } catch {}
});
const titleTimer = setInterval(() => {
  try { refreshTitles(); } catch {}
}, 1000);
titleTimer.unref?.();

const proxy = meta?.proxyConfig;

if (proxy?.enabled && proxy.host && proxy.port) {
  app.on("login", (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    event.preventDefault();
    if (proxy.useAuthentication && proxy.username && proxy.password) {
      callback(proxy.username, proxy.password);
    } else {
      callback();
    }
  });
}
