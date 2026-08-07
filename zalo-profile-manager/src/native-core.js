"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const asar = require("@electron/asar");

// Persisted codec key. Its legacy value must remain unchanged for existing meta.bin files.
const META_KEY = Buffer.from("ZaX_Meta_2025_16", "utf8");
const META_IV = Buffer.alloc(16);
const PROFILE_DIR_PATTERN = /^ZaloData_([1-9]\d{0,8})$/;
const APPDATA_ARG_PATTERN = /(?:^|\s)--appdata-id(?:=|\s+)([1-9]\d{0,8})(?=\s|$)/i;
const PATCH_MARKER = "ZALO_PROFILE_MANAGER_BOOTSTRAP_V2";
const LEGACY_PATCH_MARKER = "ZALO_PROFILE_MANAGER_BOOTSTRAP_V1";
const HOOK_FILES = ["zpool-app-init.js", "zpool-helper.js", "zpool.js"];
const LEGACY_HOOK_FILES = ["zax-app-init.js", "zax-helper.js", "zax.js"];
const RUNTIME_MANIFEST = "manifest.json";
const IDENTITY_RADIUS_METERS = 500;
const IDENTITY_ACCURACY_METERS = 100;
const AUTOMATIC_USER_AGENTS = Object.freeze([
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
]);
let patchOperation = Promise.resolve();

function cleanText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeAppDataId(value) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d{0,8}$/.test(text)) throw new Error("Appdata ID phải là số nguyên dương tối đa 9 chữ số.");
  return Number(text);
}

function defaultBrowserPolicy() {
  return {
    permissions: { geolocation: false, camera: false, microphone: false, notifications: false },
    userAgent: "",
  };
}

function sanitizeUserAgent(value) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length > 512) throw new Error("User agent không được dài hơn 512 ký tự.");
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error("User agent chứa ký tự điều khiển không hợp lệ.");
  return trimmed;
}

function sanitizeBrowserPolicy(input = {}) {
  const permissions = input.permissions || {};
  return {
    permissions: {
      geolocation: Boolean(permissions.geolocation),
      camera: Boolean(permissions.camera),
      microphone: Boolean(permissions.microphone),
      notifications: Boolean(permissions.notifications),
    },
    userAgent: sanitizeUserAgent(input.userAgent),
  };
}

function sameBrowserPolicy(left, right) {
  const l = left?.permissions || {};
  const r = right?.permissions || {};
  return Boolean(l.geolocation) === Boolean(r.geolocation)
    && Boolean(l.camera) === Boolean(r.camera)
    && Boolean(l.microphone) === Boolean(r.microphone)
    && Boolean(l.notifications) === Boolean(r.notifications)
    && (left?.userAgent || "") === (right?.userAgent || "");
}

function sameLaunchConfig(left, right) {
  return sameProxyConfig(left?.proxy, right?.proxy)
    && sameBrowserPolicy(left?.browserPolicy, right?.browserPolicy)
    && sameAutomaticIdentity(left?.automaticIdentity, right?.automaticIdentity);
}

function parseIpv4(value) {
  if (typeof value !== "string" || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return null;
  const bytes = value.split(".").map(Number);
  return bytes.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255) ? bytes : null;
}

function parseIpv6(value) {
  if (typeof value !== "string" || value.includes("%")) return null;
  const text = value.toLowerCase();
  if ((text.match(/::/g) || []).length > 1) return null;
  let [left = "", right = ""] = text.split("::");
  const expandIpv4 = (part) => {
    if (!part.includes(".")) return part;
    const separator = part.lastIndexOf(":");
    const ipv4 = parseIpv4(part.slice(separator + 1));
    if (!ipv4) return null;
    const groups = [`${ipv4[0].toString(16).padStart(2, "0")}${ipv4[1].toString(16).padStart(2, "0")}`, `${ipv4[2].toString(16).padStart(2, "0")}${ipv4[3].toString(16).padStart(2, "0")}`];
    return `${separator >= 0 ? `${part.slice(0, separator)}:` : ""}${groups.join(":")}`;
  };
  left = expandIpv4(left);
  right = expandIpv4(right);
  if (left === null || right === null) return null;
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  if (![...leftGroups, ...rightGroups].every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  const missing = 8 - leftGroups.length - rightGroups.length;
  if ((text.includes("::") && missing < 1) || (!text.includes("::") && missing !== 0)) return null;
  const groups = [...leftGroups, ...Array(Math.max(0, missing)).fill("0"), ...rightGroups].map((group) => Number.parseInt(group, 16));
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function isGlobalIp(value) {
  const ipv4 = parseIpv4(value);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113));
  }
  const ipv6 = parseIpv6(value);
  if (!ipv6) return false;
  const allZero = ipv6.every((byte) => byte === 0);
  const loopback = ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1;
  const ipv4Mapped = ipv6.slice(0, 10).every((byte) => byte === 0) && ipv6[10] === 0xff && ipv6[11] === 0xff;
  if (ipv4Mapped) return isGlobalIp(ipv6.slice(12).join("."));
  const ipv4Compatible = ipv6.slice(0, 12).every((byte) => byte === 0);
  const discardOnly = ipv6.slice(0, 8).every((byte, index) => byte === (index === 0 ? 1 : 0));
  const benchmarking = ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x00 && ipv6[3] === 0x02 && ipv6[4] === 0 && ipv6[5] === 0;
  const orchid = ipv6[0] === 0x20 && ipv6[1] === 0x01 && (ipv6[2] === 0x00 && ((ipv6[3] & 0xf0) === 0x10 || (ipv6[3] & 0xf0) === 0x20));
  return !(allZero || loopback || ipv6[0] === 0xff || (ipv6[0] & 0xfe) === 0xfc
    || ipv4Compatible || discardOnly || benchmarking || orchid
    || (ipv6[0] === 0xfe && (ipv6[1] & 0xc0) === 0x80)
    || (ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8));
}

function assertResolvedProxyRoute(route, proxy) {
  const tokens = String(route || "").trim().split(/\s*;\s*/).filter(Boolean);
  if (!proxy?.enabled) {
    if (tokens.length !== 1 || tokens[0].toUpperCase() !== "DIRECT") throw new Error("Route DIRECT bị thay đổi ngoài dự kiến.");
    return "DIRECT";
  }
  if (!tokens.length || tokens.some((token) => token.toUpperCase() === "DIRECT")) throw new Error("Electron trả về route có DIRECT fallback.");
  const expectedTypes = {
    http: new Set(["PROXY", "HTTP"]),
    https: new Set(["HTTPS"]),
    socks4: new Set(["SOCKS4"]),
    socks5: new Set(["SOCKS", "SOCKS5"]),
  }[proxy.protocol] || new Set();
  for (const token of tokens) {
    const match = token.match(/^([A-Z0-9]+)\s+(.+)$/i);
    if (!match || !expectedTypes.has(match[1].toUpperCase())) throw new Error("Electron trả về loại proxy không khớp cấu hình.");
    const endpoint = match[2];
    const endpointMatch = endpoint.match(/^\[([^\]]+)\]:(\d+)$|^([^:]+):(\d+)$/);
    const host = (endpointMatch?.[1] || endpointMatch?.[3] || "").toLowerCase();
    const port = endpointMatch?.[2] || endpointMatch?.[4] || "";
    if (host !== String(proxy.host).toLowerCase() || port !== String(proxy.port)) throw new Error("Electron trả về endpoint proxy không khớp cấu hình.");
  }
  return tokens.join("; ");
}

function ipVersion(value) {
  if (parseIpv4(value)) return 4;
  if (parseIpv6(value)) return 6;
  return 0;
}

function sameIpAddress(left, right) {
  const version = ipVersion(left);
  if (!version || version !== ipVersion(right)) return false;
  if (version === 4) return parseIpv4(left).every((byte, index) => byte === parseIpv4(right)[index]);
  const leftBytes = parseIpv6(left);
  const rightBytes = parseIpv6(right);
  return leftBytes.every((byte, index) => byte === rightBytes[index]);
}

function finiteCoordinate(value, minimum, maximum, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${label} không hợp lệ.`);
  return value;
}

function randomUnit(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(6);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 6) throw new Error("CSPRNG không trả về đủ entropy.");
  return bytes.readUIntBE(0, 6) / 0x1000000000000;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function randomCoordinate(latitude, longitude, radiusMeters = IDENTITY_RADIUS_METERS, randomBytes = crypto.randomBytes) {
  const lat = finiteCoordinate(latitude, -90, 90, "Latitude provider");
  const lon = finiteCoordinate(longitude, -180, 180, "Longitude provider");
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 5000) throw new Error("Bán kính identity không hợp lệ.");
  const bearing = randomUnit(randomBytes) * Math.PI * 2;
  const angularDistance = Math.max(0, radiusMeters - 0.01) * Math.sqrt(randomUnit(randomBytes)) / 6371008.8;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing));
  const lon2 = lon1 + Math.atan2(Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1), Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2));
  return {
    latitude: lat2 * 180 / Math.PI,
    longitude: ((lon2 * 180 / Math.PI + 540) % 360) - 180,
  };
}

function validateGeoIpResponse(sourceIp, response) {
  if (!isGlobalIp(sourceIp)) throw new Error("IP public không hợp lệ hoặc không global.");
  if (!response || typeof response !== "object" || response.success !== true) throw new Error("GeoIP provider từ chối lookup.");
  if (!sameIpAddress(response.ip, sourceIp) || response.type !== `IPv${ipVersion(sourceIp)}`) throw new Error("GeoIP response không khớp IP hoặc version yêu cầu.");
  return {
    country: cleanText(response.country, 100),
    countryCode: cleanText(response.country_code, 8),
    region: cleanText(response.region, 100),
    city: cleanText(response.city, 100),
    latitude: finiteCoordinate(response.latitude, -90, 90, "Latitude GeoIP"),
    longitude: finiteCoordinate(response.longitude, -180, 180, "Longitude GeoIP"),
  };
}

function sanitizeAutomaticIdentity(input) {
  if (!input || typeof input !== "object") return null;
  const sourceIp = cleanText(input.sourceIp, 64);
  if (!isGlobalIp(sourceIp) || Number(input.ipVersion) !== ipVersion(sourceIp)) throw new Error("Automatic identity chứa IP không hợp lệ.");
  const providerLatitude = finiteCoordinate(input.providerLatitude, -90, 90, "Latitude provider");
  const providerLongitude = finiteCoordinate(input.providerLongitude, -180, 180, "Longitude provider");
  const latitude = finiteCoordinate(input.latitude, -90, 90, "Latitude identity");
  const longitude = finiteCoordinate(input.longitude, -180, 180, "Longitude identity");
  const radiusMeters = Number(input.radiusMeters);
  const accuracyMeters = Number(input.accuracyMeters);
  const userAgent = sanitizeUserAgent(input.userAgent);
  const generatedAt = new Date(input.generatedAt);
  if (radiusMeters !== IDENTITY_RADIUS_METERS || accuracyMeters !== IDENTITY_ACCURACY_METERS) throw new Error("Automatic identity dùng radius hoặc accuracy không hợp lệ.");
  if (distanceMeters(providerLatitude, providerLongitude, latitude, longitude) > radiusMeters + 0.01) throw new Error("Tọa độ identity nằm ngoài bán kính cho phép.");
  if (!AUTOMATIC_USER_AGENTS.includes(userAgent)) throw new Error("Automatic identity chứa user agent ngoài allowlist.");
  if (Number.isNaN(generatedAt.getTime())) throw new Error("Thời điểm tạo automatic identity không hợp lệ.");
  return {
    sourceIp,
    ipVersion: Number(input.ipVersion),
    country: cleanText(input.country, 100),
    countryCode: cleanText(input.countryCode, 8),
    region: cleanText(input.region, 100),
    city: cleanText(input.city, 100),
    providerLatitude,
    providerLongitude,
    radiusMeters,
    latitude,
    longitude,
    accuracyMeters,
    userAgent,
    generatedAt: generatedAt.toISOString(),
  };
}

function generateAutomaticIdentity(sourceIp, response, options = {}) {
  const geo = validateGeoIpResponse(sourceIp, response);
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const coordinate = randomCoordinate(geo.latitude, geo.longitude, IDENTITY_RADIUS_METERS, randomBytes);
  const userAgent = AUTOMATIC_USER_AGENTS[Math.floor(randomUnit(randomBytes) * AUTOMATIC_USER_AGENTS.length)];
  return sanitizeAutomaticIdentity({
    sourceIp,
    ipVersion: ipVersion(sourceIp),
    country: geo.country,
    countryCode: geo.countryCode,
    region: geo.region,
    city: geo.city,
    providerLatitude: geo.latitude,
    providerLongitude: geo.longitude,
    radiusMeters: IDENTITY_RADIUS_METERS,
    ...coordinate,
    accuracyMeters: IDENTITY_ACCURACY_METERS,
    userAgent,
    generatedAt: (options.now ? options.now() : new Date()).toISOString(),
  });
}

function sameAutomaticIdentity(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  try { return JSON.stringify(sanitizeAutomaticIdentity(left)) === JSON.stringify(sanitizeAutomaticIdentity(right)); } catch { return false; }
}

function sanitizeProxy(input = {}, existing = {}) {
  const protocols = new Set(["http", "https", "socks4", "socks5"]);
  const protocol = protocols.has(input.protocol) ? input.protocol : "http";
  const port = Number.parseInt(input.port, 10);
  const enabled = Boolean(input.enabled);
  const useAuthentication = Boolean(input.useAuthentication);
  const host = cleanText(input.host, 255);
  const username = cleanText(input.username, 255);
  const suppliedPassword = cleanText(input.password, 1024);
  const password = suppliedPassword || cleanText(existing.password, 1024);

  if (enabled && (!host || !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error("Proxy host hoặc port không hợp lệ.");
  }
  if (enabled && useAuthentication && (!username || !password)) {
    throw new Error("Proxy username và password là bắt buộc.");
  }

  return {
    enabled,
    protocol,
    host,
    port: Number.isInteger(port) ? port : "",
    useAuthentication,
    username,
    password,
  };
}

function sameProxyConfig(left, right) {
  const leftProxy = left || {};
  const rightProxy = right || {};
  const enabled = Boolean(leftProxy.enabled);
  if (enabled !== Boolean(rightProxy.enabled)) return false;
  if (!enabled) return true;
  const useAuthentication = Boolean(leftProxy.useAuthentication);
  return leftProxy.protocol === rightProxy.protocol
    && leftProxy.host === rightProxy.host
    && leftProxy.port === rightProxy.port
    && useAuthentication === Boolean(rightProxy.useAuthentication)
    && (!useAuthentication || (
      leftProxy.username === rightProxy.username
      && leftProxy.password === rightProxy.password
    ));
}

function sanitizeProfile(input, existing = {}, nextAppDataId) {
  const name = cleanText(input?.name, 80);
  if (!name) throw new Error("Tên profile là bắt buộc.");
  const appDataId = existing.appDataId || normalizeAppDataId(nextAppDataId);

  const proxy = sanitizeProxy(input.proxy, existing.proxy);
  const sameProxy = sameProxyConfig(proxy, existing.proxy);
  const browserPolicy = sanitizeBrowserPolicy({
    ...input.browserPolicy,
    userAgent: existing.browserPolicy?.userAgent || "",
  });
  const automaticIdentity = existing.automaticIdentity ? sanitizeAutomaticIdentity(existing.automaticIdentity) : null;
  return {
    id: existing.id || crypto.randomUUID(),
    appDataId,
    name,
    note: cleanText(input.note, 160),
    color: /^#[0-9a-f]{6}$/i.test(input.color) ? input.color : existing.color || "#61d49a",
    proxy,
    proxyPublicIp: sameProxy ? cleanText(existing.proxyPublicIp, 64) : "",
    browserPolicy,
    ...(automaticIdentity ? { automaticIdentity } : {}),
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastOpenedAt: existing.lastOpenedAt || null,
  };
}

function publicProfile(profile, runtime = {}) {
  const proxy = { ...profile.proxy };
  const activeProxy = runtime.activeProxy ? { ...runtime.activeProxy } : null;
  delete proxy.password;
  if (activeProxy) delete activeProxy.password;
  const browserPolicy = sanitizeBrowserPolicy(profile.browserPolicy);
  const activeBrowserPolicy = runtime.activeBrowserPolicy ? sanitizeBrowserPolicy(runtime.activeBrowserPolicy) : null;
  const automaticIdentity = profile.automaticIdentity ? sanitizeAutomaticIdentity(profile.automaticIdentity) : null;
  const activeAutomaticIdentity = runtime.activeAutomaticIdentity ? sanitizeAutomaticIdentity(runtime.activeAutomaticIdentity) : null;
  return {
    ...profile,
    proxy,
    browserPolicy,
    activeProxy,
    activeBrowserPolicy,
    automaticIdentity,
    activeAutomaticIdentity,
    activeProxyPublicIp: runtime.proxyPublicIp || "",
    status: runtime.status || "idle",
    running: runtime.status === "running" || runtime.status === "restart-required",
    restartRequired: runtime.status === "restart-required",
    error: runtime.error || null,
    pid: runtime.pid || null,
  };
}

function nextAvailableAppDataId(profiles, startAt = 1000, reservedIds = []) {
  const used = new Set([
    ...profiles.map((profile) => Number(profile.appDataId)),
    ...reservedIds.map(Number),
  ].filter(Number.isSafeInteger));
  let candidate = startAt;
  while (used.has(candidate)) candidate += 1;
  return normalizeAppDataId(candidate);
}

function profileDataPath(appDataRoot, appDataId) {
  return path.join(path.resolve(appDataRoot), `ZaloData_${normalizeAppDataId(appDataId)}`);
}

function assertOwnedProfilePath(appDataRoot, candidate, appDataId, registeredIds) {
  const id = normalizeAppDataId(appDataId);
  if (!new Set(registeredIds.map(Number)).has(id)) throw new Error("Profile không thuộc registry của ứng dụng.");
  const root = path.resolve(appDataRoot);
  const resolved = path.resolve(candidate);
  const expected = path.join(root, `ZaloData_${id}`);
  if (path.dirname(resolved) !== root || resolved !== expected || !PROFILE_DIR_PATTERN.test(path.basename(resolved))) {
    throw new Error("Đường dẫn dữ liệu profile không an toàn.");
  }
  return resolved;
}

function metaPayload(profile) {
  const bp = profile.browserPolicy || defaultBrowserPolicy();
  const perm = bp.permissions || {};
  return {
    id: String(profile.appDataId),
    name: profile.name,
    note: profile.note || "",
    proxyConfig: {
      enabled: Boolean(profile.proxy.enabled),
      protocol: profile.proxy.protocol,
      host: profile.proxy.host,
      port: profile.proxy.port,
      username: profile.proxy.useAuthentication ? profile.proxy.username : "",
      password: profile.proxy.useAuthentication ? profile.proxy.password : "",
      useAuthentication: Boolean(profile.proxy.useAuthentication),
    },
    cookies: "",
    proxyPublicIp: cleanText(profile.proxyPublicIp, 64),
    browserPolicy: {
      permissions: {
        geolocation: Boolean(perm.geolocation),
        camera: Boolean(perm.camera),
        microphone: Boolean(perm.microphone),
        notifications: Boolean(perm.notifications),
      },
      userAgent: bp.userAgent || "",
    },
    automaticIdentity: profile.automaticIdentity ? sanitizeAutomaticIdentity(profile.automaticIdentity) : null,
  };
}

function encodeMetaV2(value) {
  const cipher = crypto.createCipheriv("aes-128-cbc", META_KEY, META_IV);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
  return `v2:${encrypted.toString("base64")}`;
}

function decodeMeta(value) {
  if (typeof value !== "string") throw new Error("meta.bin không hợp lệ.");
  if (!value.startsWith("v2:")) {
    return JSON.parse(decodeURIComponent(Buffer.from(value, "base64").toString("utf8")));
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", META_KEY, META_IV);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(value.slice(3), "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8"));
}

function writeFileAtomic(target, content) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(temporary, content);
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function parsePowerShellProcesses(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((item) => ({
    pid: Number(item.ProcessId),
    parentPid: Number(item.ParentProcessId),
    executablePath: item.ExecutablePath || "",
    commandLine: item.CommandLine || "",
    appDataId: parseAppDataId(item.CommandLine),
  })).filter((item) => Number.isSafeInteger(item.pid) && item.pid > 0);
}

function parseAppDataId(commandLine) {
  const match = String(commandLine || "").match(APPDATA_ARG_PATTERN);
  return match ? Number(match[1]) : null;
}

function normalizedExecutablePath(value) {
  return path.win32.normalize(String(value || "")).toLowerCase();
}

function processesForAppDataId(processes, appDataId, executable = null) {
  const id = normalizeAppDataId(appDataId);
  const expectedExecutable = executable ? normalizedExecutablePath(executable) : "";
  return processes.filter((processInfo) => processInfo.appDataId === id
    && (!expectedExecutable || normalizedExecutablePath(processInfo.executablePath) === expectedExecutable));
}

function rootProcessesForAppDataId(processes, appDataId, executable = null) {
  const matching = processesForAppDataId(processes, appDataId, executable);
  const matchingPids = new Set(matching.map((item) => item.pid));
  return matching.filter((item) => !matchingPids.has(item.parentPid));
}

function reconcileProfileRuntime(runtimeMap, profiles, processes, activeIds = new Set()) {
  let changed = false;
  const registeredIds = new Set(profiles.map((profile) => profile.id));

  for (const id of runtimeMap.keys()) {
    if (!registeredIds.has(id)) {
      runtimeMap.delete(id);
      changed = true;
    }
  }

  for (const profile of profiles) {
    if (activeIds.has(profile.id)) continue;
    const matching = processesForAppDataId(processes, profile.appDataId);
    const current = runtimeMap.get(profile.id);
    if (!matching.length) {
      if (current) {
        runtimeMap.delete(profile.id);
        changed = true;
      }
      continue;
    }
    const roots = rootProcessesForAppDataId(processes, profile.appDataId);
    const pid = roots[0]?.pid || matching[0].pid;
    const sameProcess = current?.pid === pid;
    const activeProxy = (sameProcess ? current?.activeProxy : null) || profile.activeProxy || profile.proxy;
    const proxyPublicIp = (sameProcess ? current?.proxyPublicIp : null) || profile.activeProxyPublicIp || profile.proxyPublicIp;
    const activeBrowserPolicy = (sameProcess ? current?.activeBrowserPolicy : null) || profile.activeBrowserPolicy || profile.browserPolicy || defaultBrowserPolicy();
    const activeAutomaticIdentity = sameProcess && Object.hasOwn(current, "activeAutomaticIdentity")
      ? current.activeAutomaticIdentity
      : Object.hasOwn(profile, "activeAutomaticIdentity") ? profile.activeAutomaticIdentity : profile.automaticIdentity || null;
    const restartRequired = !sameLaunchConfig(
      { proxy: activeProxy, browserPolicy: activeBrowserPolicy, automaticIdentity: activeAutomaticIdentity },
      { proxy: profile.proxy, browserPolicy: profile.browserPolicy || defaultBrowserPolicy(), automaticIdentity: profile.automaticIdentity }
    );
    const next = {
      status: restartRequired ? "restart-required" : "running",
      pid,
      ...(activeProxy ? { activeProxy } : {}),
      ...(proxyPublicIp ? { proxyPublicIp } : {}),
      activeBrowserPolicy,
      activeAutomaticIdentity,
    };
    if (!current || JSON.stringify(current) !== JSON.stringify(next)) {
      runtimeMap.set(profile.id, next);
      changed = true;
    }
  }
  return changed;
}

function bootstrapLayout(source) {
  const match = String(source).match(/require\((['"])(\.\/(main-dist|dist-main)\/main(?:\.js)?)\1\)/);
  if (!match) throw new Error("Không xác định được layout bootstrap của ZaloPC.");
  return match[3];
}

function patchBootstrap(source) {
  let normalized = String(source).replace(/\.\/(?:main-dist|dist-main)\/assets\/js\/main\/((?:zax|zpool)(?:-app-init|-helper)?)/g, "./$1");
  if (normalized.includes(LEGACY_PATCH_MARKER)) {
    normalized = normalized
      .replace(LEGACY_PATCH_MARKER, PATCH_MARKER)
      .replace(
        /require\((['"])\.\/zax\1\)\s*\.then\(\(\) => require\((['"])(\.\/(?:main-dist|dist-main)\/main(?:\.js)?)\2\)\)\s*\.catch\(\(error\) => \{ console\.error\('\[zpm-hook\] Startup blocked:', error\); require\('electron'\)\.app\.exit\(1\); \}\)/,
        (_match, _zaxQuote, mainQuote, mainPath) => `require(${mainQuote}${mainPath}${mainQuote})`
      );
  }
  const layout = bootstrapLayout(normalized);
  const mainRequire = /require\((['"])(\.\/(?:main-dist|dist-main)\/main(?:\.js)?)\1\)/;
  const migrationRequire = /require\((['"])(\.\/(?:main-dist|dist-main)\/migration(?:\.js)?)\1\);?/;
  if (!normalized.includes("requestSingleInstanceLock") || !mainRequire.test(normalized) || !migrationRequire.test(normalized)) {
    throw new Error("Bootstrap ZaloPC không tương thích với hook hiện tại.");
  }
  normalized = normalized
    .replace(new RegExp(`\\s*\\/\\* ${PATCH_MARKER} \\*\\/\\s*require\\((['"])\\.\\/(?:zax|zpool)-app-init\\1\\);?`, "g"), "")
    .replace(/\s*require\((['"])\.\/(?:zax|zpool)\1\);?/g, "");
  return normalized.replace(migrationRequire, (match) =>
    `${match}\n  /* ${PATCH_MARKER} */\n  require('./zpool-app-init');\n  require('./zpool');`
  );
}

function hasPatchMarker(source) {
  return String(source).includes(PATCH_MARKER);
}

function hasValidZpoolBootstrap(source) {
  const bootstrap = String(source);
  const initMatches = [...bootstrap.matchAll(/require\((['"])\.\/zpool-app-init\1\);?/g)];
  const hookMatches = [...bootstrap.matchAll(/require\((['"])\.\/zpool\1\);?/g)];
  const mainMatch = bootstrap.match(/require\((['"])(\.\/(?:main-dist|dist-main)\/main(?:\.js)?)\1\)/);
  return initMatches.length === 1
    && hookMatches.length === 1
    && Boolean(mainMatch)
    && initMatches[0].index < hookMatches[0].index
    && hookMatches[0].index < mainMatch.index;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function archiveSidecarPath(archive, label) {
  const extension = path.extname(archive);
  const base = extension ? archive.slice(0, -extension.length) : archive;
  return `${base}.${label}${extension}`;
}

function withRawAsarAccess(action) {
  const previous = process.noAsar;
  process.noAsar = true;
  try {
    return action();
  } finally {
    process.noAsar = previous;
  }
}

function unpackedPath(filePath) {
  return filePath.replace(/([\\/])app\.asar\1/, "$1app.asar.unpacked$1");
}

function readHookFiles(hookRoot) {
  const hooks = new Map();
  for (const name of HOOK_FILES) {
    const packagedPath = path.join(hookRoot, name);
    const diskPath = unpackedPath(packagedPath);
    try {
      hooks.set(name, fs.readFileSync(diskPath));
    } catch (error) {
      throw new Error(`Không đọc được hook ${name} của ZPool tại ${diskPath}: ${error.message}`);
    }
  }
  return hooks;
}

function powershellEncoded(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function processQueryScript(appDataId = null) {
  const filter = appDataId === null
    ? ""
    : ` | Where-Object { $_.CommandLine -match '(?i)(?:^|\\s)--appdata-id(?:=|\\s+)${normalizeAppDataId(appDataId)}(?:\\s|$)' }`;
  return `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process -Filter \"Name='Zalo.exe'\"${filter} | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`)));
  });
}

function validatePeExecutable(executable) {
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64) {
    throw new Error(`executable không phải regular file PE hợp lệ: ${executable}`);
  }
  const descriptor = fs.openSync(executable, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0);
    if (dosHeader.toString("ascii", 0, 2) !== "MZ") throw new Error(`executable không có PE magic MZ: ${executable}`);
    const peOffset = dosHeader.readUInt32LE(0x3c);
    if (peOffset < 64 || peOffset > stat.size - 6) throw new Error(`executable có PE header offset không hợp lệ: ${executable}`);
    const peHeader = Buffer.alloc(6);
    fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset);
    if (!peHeader.subarray(0, 4).equals(Buffer.from("PE\0\0", "binary"))) {
      throw new Error(`executable thiếu PE signature: ${executable}`);
    }
    if (![0x014c, 0x8664, 0xaa64].includes(peHeader.readUInt16LE(4))) {
      throw new Error(`executable có PE machine type không được hỗ trợ: ${executable}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateZaloInstall(root, version, inspect = inspectArchive, options = {}) {
  const executable = path.join(root, "Zalo.exe");
  const archive = path.join(root, "resources", "app.asar");
  if (!fs.existsSync(executable)) throw new Error(`thiếu executable: ${executable}`);
  if (!fs.existsSync(archive)) throw new Error(`thiếu archive: ${archive}`);
  if (options.bundled || options.validateExecutable) validatePeExecutable(executable);
  if (options.bundled) {
    const archiveStat = withRawAsarAccess(() => fs.lstatSync(archive));
    if (!archiveStat.isFile() || archiveStat.isSymbolicLink()) throw new Error(`archive không phải regular file: ${archive}`);
  }
  const info = inspect(archive);
  if (info.layout !== "main-dist" && info.layout !== "dist-main") throw new Error("layout không được hỗ trợ");
  if (options.bundled || options.requireVersion) {
    if (info.version !== version) throw new Error(`archive sai phiên bản: cần ${version}, nhận ${info.version}`);
  }
  if (options.bundled) {
    if (!info.patched || !info.hooksPresent) throw new Error("archive chưa có bootstrap/hook Zpool hợp lệ");
    if (options.hookRoot && !archiveHooksMatch(archive, options.hookRoot)) {
      throw new Error("hook Zpool trong archive không khớp packaged hooks hiện hành");
    }
    if (inspect === inspectArchive) {
      const unpackedEntries = archiveUnpackDirPattern(archive);
      const unpackedRoot = `${archive}.unpacked`;
      if (unpackedEntries.length && !fs.statSync(unpackedRoot, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`archive thiếu app.asar.unpacked: ${unpackedRoot}`);
      }
      for (const entry of unpackedEntries) {
        const unpackedPath = path.join(unpackedRoot, ...entry.split("/"));
        const stat = fs.statSync(unpackedPath, { throwIfNoEntry: false });
        if (!stat || (!stat.isFile() && !stat.isDirectory())) throw new Error(`archive thiếu unpacked entry: ${entry}`);
      }
    }
  }
  return { version, root, executable, archive };
}

function locateZaloInRoot(installDir, inspect = inspectArchive, options = {}) {
  let entries;
  try {
    entries = fs.readdirSync(installDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Không tìm thấy thư mục cài đặt Zalo: ${installDir}`);
    throw new Error(`Không thể đọc thư mục cài đặt Zalo: ${error.message}`);
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^Zalo-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => ({
      version: entry.name.slice("Zalo-".length),
      root: path.join(installDir, entry.name),
    }))
    .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }));
  if (!candidates.length) throw new Error("Không tìm thấy bản ZaloPC versioned tại LOCALAPPDATA\\Programs\\Zalo.");
  const failures = [];
  for (const candidate of candidates) {
    try {
      return { installDir, ...validateZaloInstall(candidate.root, candidate.version, inspect, options) };
    } catch (error) {
      failures.push(`${candidate.version}: ${error.message}`);
    }
  }
  throw new Error(`Không có phiên bản ZaloPC nào tương thích với hook hiện tại.\n${failures.join("\n")}`);
}

function locateZaloInstall(localAppData = process.env.LOCALAPPDATA, platform = process.platform, inspect = inspectArchive, options = {}) {
  if (platform !== "win32") throw new Error("ZaloPC native chỉ được hỗ trợ trên Windows.");
  if (!localAppData) throw new Error("Không xác định được LOCALAPPDATA.");
  const candidateDirs = [
    path.join(localAppData, "Programs", "Zalo"),
    path.join(localAppData, "Programs", "zalo-profile-manager", "resources", "zalo-runtime"),
  ];
  let lastError = null;
  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      return locateZaloInRoot(dir, inspect, options);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  return locateZaloInRoot(candidateDirs[0], inspect, options);
}

function readRuntimeManifest(runtimeRoot) {
  const manifestPath = path.join(runtimeRoot, RUNTIME_MANIFEST);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`manifest không đọc được: ${manifestPath}: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object"
    || !/^\d+\.\d+\.\d+$/.test(manifest.version)
    || manifest.directory !== `Zalo-${manifest.version}`) {
    throw new Error(`manifest không hợp lệ: ${manifestPath}`);
  }
  const versionedDirectories = fs.readdirSync(runtimeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^Zalo-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => entry.name);
  if (versionedDirectories.length !== 1 || versionedDirectories[0] !== manifest.directory) {
    throw new Error(`manifest không khớp runtime versioned duy nhất: ${versionedDirectories.join(", ") || "none"}`);
  }
  return manifest;
}

function resolveZaloInstall(resourcesPath, localAppData = process.env.LOCALAPPDATA, platform = process.platform, inspect = inspectArchive, hookRoot = null) {
  if (platform !== "win32") throw new Error("ZaloPC native chỉ được hỗ trợ trên Windows.");
  const bundledRoot = resourcesPath ? path.join(resourcesPath, "zalo-runtime") : "";
  if (bundledRoot && fs.existsSync(bundledRoot)) {
    try {
      const manifest = readRuntimeManifest(bundledRoot);
      const versionRoot = path.join(bundledRoot, manifest.directory);
      return {
        installDir: bundledRoot,
        bundled: true,
        ...validateZaloInstall(versionRoot, manifest.version, inspect, { bundled: true, hookRoot }),
      };
    } catch (error) {
      throw new Error(`Runtime ZaloPC bundled không hợp lệ: ${error.message}`);
    }
  }
  return { ...locateZaloInstall(localAppData, platform, inspect), bundled: false };
}

function inspectArchive(archive) {
  return withRawAsarAccess(() => {
    asar.uncache(archive);
    try {
      let packageJson;
      try {
        packageJson = JSON.parse(asar.extractFile(archive, "package.json").toString("utf8"));
      } catch (error) {
        throw new Error(`Không đọc được package.json bên trong ${path.basename(archive)}: ${error.message}`);
      }
      let bootstrap;
      try {
        bootstrap = asar.extractFile(archive, "bootstrap.js").toString("utf8");
      } catch (error) {
        throw new Error(`Không đọc được bootstrap.js bên trong ${path.basename(archive)}: ${error.message}`);
      }
      if (packageJson.main !== "bootstrap.js") throw new Error("package main không phải bootstrap.js");
      const layout = bootstrapLayout(bootstrap);
      const entries = new Set(asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, "")));
      const hooksPresent = HOOK_FILES.every((name) => {
        if (!entries.has(name)) return false;
        try { return asar.extractFile(archive, name).length > 0; } catch { return false; }
      });
      const legacyHooksPresent = [...entries].some((entry) => LEGACY_HOOK_FILES.includes(path.posix.basename(entry)));
      const legacyBootstrap = /require\((['"])\.\/zax(?:-app-init)?\1\)/.test(bootstrap);
      const patched = hasPatchMarker(bootstrap) && hasValidZpoolBootstrap(bootstrap)
        && hooksPresent && !legacyHooksPresent && !legacyBootstrap;
      return { version: packageJson.version || "unknown", bootstrap, layout, patched, hooksPresent, legacyHooksPresent, legacyBootstrap };
    } finally {
      asar.uncache(archive);
    }
  });
}

function archiveHooksMatch(archive, hookRootOrFiles) {
  const hookFiles = hookRootOrFiles instanceof Map ? hookRootOrFiles : readHookFiles(hookRootOrFiles);
  return withRawAsarAccess(() => {
    asar.uncache(archive);
    try {
      return HOOK_FILES.every((name) => {
        try {
          return asar.extractFile(archive, name).equals(hookFiles.get(name));
        } catch {
          return false;
        }
      });
    } finally {
      asar.uncache(archive);
    }
  });
}

function archiveUnpackedMetadata(archive) {
  return withRawAsarAccess(() => {
    asar.uncache(archive);
    try {
      const unpacked = [];
      for (const entry of asar.listPackage(archive)) {
        const normalized = entry.replaceAll("\\", "/").replace(/^\//, "");
        if (!normalized) continue;
        try {
          const entryPath = entry.replace(/^[\\/]/, "");
          const stat = asar.statFile(archive, entryPath);
          if (stat.unpacked) unpacked.push({ path: normalized, directory: Boolean(stat.files) });
        } catch {}
      }
      return unpacked.sort((left, right) => left.path.localeCompare(right.path));
    } finally {
      asar.uncache(archive);
    }
  });
}

function archiveUnpackDirPattern(archive) {
  return archiveUnpackedMetadata(archive).map((entry) => entry.path);
}

function unpackPattern(root, entries) {
  if (!entries.length) return null;
  const escaped = entries.map((entry) => path.join(root, ...entry.path.split("/")).replaceAll("\\", "/")
    .replace(/([*?{}()[\],!+@])/g, "\\$1"));
  return escaped.length === 1 ? escaped[0] : `{${escaped.join(",")}}`;
}

function unpackDirPattern(entries) {
  const directories = entries.filter((entry) => entry.directory
    && !entries.some((parent) => parent.directory && parent.path !== entry.path && entry.path.startsWith(`${parent.path}/`)));
  if (!directories.length) return null;
  const escaped = directories.map((entry) => entry.path.replaceAll("/", path.sep)
    .replace(/([*?{}()[\],!+@])/g, "\\$1"));
  return escaped.length === 1 ? escaped[0] : `{${escaped.join(",")}}`;
}

function ensureProfileData(appDataRoot, profile) {
  const dataPath = profileDataPath(appDataRoot, profile.appDataId);
  fs.mkdirSync(dataPath, { recursive: true });
  const metaPath = path.join(dataPath, "meta.bin");
  let existingMeta = null;
  if (fs.existsSync(metaPath)) {
    try {
      existingMeta = decodeMeta(fs.readFileSync(metaPath, "utf8"));
      if (!existingMeta || typeof existingMeta !== "object" || Array.isArray(existingMeta)) throw new Error("metadata không phải object");
    } catch {
      throw new Error("meta.bin hiện có không đúng codec legacy; từ chối ghi đè.");
    }
  }
  const payload = metaPayload(profile);
  const nextMeta = existingMeta ? { ...existingMeta, ...payload } : payload;
  if (existingMeta && Object.hasOwn(existingMeta, "cookies")) nextMeta.cookies = existingMeta.cookies;
  writeFileAtomic(metaPath, encodeMetaV2(nextMeta));
  return { dataPath, metaPath };
}

async function patchArchive(archive, hookRoot) {
  const previousNoAsar = process.noAsar;
  process.noAsar = true;
  const hookFiles = readHookFiles(hookRoot);
  try {
    const before = inspectArchive(archive);
    const unpackedEntries = archiveUnpackedMetadata(archive);
    if (before.patched && archiveHooksMatch(archive, hookFiles)) return { ...before, changed: false, backup: null };
    const backup = archiveSidecarPath(archive, `zpm-backup-${sha256File(archive).slice(0, 16)}`);
    if (fs.existsSync(backup)) {
      const expectedPrefix = backup.match(/-([0-9a-f]{16})\.asar$/i)?.[1];
      if (!expectedPrefix || !sha256File(backup).startsWith(expectedPrefix)) {
        throw new Error("Backup app.asar hiện có không khớp checksum.");
      }
    } else {
      const backupTemp = `${backup}.tmp.${process.pid}`;
      try {
        fs.copyFileSync(archive, backupTemp, fs.constants.COPYFILE_EXCL);
        if (sha256File(backupTemp) !== sha256File(archive)) throw new Error("Backup app.asar không khớp checksum.");
        fs.renameSync(backupTemp, backup);
      } finally {
        try { fs.unlinkSync(backupTemp); } catch {}
      }
    }
    const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-"));
    const extracted = path.join(workRoot, "app");
    const transactionId = `${process.pid}-${crypto.randomUUID()}`;
    const staged = archiveSidecarPath(archive, `zpm-next-${transactionId}`);
    const previous = archiveSidecarPath(archive, `zpm-previous-${transactionId}`);
    try {
      asar.extractAll(archive, extracted);
      const bootstrapPath = path.join(extracted, "bootstrap.js");
      writeFileAtomic(bootstrapPath, patchBootstrap(fs.readFileSync(bootstrapPath, "utf8")));
      for (const name of LEGACY_HOOK_FILES) {
        fs.rmSync(path.join(extracted, name), { force: true });
        for (const layout of ["main-dist", "dist-main"]) {
          fs.rmSync(path.join(extracted, layout, "assets", "js", "main", name), { force: true });
        }
      }
      for (const [name, contents] of hookFiles) fs.writeFileSync(path.join(extracted, name), contents);
      const unpack = unpackPattern(extracted, unpackedEntries.filter((entry) => !entry.directory));
      const unpackDir = unpackDirPattern(unpackedEntries);
      await asar.createPackageWithOptions(extracted, staged, {
        ...(unpack ? { unpack } : {}),
        ...(unpackDir ? { unpackDir } : {}),
      });
      const stagedInfo = inspectArchive(staged);
      if (!stagedInfo.patched || stagedInfo.version !== before.version || !archiveHooksMatch(staged, hookFiles)) throw new Error("Không xác minh được archive đã patch.");
      const stagedUnpackedEntries = archiveUnpackDirPattern(staged);
      if (stagedUnpackedEntries.length !== unpackedEntries.length
        || stagedUnpackedEntries.some((entry, index) => entry !== unpackedEntries[index].path)) {
        throw new Error("Không bảo toàn được metadata unpacked khi patch archive.");
      }
      asar.uncache(archive);
      let replacedByRename = false;
      try {
        fs.renameSync(archive, previous);
        try { fs.renameSync(staged, archive); } catch (error) { fs.renameSync(previous, archive); throw error; }
        replacedByRename = true;
      } catch (error) {
        if (!new Set(["EBUSY", "EPERM", "EACCES"]).has(error.code)) throw error;
        try {
          fs.copyFileSync(staged, archive);
        } catch (copyError) {
          if (new Set(["EBUSY", "EPERM", "EACCES"]).has(copyError.code)) {
            throw new Error("ZaloPC đang sử dụng app.asar. Hãy thoát hoàn toàn ZaloPC rồi mở profile lại.");
          }
          throw copyError;
        }
      }
      try {
        if (!inspectArchive(archive).patched) throw new Error("Không xác minh được archive sau khi thay thế.");
        if (replacedByRename) fs.unlinkSync(previous);
      } catch (error) {
        if (replacedByRename) {
          try { fs.unlinkSync(archive); } catch {}
          try { fs.renameSync(previous, archive); } catch {}
        } else {
          try { fs.copyFileSync(backup, archive); } catch {}
        }
        throw error;
      }
      asar.uncache(staged);
      asar.uncache(archive);
      return { ...inspectArchive(archive), changed: true, backup };
    } finally {
      try { fs.rmSync(workRoot, { recursive: true, force: true }); } catch {}
      try { fs.unlinkSync(staged); } catch {}
      try { fs.rmSync(`${staged}.unpacked`, { recursive: true, force: true }); } catch {}
    }
  } finally {
    process.noAsar = previousNoAsar;
  }
}

function ensurePatched(archive, hookRoot) {
  const operation = patchOperation.then(() => patchArchive(archive, hookRoot));
  patchOperation = operation.catch(() => {});
  return operation;
}

async function queryZaloProcesses(appDataId = null, runner = runProcess) {
  const script = processQueryScript(appDataId);
  const { stdout } = await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncoded(script)]);
  return parsePowerShellProcesses(stdout);
}

function launchZalo(executable, appDataId, spawnImpl = spawn) {
  const child = spawnImpl(executable, [`--appdata-id=${normalizeAppDataId(appDataId)}`], { detached: true, stdio: "ignore", windowsHide: false });
  child.once?.("error", () => {});
  child.unref();
  return child.pid;
}

async function waitForProfileProcess(appDataId, options = {}) {
  const started = Date.now();
  const query = options.query || queryZaloProcesses;
  while (Date.now() - started < (options.timeoutMs || 15000)) {
    const roots = rootProcessesForAppDataId(await query(appDataId), appDataId, options.executable);
    if (roots.length === 1) return roots[0];
    if (roots.length > 1) throw new Error("Không thể xác định chắc chắn process gốc của profile.");
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 500));
  }
  throw new Error("Đã launch nhưng không tìm thấy process Zalo đúng --appdata-id.");
}

async function killProfile(appDataId, runner = runProcess) {
  const roots = rootProcessesForAppDataId(await queryZaloProcesses(appDataId, runner), appDataId);
  if (roots.length > 1) throw new Error("Không thể xác định chắc chắn process gốc để dừng.");
  if (!roots.length) return false;
  await runner("taskkill.exe", ["/F", "/T", "/PID", String(roots[0].pid)]);
  const remaining = processesForAppDataId(await queryZaloProcesses(appDataId, runner), appDataId);
  if (remaining.length) throw new Error("Không thể xác nhận toàn bộ process của profile đã dừng.");
  return true;
}

function profileTitle(profile) {
  const route = profile.proxy.enabled
    ? profile.proxyPublicIp || profile.proxy.host
    : "DIRECT";
  return `${profile.name} | ${route}`;
}

function titleWatcherScript(appDataId, title) {
  const safeId = normalizeAppDataId(appDataId);
  const encodedTitle = Buffer.from(String(title), "utf8").toString("base64");
  return `$ErrorActionPreference='Stop'; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class ZpmWin { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string t); }'; $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedTitle}')); $updated=$false; $items=@(Get-CimInstance Win32_Process -Filter "Name='Zalo.exe'" | Where-Object { $_.CommandLine -match '(?i)(?:^|\\s)--appdata-id(?:=|\\s+)${safeId}(?:\\s|$)' }); foreach($item in $items){$p=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if($p -and $p.MainWindowHandle -ne 0){if([ZpmWin]::SetWindowText($p.MainWindowHandle,$t)){$updated=$true}}}; if(-not $updated){exit 2}`;
}

async function updateWindowTitle(appDataId, title, runner = runProcess) {
  try {
    await runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncoded(titleWatcherScript(appDataId, title))]);
    return true;
  } catch {
    return false;
  }
}

async function watchWindowTitle(appDataId, title, options = {}) {
  const update = options.update || updateWindowTitle;
  for (let attempt = 0; attempt < (options.attempts || 20); attempt += 1) {
    if (await update(appDataId, title)) return true;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs || 750));
  }
  return false;
}

module.exports = {
  AUTOMATIC_USER_AGENTS,
  IDENTITY_ACCURACY_METERS,
  IDENTITY_RADIUS_METERS,
  META_KEY,
  PATCH_MARKER,
  RUNTIME_MANIFEST,
  defaultBrowserPolicy,
  distanceMeters,
  generateAutomaticIdentity,
  ipVersion,
  isGlobalIp,
  randomCoordinate,
  sanitizeAutomaticIdentity,
  sanitizeBrowserPolicy,
  sanitizeUserAgent,
  sameBrowserPolicy,
  sameAutomaticIdentity,
  sameLaunchConfig,
  assertOwnedProfilePath,
  assertResolvedProxyRoute,
  archiveHooksMatch,
  archiveUnpackDirPattern,
  decodeMeta,
  encodeMetaV2,
  ensurePatched,
  ensureProfileData,
  hasPatchMarker,
  inspectArchive,
  killProfile,
  launchZalo,
  locateZaloInRoot,
  locateZaloInstall,
  metaPayload,
  nextAvailableAppDataId,
  normalizeAppDataId,
  parseAppDataId,
  parsePowerShellProcesses,
  patchBootstrap,
  powershellEncoded,
  processQueryScript,
  profileTitle,
  processesForAppDataId,
  profileDataPath,
  publicProfile,
  reconcileProfileRuntime,
  resolveZaloInstall,
  rootProcessesForAppDataId,
  runProcess,
  sanitizeProfile,
  sanitizeProxy,
  sameProxyConfig,
  sha256File,
  titleWatcherScript,
  updateWindowTitle,
  validateGeoIpResponse,
  validatePeExecutable,
  watchWindowTitle,
  writeFileAtomic,
  queryZaloProcesses,
  waitForProfileProcess,
};
