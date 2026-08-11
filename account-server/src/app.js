"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { createKey, decryptText, encryptText, randomToken, sha256, verifyPassword } = require("./security");

const MAX_BODY = 32 * 1024;
const UID_PATTERN = /^[a-f0-9]{64}$/;
const STATUS_ERROR = "Key hoặc tài khoản không hợp lệ.";
const GMT7_OFFSET = 7 * 3600 * 1000;
const LOGIN_WINDOW_MS = 15 * 60000;
const MAX_LOGIN_CLIENTS = 10000;
const XUI_TIMEOUT_MS = 8000;
const VLESS_EMAIL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/;
const VLESS_ONLINE_WINDOW_MS = 24 * 3600 * 1000;
const GPM_BASE_URL = "https://api.gpmsoftwares.com/api/v1";
const GPM_ORIGIN = "https://account.gpmsoftwares.com";
const GPM_TIMEOUT_MS = 15000;
const GPM_REFRESH_COOKIE = "refreshToken_account";
const GPM_EXCHANGE_COOLDOWN_MS = 72 * 3600000;
const GPM_EXPIRING_WINDOW_MS = 72 * 3600000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROTON_BASE_URL = "https://account.protonvpn.com";
const PROTON_ORIGIN = "https://account.protonvpn.com";
const PROTON_TIMEOUT_MS = 12000;
const PROTON_MAX_DEVICES = 10;
const PROTON_ACCEPT = "application/vnd.protonmail.v1+json";
const PROTON_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
const PROTON_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PROTON_HELPER_OUTPUT_MAX = 64 * 1024;

// Key license chỉ hiện đầu/cuối trên bảng; bản đầy đủ phải gọi endpoint reveal
// riêng để không nằm sẵn trong DOM của trang admin.
function maskKey(value) {
  const key = String(value || "");
  if (!key) return "";
  if (key.length <= 8) return "********";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function nowIso(clock) { return new Date(clock()).toISOString(); }

function parseIsoDate(str) {
  if (!str) return null;
  let normalized = String(str).trim();
  if (normalized.includes(" ") && !normalized.includes("T")) {
    normalized = normalized.replace(" ", "T");
  }
  if (!normalized.endsWith("Z") && !normalized.includes("+")) {
    normalized += "Z";
  }
  const d = new Date(normalized);
  return Number.isNaN(d.getTime()) ? null : d;
}
function addDays(clock, days, startDateStr = null) {
  let baseMs;
  if (startDateStr && typeof startDateStr === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDateStr.trim())) {
    const d = new Date(`${startDateStr.trim()}T08:00:00.000+07:00`);
    baseMs = !Number.isNaN(d.getTime()) ? d.getTime() : clock() + GMT7_OFFSET;
  } else {
    baseMs = clock() + GMT7_OFFSET;
  }
  const expGmt7 = new Date(baseMs + days * 86400000);
  expGmt7.setUTCHours(8, 0, 0, 0);
  return new Date(expGmt7.getTime() - GMT7_OFFSET).toISOString();
}
// Gia hạn 30 ngày, chốt 08:00 GMT+7. Dùng chung cho action đơn lẻ và hàng loạt
// để hai đường dẫn không lệch nhau (trước đây bulk dùng GMT+7, đơn lẻ dùng
// setHours theo timezone của server).
function extendExpiry(currentExpiry, clock, days = 30) {
  const parsed = parseIsoDate(currentExpiry);
  const base = Math.max(parsed ? parsed.getTime() : clock(), clock());
  const expGmt7 = new Date(base + days * 86400000 + GMT7_OFFSET);
  expGmt7.setUTCHours(8, 0, 0, 0);
  return new Date(expGmt7.getTime() - GMT7_OFFSET).toISOString();
}

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length, "cache-control": "no-store", ...headers });
  res.end(data);
}
function redirect(res, location, headers = {}) { res.writeHead(303, { location, "cache-control": "no-store", ...headers }); res.end(); }
function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((item) => item.trim().split("=")).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
}
async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Dữ liệu quá lớn."), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = String(req.headers["content-type"] || "").split(";", 1)[0];
  if (type === "application/json") return JSON.parse(raw);
  if (type === "application/x-www-form-urlencoded") return Object.fromEntries(new URLSearchParams(raw));
  throw Object.assign(new Error("Content-Type không được hỗ trợ."), { status: 415 });
}
function text(value, min, max, label) {
  const result = String(value ?? "").trim();
  if (result.length < min || result.length > max) throw Object.assign(new Error(`${label} không hợp lệ.`), { status: 400 });
  return result;
}
function positiveInt(value, min, max, label) {
  const result = Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw Object.assign(new Error(`${label} không hợp lệ.`), { status: 400 });
  return result;
}
function finiteNumber(value, min, max, label) {
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw Object.assign(new Error(`${label} không hợp lệ.`), { status: 400 });
  return result;
}
function escapeHtml(value) { return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;"); }
function uidHint(uid) { return uid ? `${uid.slice(0, 8)}...${uid.slice(-6)}` : ""; }

function isLoopback(address) {
  const value = String(address || "").toLowerCase();
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

// Trusted forwarders: loopback always, plus the host's default gateway when the
// app runs behind a Docker userland proxy (nginx -> 127.0.0.1:8080 arrives from
// the bridge gateway, not loopback). Only host reverse proxies use the gateway,
// so trusting it keeps the trust list to hosts on the same box.
function readDefaultGateway() {
  try {
    const route = fs.readFileSync("/proc/net/route", "utf8");
    for (const line of route.split("\n")) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 3 && columns[0] !== "Iface" && columns[1] === "00000000") {
        const hex = columns[2];
        return `${parseInt(hex.slice(6, 8), 16) || 0}.${parseInt(hex.slice(4, 6), 16) || 0}.${parseInt(hex.slice(2, 4), 16) || 0}.${parseInt(hex.slice(0, 2), 16) || 0}`;
      }
    }
  } catch {}
  return null;
}

function isGateway(address, gateway) {
  return !!gateway && String(address || "").toLowerCase().replace(/^::ffff:/, "") === gateway;
}

function formatVietnamDateTime(isoString) {
  if (!isoString) return "Chưa online";
  const d = parseIsoDate(isoString);
  if (!d) return "Chưa online";
  const gmt7 = new Date(d.getTime() + GMT7_OFFSET);
  const pad = (n) => String(n).padStart(2, "0");
  const hh = pad(gmt7.getUTCHours());
  const mm = pad(gmt7.getUTCMinutes());
  const DD = pad(gmt7.getUTCDate());
  const MM = pad(gmt7.getUTCMonth() + 1);
  const YYYY = gmt7.getUTCFullYear();
  return `${hh}:${mm} - ${DD}/${MM}/${YYYY}`;
}

function formatDetailedRemainingTime(expiresIso, clock) {
  if (!expiresIso) return "∞";
  const d = parseIsoDate(expiresIso);
  if (!d) return "∞";
  const diffMs = d.getTime() - clock();
  if (diffMs <= 0) return "Đã hết hạn";
  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days} ngày`);
  if (hours > 0 || days > 0) parts.push(`${hours} giờ`);
  parts.push(`${minutes} phút`);
  return parts.join(" ");
}

function createApp(options) {
  const { db, adminPasswordHash, clock = Date.now, production = false, trustProxy = false, dockerGateway = null, fetchImpl = fetch, setIntervalImpl = setInterval } = options;
  if (!db || !adminPasswordHash) throw new Error("Thiếu database hoặc ADMIN_PASSWORD_HASH.");
  const adminHtml = fs.readFileSync(path.join(__dirname, "admin.html"), "utf8");
  const adminCss = fs.readFileSync(path.join(__dirname, "admin.css"), "utf8");
  const adminJs = fs.readFileSync(path.join(__dirname, "admin.js"), "utf8");
  const loginAttempts = new Map();
  const xui = normalizeXuiConfig(options.xui || {});
  const xuiAuth = { cookie: "", csrf: "", pending: null };
  const gpm = normalizeGpmConfig(options.gpm || {});
  const gpmAuth = { accessToken: "", refreshCookie: "", user: null, renewedAt: 0, pending: null };
  const proton = normalizeProtonConfig(options.proton || {});
  const protonRefreshPending = new Map();
  let protonRefreshQueue = Promise.resolve();

  function normalizeXuiConfig(config) {
    const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
    const token = String(config.token || "").trim();
    const username = String(config.username || "").trim();
    const password = String(config.password || "");
    if (!baseUrl) return { configured: false, reason: "Thiếu URL của X-UI Panel." };
    // X-UI chuẩn xác thực bằng session cookie lấy từ POST /login. Token tĩnh chỉ
    // dùng cho panel có bản vá riêng, và chỉ được dùng khi không có user/password.
    if (!token && !(username && password)) return { configured: false, reason: "Thiếu thông tin đăng nhập X-UI Panel: cần username + password, hoặc API token." };
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return { configured: false, reason: "URL X-UI Panel không hợp lệ." }; }
    const allowed = parsed.protocol === "https:" || parsed.protocol === "http:" && config.allowInsecureHttp === true;
    if (!allowed || parsed.username || parsed.password || parsed.search || parsed.hash) return { configured: false, reason: "URL X-UI Panel phải sử dụng HTTPS và không chứa thông tin đăng nhập, query hoặc fragment." };
    return { configured: true, baseUrl, token, username, password, timeoutMs: Number(config.timeoutMs) || XUI_TIMEOUT_MS, onlineWindowMs: Number(config.onlineWindowMs) || VLESS_ONLINE_WINDOW_MS };
  }

  function requireXui() {
    if (!xui.configured) throw Object.assign(new Error("X-UI Panel chưa được cấu hình an toàn."), { status: 503 });
  }

  async function panelFetch(panelPath, method, payload, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), xui.timeoutMs);
    try {
      return await fetchImpl(`${xui.baseUrl}${panelPath}`, {
        method,
        headers: {
           accept: "application/json",
           "x-requested-with": "XMLHttpRequest",
           ...(payload === undefined ? {} : { "content-type": payload instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" }),
          ...headers,
        },
           body: payload === undefined ? undefined : payload instanceof URLSearchParams ? payload : JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  }

  function mergeCookies(...sets) {
    const jar = new Map();
    for (const value of sets.flat()) {
      const pair = String(value || "").split(";", 1)[0];
      const separator = pair.indexOf("=");
      if (separator > 0) jar.set(pair.slice(0, separator), pair);
    }
    return [...jar.values()].join("; ");
  }

  // Session cookie của X-UI hết hạn theo cấu hình panel (mặc định 1 giờ). Giữ một
  // promise đăng nhập duy nhất để nhiều request song song không cùng lúc gọi
  // /login, và đăng nhập lại khi panel trả về 401/302 hoặc mất cookie.
  async function xuiLogin() {
    if (!xui.username || !xui.password) throw Object.assign(new Error("X-UI Panel chưa cấu hình username/password để đăng nhập lại."), { status: 503 });
    if (!xuiAuth.pending) {
      xuiAuth.pending = (async () => {
        const csrfResponse = await panelFetch("/csrf-token", "GET");
        let csrfResult;
        try { csrfResult = await csrfResponse.json(); } catch { throw Object.assign(new Error("X-UI Panel trả CSRF không hợp lệ."), { status: 502 }); }
        if (!csrfResponse.ok || !csrfResult?.success || typeof csrfResult.obj !== "string" || !csrfResult.obj) throw Object.assign(new Error("X-UI Panel không cấp CSRF token."), { status: 502 });
        const bootstrapCookies = typeof csrfResponse.headers.getSetCookie === "function" ? csrfResponse.headers.getSetCookie() : [];
        const bootstrapCookie = mergeCookies(bootstrapCookies);
        const response = await panelFetch("/login", "POST", new URLSearchParams({ username: xui.username, password: xui.password, twoFactorCode: "" }), {
          cookie: bootstrapCookie,
          "x-csrf-token": csrfResult.obj,
        });
        if (!response.ok) throw Object.assign(new Error("X-UI Panel từ chối đăng nhập."), { status: 502 });
        let result;
        try { result = await response.json(); } catch { throw Object.assign(new Error("X-UI Panel trả dữ liệu đăng nhập không hợp lệ."), { status: 502 }); }
        if (!result || result.success !== true) throw Object.assign(new Error("Sai username hoặc password của X-UI Panel."), { status: 502 });
        const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
        const cookie = mergeCookies(bootstrapCookies, cookies);
        if (!cookie) throw Object.assign(new Error("X-UI Panel không trả session cookie."), { status: 502 });
        xuiAuth.cookie = cookie;
        xuiAuth.csrf = csrfResult.obj;
        return cookie;
      })().finally(() => { xuiAuth.pending = null; });
    }
    return xuiAuth.pending;
  }

  async function panelRequest(panelPath, method = "GET", payload) {
    requireXui();
    try {
      // Username/password is the authoritative login method. A stale token may
      // remain in compose during migration, but must never bypass this flow.
      const useSession = Boolean(xui.username && xui.password);
      let cookie = xuiAuth.cookie;
      if (!cookie && useSession) cookie = await xuiLogin();
      let response = await panelFetch(panelPath, method, payload, {
        ...(!useSession && xui.token ? { authorization: `Bearer ${xui.token}` } : {}),
        ...(cookie ? { cookie } : {}),
        ...(useSession && method !== "GET" && xuiAuth.csrf ? { "x-csrf-token": xuiAuth.csrf } : {}),
      });
      // 401/403 hoặc redirect về trang login đều nghĩa là session đã hết hạn.
      if ((response.status === 401 || response.status === 403 || response.status >= 300 && response.status < 400) && xui.username && xui.password) {
        if (xuiAuth.cookie === cookie) {
          xuiAuth.cookie = "";
          xuiAuth.csrf = "";
          cookie = await xuiLogin();
        } else {
          cookie = xuiAuth.cookie || await xuiLogin();
        }
        response = await panelFetch(panelPath, method, payload, {
          cookie,
          ...(method !== "GET" && xuiAuth.csrf ? { "x-csrf-token": xuiAuth.csrf } : {}),
        });
      }
      if (!response.ok) throw Object.assign(new Error("X-UI Panel từ chối yêu cầu."), { status: 502 });
      let result;
      try { result = await response.json(); } catch { throw Object.assign(new Error("X-UI Panel trả dữ liệu không hợp lệ."), { status: 502 }); }
      if (!result || result.success !== true) throw Object.assign(new Error("X-UI Panel không thể hoàn tất yêu cầu."), { status: 502 });
      return result.obj;
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("X-UI Panel phản hồi quá chậm."), { status: 504 });
      if (error.status) throw error;
      throw Object.assign(new Error("Không thể kết nối X-UI Panel."), { status: 502 });
    }
  }

  function parseClients(settings) {
    let parsed = settings;
    if (typeof settings === "string") {
      try { parsed = JSON.parse(settings); } catch { throw Object.assign(new Error("X-UI Panel trả cấu hình inbound không hợp lệ."), { status: 502 }); }
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.clients)) throw Object.assign(new Error("X-UI Panel trả cấu hình inbound không hợp lệ."), { status: 502 });
    return parsed.clients;
  }

  function cleanNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
  function projectVlessInbound(inbound) {
    const rawStats = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
    if (rawStats.some((item) => !item || typeof item !== "object")) throw Object.assign(new Error("X-UI Panel trả thống kê client không hợp lệ."), { status: 502 });
    const clients = parseClients(inbound.settings);
    if (clients.some((item) => !item || typeof item !== "object")) throw Object.assign(new Error("X-UI Panel trả danh sách client không hợp lệ."), { status: 502 });
    const stats = new Map(rawStats.map((item) => [String(item.email || ""), item]));
    const now = clock();
    return {
      id: cleanNumber(inbound.id),
      remark: String(inbound.remark || "Inbound VLESS").slice(0, 100),
      port: cleanNumber(inbound.port),
      enabled: inbound.enable !== false,
      clients: clients.map((client) => {
        const email = String(client.email || "").slice(0, 100);
        const traffic = stats.get(email) || {};
        const lastOnline = Number(traffic.lastOnline);
        return {
          email,
          enabled: client.enable !== false,
          limitIp: cleanNumber(client.limitIp),
          totalBytes: cleanNumber(client.totalGB),
          expiryTime: cleanNumber(client.expiryTime),
          up: cleanNumber(traffic.up),
          down: cleanNumber(traffic.down),
          online: Number.isFinite(lastOnline) && lastOnline > 0 && now - lastOnline < xui.onlineWindowMs,
        };
      }),
    };
  }

  async function listVless() {
    const inbounds = await panelRequest("/panel/api/inbounds/list");
    if (!Array.isArray(inbounds)) throw Object.assign(new Error("X-UI Panel trả danh sách không hợp lệ."), { status: 502 });
    return inbounds.filter((item) => item && item.protocol === "vless").map(projectVlessInbound);
  }

  function vlessEmail(value) {
    const result = text(value, 1, 100, "Tên client");
    if (!VLESS_EMAIL_PATTERN.test(result)) throw Object.assign(new Error("Tên client chỉ được chứa chữ, số, dấu chấm, gạch nối, gạch dưới hoặc @."), { status: 400 });
    return result;
  }

  async function revealVless(email) {
    const links = await panelRequest(`/panel/api/clients/links/${encodeURIComponent(email)}`);
    const link = Array.isArray(links) ? links.find((item) => typeof item === "string" && item.startsWith("vless://")) : "";
    let parsed;
    try { parsed = link ? new URL(link) : null; } catch {}
    if (!parsed || parsed.protocol !== "vless:" || !parsed.username || !parsed.hostname) throw Object.assign(new Error("Panel không trả về VLESS key hợp lệ."), { status: 502 });
    return link;
  }

  async function requireUniqueVlessClient(email) {
    const matches = (await listVless()).flatMap((inbound) => inbound.clients.filter((client) => client.email === email));
    if (!matches.length) throw Object.assign(new Error("Không tìm thấy VLESS client."), { status: 404 });
    if (matches.length > 1) throw Object.assign(new Error("Tên VLESS client bị trùng trên nhiều inbound; không thể thao tác an toàn."), { status: 409 });
  }

  function normalizeGpmConfig(config) {
    const email = String(config.email || "").trim();
    const password = String(config.password || "");
    const baseUrl = String(config.baseUrl || GPM_BASE_URL).trim().replace(/\/+$/, "");
    const autoExchange = config.autoExchange !== false;
    const autoExchangeIntervalMs = Math.max(10, Number(config.autoExchangeIntervalMs) || 60000);
    const expiringWindowMs = Math.max(0, Number(config.expiringWindowMs) || GPM_EXPIRING_WINDOW_MS);
    if (!email || !password) return { configured: false, reason: "Thiếu GPM_EMAIL hoặc GPM_PASSWORD trong biến môi trường.", autoExchange, autoExchangeIntervalMs, expiringWindowMs };
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return { configured: false, reason: "URL GPM không hợp lệ." }; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { configured: false, reason: "URL GPM phải là HTTPS và không chứa thông tin đăng nhập, query hoặc fragment." };
    }
    const requestedTimeout = Number(config.timeoutMs);
    const timeoutMs = Math.min(60000, Math.max(1000, Number.isFinite(requestedTimeout) ? requestedTimeout : GPM_TIMEOUT_MS));
    return { configured: true, email, password, baseUrl, timeoutMs, autoExchange, autoExchangeIntervalMs, expiringWindowMs };
  }

  function normalizeProtonConfig(config) {
    const baseUrl = String(config.baseUrl || PROTON_BASE_URL).trim().replace(/\/+$/, "");
    let parsed;
    try { parsed = new URL(baseUrl); } catch { return { configured: false, reason: "URL Proton VPN không hợp lệ." }; }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return { configured: false, reason: "URL Proton VPN phải là HTTPS và không chứa thông tin đăng nhập, query hoặc fragment." };
    }
    return {
      configured: true,
      baseUrl,
      appVersion: String(config.appVersion || "").trim().slice(0, 80),
      defaultCookie: String(config.cookie || ""),
      refreshCommand: String(config.refreshCommand || "").trim(),
      refreshArgs: Array.isArray(config.refreshArgs) ? config.refreshArgs.map((value) => String(value)) : [],
      refreshTimeoutMs: Math.max(5000, Number(config.refreshTimeoutMs) || 120000),
      autoRevoke: config.autoRevoke === true,
      autoRevokeIntervalMs: Math.max(10000, Number(config.autoRevokeIntervalMs) || 3600000),
      timeoutMs: Math.max(1000, Number(config.timeoutMs) || PROTON_TIMEOUT_MS),
    };
  }

  function protonHeaders(account, includeJson = false) {
    return {
      accept: PROTON_ACCEPT,
      "accept-language": "en_US",
      origin: PROTON_ORIGIN,
      referer: `${PROTON_ORIGIN}/`,
      "user-agent": PROTON_USER_AGENT,
      "x-pm-locale": "en_US",
      "x-pm-uid": account.uid,
      ...(account.app_version || proton.appVersion ? { "x-pm-appversion": account.app_version || proton.appVersion } : {}),
      ...(account.cookie_encrypted ? { cookie: decryptText(account.cookie_encrypted) } : {}),
      ...(includeJson ? { "content-type": "application/json" } : {}),
    };
  }

  function protonAccountRow(id) {
    const row = db.prepare("SELECT * FROM proton_accounts WHERE id=?").get(id);
    if (!row) throw Object.assign(new Error("Không tìm thấy Proton account."), { status: 404 });
    return row;
  }

  async function protonFetch(account, protonPath, method = "GET", payload) {
    const cookie = decryptText(account.cookie_encrypted);
    if (!cookie) throw Object.assign(new Error("Proton account chưa có cookie giải mã được."), { status: 503 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), proton.timeoutMs);
    try {
      return await fetchImpl(`${proton.baseUrl}${protonPath}`, {
        method,
        headers: protonHeaders(account, payload !== undefined),
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  }

  async function refreshProtonCredentials(account) {
    if (protonRefreshPending.has(account.id)) return protonRefreshPending.get(account.id);
    const pending = protonRefreshQueue.then(() => refreshProtonCredentialsOnce(account)).finally(() => { protonRefreshPending.delete(account.id); });
    protonRefreshQueue = pending.catch(() => {});
    protonRefreshPending.set(account.id, pending);
    return pending;
  }

  async function refreshProtonCredentialsOnce(account) {
    if (!proton.refreshCommand) return false;
    const password = decryptText(account.password_encrypted);
    if (!password) throw Object.assign(new Error("Proton account chưa lưu password để tự động renew cookie."), { status: 503, refreshRequired: true });
    if (!account.email) throw Object.assign(new Error("Proton account chưa lưu email để tự động renew cookie."), { status: 503, refreshRequired: true });
    const input = JSON.stringify({ id: account.id, email: account.email, uid: account.uid, password, appVersion: account.app_version || proton.appVersion });
    const result = await new Promise((resolve, reject) => {
      const detached = process.platform !== "win32";
      const child = spawn(proton.refreshCommand, proton.refreshArgs, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const stopTree = () => {
        try {
          if (detached) process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {}
        const force = setTimeout(() => {
          try {
            if (detached) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {}
        }, 3000);
        force.unref?.();
      };
      const timer = setTimeout(() => {
        stopTree();
        finish(() => reject(Object.assign(new Error("Helper Proton renew phản hồi quá chậm."), { status: 504 })));
      }, proton.refreshTimeoutMs);
      const append = (target, chunk) => {
        const next = target + chunk.toString();
        if (next.length > PROTON_HELPER_OUTPUT_MAX) {
          stopTree();
          finish(() => reject(Object.assign(new Error("Helper Proton renew trả dữ liệu quá lớn."), { status: 503 })));
          return target;
        }
        return next;
      };
      child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
      child.once("error", (error) => { finish(() => reject(Object.assign(new Error(`Không chạy được helper Proton renew: ${error.message}`), { status: 503 }))); });
      child.once("close", (code) => {
        finish(() => {
          if (code !== 0) return reject(Object.assign(new Error(`Helper Proton renew thất bại${stderr.trim() ? `: ${stderr.trim().slice(0, 160)}` : "."}`), { status: 503 }));
           try {
             const lines = stdout.trim().split(/\r?\n/).reverse();
             const parsed = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((value) => value && typeof value === "object" && !Array.isArray(value));
             if (!parsed) throw new Error("invalid-json");
             resolve(parsed);
           } catch { reject(Object.assign(new Error("Helper Proton renew trả JSON không hợp lệ."), { status: 503 })); }
        });
      });
      child.stdin.once("error", (error) => { finish(() => reject(Object.assign(new Error(`Không gửi được dữ liệu cho helper Proton renew: ${error.message}`), { status: 503 }))); });
      child.stdin.end(input);
    });
    const cookie = text(result?.cookie, 1, 20000, "Cookie Proton mới");
    const uid = result?.uid === undefined ? account.uid : text(result.uid, 1, 200, "UID Proton mới");
    const cookieUid = String(cookie.match(/(?:^|;\s*)AUTH-([^=;]+)=/)?.[1] || "");
    if (!cookieUid || cookieUid !== uid) throw Object.assign(new Error("Helper Proton renew trả cookie và UID không khớp."), { status: 503 });
    const appVersion = result?.appVersion === undefined ? account.app_version : text(result.appVersion, 0, 80, "App version mới");
    const encrypted = encryptText(cookie);
    if (!encrypted) throw Object.assign(new Error("Không thể mã hóa cookie Proton mới."), { status: 503 });
    const timestamp = nowIso(clock);
    db.prepare("UPDATE proton_accounts SET cookie_encrypted=?,uid=?,app_version=?,updated_at=? WHERE id=?").run(encrypted, uid, appVersion, timestamp, account.id);
    account.cookie_encrypted = encrypted;
    account.uid = uid;
    account.app_version = appVersion;
    protonAudit("proton_credentials_refreshed", account.id, uid, "helper");
    return true;
  }

  async function protonJson(response) {
    if (response.status === 204) return null;
    const raw = await response.text();
    if (!raw.trim()) {
      if (response.ok) return null;
      throw Object.assign(new Error("Proton VPN từ chối yêu cầu."), { status: 502, upstreamStatus: response.status });
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { throw Object.assign(new Error("Proton VPN trả dữ liệu không hợp lệ."), { status: 502 }); }
    if (!response.ok) {
      const message = String(body?.Error || body?.error || body?.ErrorDescription || body?.message || "Proton VPN từ chối yêu cầu.").slice(0, 200);
      throw Object.assign(new Error(message), { status: response.status === 422 ? 422 : 502, upstreamStatus: response.status });
    }
    return body;
  }

  function protonSessionUid(item) { return String(item?.UID || item?.uid || item?.sessionUid || item?.session_uid || item?.id || "").trim(); }
  function protonDeviceName(item) { return String(item?.LocalizedClientName || item?.ClientID || "").trim(); }
  function protonSessionIsVpn(item) {
    const clientName = protonDeviceName(item).toLowerCase();
    if (!clientName) return false;
    return !["web", "settings", "browser", "mail"].some((excluded) => clientName.includes(excluded));
  }
  function protonSessionList(body) {
    const list = body?.Sessions ?? body?.sessions ?? body?.data?.Sessions ?? body?.data?.sessions ?? (Array.isArray(body?.data) ? body.data : undefined) ?? body?.items ?? (Array.isArray(body) ? body : undefined) ?? [];
    if (!Array.isArray(list)) throw Object.assign(new Error("Proton VPN trả danh sách session không hợp lệ."), { status: 502 });
    return list.filter((item) => item && typeof item === "object" && protonSessionUid(item) && protonSessionIsVpn(item));
  }
  function safeProtonAccount(row) {
    return { id: row.id, name: row.name, email: row.email, uid: uidHint(row.uid), appVersion: row.app_version, createdAt: row.created_at, updatedAt: row.updated_at, hasPassword: Boolean(row.password_encrypted), hasCookie: Boolean(row.cookie_encrypted) };
  }
  function safeProtonRental(row) {
    return { sessionUid: row.session_uid, accountId: row.account_id, customer: row.customer, phone: row.phone, note: row.note, expiresAt: row.expires_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  function protonExpiry(value) { return value ? parseIsoDate(value) : null; }
  function protonStatus(session, rental, currentUid, timestamp) {
    const uid = protonSessionUid(session);
    if (uid === currentUid) return "manager";
    const expiry = protonExpiry(rental?.expires_at);
    if (expiry && expiry.getTime() <= timestamp) return "expired";
    if (!rental) return "unassigned";
    if (!rental.customer || !rental.expires_at) return "invalid";
    return "active";
  }
  function protonCreatedAt(item) {
    const raw = item?.CreateTime ?? item?.createdAt ?? item?.created_at;
    if (raw === null || raw === undefined || raw === "") return "";
    if (Number.isFinite(Number(raw))) {
      const numeric = Number(raw);
      const date = new Date(numeric < 100000000000 ? numeric * 1000 : numeric);
      return Number.isNaN(date.getTime()) ? "" : date.toISOString();
    }
    const date = parseIsoDate(raw);
    return date ? date.toISOString() : "";
  }
  function protonTimeLeft(status, expiresAt, timestamp) {
    if (status === "manager") return "Không giới hạn";
    if (status === "unassigned") return "Chưa gán";
    if (status === "invalid") return "Ngày không hợp lệ";
    if (status === "expired") return "Đã hết hạn";
    const expiry = protonExpiry(expiresAt);
    if (!expiry) return "Ngày không hợp lệ";
    let seconds = Math.max(0, Math.floor((expiry.getTime() - timestamp) / 1000));
    const days = Math.floor(seconds / 86400); seconds %= 86400;
    const hours = Math.floor(seconds / 3600); seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    return `${days} ngày ${String(hours).padStart(2, "0")} giờ ${String(minutes).padStart(2, "0")} phút`;
  }
  function durationExpiry(body, timestamp) {
    if (body.expiresAt !== undefined) {
      const date = parseIsoDate(body.expiresAt);
      if (!date) throw Object.assign(new Error("expiresAt không hợp lệ."), { status: 400 });
      return date.toISOString();
    }
    const amount = positiveInt(body.duration, 1, 36500, "Duration");
    const unit = text(body.unit || "days", 1, 10, "Unit").toLowerCase();
    const multiplier = unit === "hour" || unit === "hours" ? 3600000 : unit === "day" || unit === "days" ? 86400000 : 0;
    if (!multiplier) throw Object.assign(new Error("Unit chỉ hỗ trợ hours hoặc days."), { status: 400 });
    return new Date(timestamp + amount * multiplier).toISOString();
  }

  function requireGpm() {
    if (!gpm.configured) throw Object.assign(new Error(gpm.reason), { status: 503 });
  }

  async function gpmFetch(gpmPath, method, payload, headers = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), gpm.timeoutMs);
    try {
      return await fetchImpl(`${gpm.baseUrl}${gpmPath}`, {
        method,
        headers: {
          accept: "application/json",
          origin: GPM_ORIGIN,
          referer: `${GPM_ORIGIN}/`,
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "manual",
        signal: controller.signal,
      });
    } finally { clearTimeout(timer); }
  }

  function gpmReadCookie(response) {
    const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const item of cookies) {
      const pair = String(item).split(";", 1)[0];
      if (pair.startsWith(`${GPM_REFRESH_COOKIE}=`)) return pair;
    }
    return "";
  }

  // Access token của GPM sống 15 phút, refresh cookie sống 7 ngày. Ưu tiên
  // GET /auth/refresh (rẻ hơn, giữ nguyên phiên); chỉ đăng nhập lại bằng
  // email/password khi refresh cookie cũng đã hết hạn.
  async function gpmLogin() {
    const response = await gpmFetch("/auth/login", "POST", { email: gpm.email, password: gpm.password });
    if (!response.ok) throw Object.assign(new Error("GPM từ chối đăng nhập: sai email hoặc mật khẩu."), { status: 502 });
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error("GPM trả dữ liệu đăng nhập không hợp lệ."), { status: 502 }); }
    const accessToken = result?.data?.accessToken;
    if (!accessToken) throw Object.assign(new Error("GPM không trả access token."), { status: 502 });
    gpmAuth.accessToken = accessToken;
    gpmAuth.refreshCookie = gpmReadCookie(response) || gpmAuth.refreshCookie;
    gpmAuth.user = result.data.user || null;
    gpmAuth.renewedAt = clock();
    return accessToken;
  }

  async function gpmRefresh() {
    if (!gpmAuth.refreshCookie) return gpmLogin();
    const response = await gpmFetch("/auth/refresh", "GET", undefined, { cookie: gpmAuth.refreshCookie });
    if (response.status === 401 || response.status === 403) return gpmLogin();
    if (!response.ok) throw Object.assign(new Error("GPM không thể refresh phiên."), { status: 502 });
    let result;
    try { result = await response.json(); } catch { throw Object.assign(new Error("GPM trả dữ liệu refresh không hợp lệ."), { status: 502 }); }
    const accessToken = result?.data?.accessToken;
    if (!accessToken) throw Object.assign(new Error("GPM không trả access token khi refresh."), { status: 502 });
    gpmAuth.accessToken = accessToken;
    gpmAuth.refreshCookie = gpmReadCookie(response) || gpmAuth.refreshCookie;
    gpmAuth.user = result.data.user || gpmAuth.user;
    gpmAuth.renewedAt = clock();
    return accessToken;
  }

  function gpmAuthorize(renew) {
    if (!gpmAuth.pending) {
      gpmAuth.pending = (renew ? gpmRefresh() : gpmLogin()).finally(() => { gpmAuth.pending = null; });
    }
    return gpmAuth.pending;
  }

  async function gpmRequest(gpmPath, method = "GET", payload) {
    requireGpm();
    try {
      let accessToken = gpmAuth.accessToken || await gpmAuthorize(true);
      let response = await gpmFetch(gpmPath, method, payload, { authorization: `Bearer ${accessToken}` });
      if (response.status === 401 || response.status === 403) {
        if (gpmAuth.accessToken !== accessToken) {
          accessToken = gpmAuth.accessToken;
        } else {
          gpmAuth.accessToken = "";
          accessToken = await gpmAuthorize(true);
        }
        response = await gpmFetch(gpmPath, method, payload, { authorization: `Bearer ${accessToken}` });
      }
      let result;
      try { result = await response.json(); } catch { throw Object.assign(new Error("GPM trả dữ liệu không hợp lệ."), { status: 502 }); }
      if (!response.ok) throw Object.assign(new Error("GPM từ chối yêu cầu."), { status: 502 });
      return result?.data;
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("GPM phản hồi quá chậm."), { status: 504 });
      if (error.status) throw error;
      throw Object.assign(new Error("Không thể kết nối GPM."), { status: 502 });
    }
  }

  function gpmUuid(value) {
    const result = text(value, 36, 36, "Mã license");
    if (!UUID_PATTERN.test(result)) throw Object.assign(new Error("Mã license không hợp lệ."), { status: 400 });
    return result;
  }

  function projectGpmAccount(user) {
    if (!user || typeof user !== "object") return null;
    return {
      fullName: String(user.fullName || "").slice(0, 120),
      email: String(user.email || "").slice(0, 160),
      role: String(user.role?.name || "").slice(0, 60),
      isActive: user.isActive !== false,
      isEmailVerified: Boolean(user.isEmailVerified),
      resetLimitNextTimes: cleanNumber(user.resetLimitNextTimes),
      ownedLicenses: cleanNumber(user._count?.ownedLicenses),
      createdAt: String(user.createdAt || ""),
    };
  }

  function projectGpmLicense(license) {
    if (!license || typeof license !== "object" || !UUID_PATTERN.test(String(license.uuid || ""))) return null;
    return {
      uuid: String(license.uuid || ""),
      licenseMasked: maskKey(license.license),
      product: String(license.product?.name || "").slice(0, 80),
      package: String(license.productPackage?.name || "").slice(0, 120),
      type: String(license.type || "").slice(0, 30),
      status: String(license.status || "").slice(0, 30),
      limitDevices: cleanNumber(license.limitDevices),
      usedDevices: cleanNumber(license.usedDevices),
      expiresAt: String(license.expiresAt || ""),
      lastDevicesResetAt: String(license.lastDevicesResetAt || ""),
      hasSubLicenses: Boolean(license.hasSubLicenses) || Array.isArray(license.subLicenses) && license.subLicenses.length > 0,
    };
  }

  function gpmTerm(subUuid) {
    return db.prepare("SELECT * FROM gpm_sub_license_terms WHERE sub_license_uuid=?").get(subUuid);
  }

  function gpmExchangeAvailability(lastDevicesResetAt) {
    const lastReset = parseIsoDate(lastDevicesResetAt);
    const availableAt = lastReset ? new Date(lastReset.getTime() + GPM_EXCHANGE_COOLDOWN_MS) : null;
    return { canExchange: !availableAt || availableAt.getTime() <= clock(), exchangeAvailableAt: availableAt ? availableAt.toISOString() : null };
  }

  function projectGpmSchedule(row) {
    if (!row) return { name: "", startsAt: null, expiresAt: null, termDays: null, autoExchange: false, lastExchangeAt: null, lastError: null, status: "unscheduled" };
    const expiry = parseIsoDate(row.expires_at);
    let status = "scheduled";
    if (expiry && expiry.getTime() <= clock()) status = "expired";
    else if (expiry && expiry.getTime() - clock() <= gpm.expiringWindowMs) status = "expiring";
    return {
      name: row.display_name || "",
      startsAt: row.starts_at || null,
      expiresAt: row.expires_at || null,
      termDays: row.term_days,
      autoExchange: row.auto_exchange === 1,
      lastExchangeAt: row.last_exchange_at || null,
      lastError: row.last_error || null,
      status,
    };
  }

  function projectGpmDetail(license) {
    const base = projectGpmLicense(license);
    if (!base) throw Object.assign(new Error("GPM trả dữ liệu license không hợp lệ."), { status: 502 });
    if (license.subLicenses !== undefined && !Array.isArray(license.subLicenses)) throw Object.assign(new Error("GPM trả danh sách sub-license không hợp lệ."), { status: 502 });
    const subLicenses = license.subLicenses || [];
    return {
      ...base,
      subLicenses: subLicenses.filter((item) => item && typeof item === "object" && UUID_PATTERN.test(String(item.uuid || ""))).map((item) => ({
        uuid: String(item?.uuid || ""),
        name: projectGpmSchedule(gpmTerm(String(item?.uuid || ""))).name,
        subLicenseMasked: maskKey(item?.subLicense),
        os: String(item?.os || "").slice(0, 40),
        machineName: String(item?.machineName || "").slice(0, 80),
        lastDevicesResetAt: String(item?.lastDevicesResetAt || ""),
        ...gpmExchangeAvailability(item?.lastDevicesResetAt),
        schedule: projectGpmSchedule(gpmTerm(String(item?.uuid || ""))),
      })),
    };
  }

  function requireGpmLicense(data) {
    const projected = projectGpmLicense(data);
    if (!projected) throw Object.assign(new Error("GPM trả dữ liệu license không hợp lệ."), { status: 502 });
    return projected;
  }

  async function gpmLicenseDetail(uuid) {
    return await gpmRequest(`/licenses/${encodeURIComponent(uuid)}`);
  }

  async function requireGpmChild(parentUuid, childUuid, detail = null) {
    const parent = detail || await gpmLicenseDetail(parentUuid);
    const child = (Array.isArray(parent?.subLicenses) ? parent.subLicenses : []).find((item) => String(item?.uuid || "").toLowerCase() === childUuid.toLowerCase());
    if (!child) throw Object.assign(new Error("Sub-license không thuộc license cha."), { status: 404 });
    return { parent, child };
  }

  function upsertGpmTerm(subUuid, licenseUuid, startsAt, expiresAt, termDays, autoExchange, lastError = null, displayName = null) {
    const timestamp = nowIso(clock);
    const current = gpmTerm(subUuid);
    const name = displayName === null ? current?.display_name || "" : displayName;
    db.prepare(`INSERT INTO gpm_sub_license_terms(sub_license_uuid,license_uuid,display_name,starts_at,expires_at,term_days,auto_exchange,last_error,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(sub_license_uuid) DO UPDATE SET license_uuid=excluded.license_uuid,display_name=excluded.display_name,starts_at=excluded.starts_at,expires_at=excluded.expires_at,term_days=excluded.term_days,auto_exchange=excluded.auto_exchange,last_error=excluded.last_error,updated_at=excluded.updated_at`)
      .run(subUuid, licenseUuid, name, startsAt, expiresAt, termDays, autoExchange ? 1 : 0, lastError, timestamp, timestamp);
  }

  async function exchangeGpmChild(parentUuid, childUuid, child, term, resetExpired) {
    const availability = gpmExchangeAvailability(child?.lastDevicesResetAt);
    if (!availability.canExchange) throw Object.assign(new Error(`Sub-license đang trong cooldown đến ${availability.exchangeAvailableAt}.`), { status: 409 });
    await gpmRequest(`/licenses/sub-licenses/${encodeURIComponent(childUuid)}/exchange`, "POST", {});
    const refreshed = await gpmLicenseDetail(parentUuid);
    await requireGpmChild(parentUuid, childUuid, refreshed);
    const timestamp = nowIso(clock);
    if (resetExpired && term && parseIsoDate(term.expires_at)?.getTime() <= clock()) {
      const expiresAt = new Date(clock() + term.term_days * 86400000).toISOString();
      db.prepare("UPDATE gpm_sub_license_terms SET starts_at=?,expires_at=?,last_exchange_at=?,last_error=NULL,updated_at=? WHERE sub_license_uuid=?").run(timestamp, expiresAt, timestamp, timestamp, childUuid);
    } else if (term) {
      db.prepare("UPDATE gpm_sub_license_terms SET last_exchange_at=?,last_error=NULL,updated_at=? WHERE sub_license_uuid=?").run(timestamp, timestamp, childUuid);
    }
    return refreshed;
  }

  function gpmFullKey(data, field) {
    const key = String(data?.[field] || "").trim();
    if (!key) throw Object.assign(new Error("GPM không trả key hợp lệ."), { status: 502 });
    return key;
  }

  // loginAttempts trước đây chỉ bị xóa khi đăng nhập thành công, nên mỗi IP thất
  // bại giữ một entry vĩnh viễn -> memory leak không giới hạn từ request chưa
  // xác thực. Dọn entry hết hạn và chặn trần số entry.
  function pruneLoginAttempts() {
    const cutoff = clock() - LOGIN_WINDOW_MS;
    for (const [key, times] of loginAttempts) {
      const fresh = times.filter((time) => time > cutoff);
      if (fresh.length) loginAttempts.set(key, fresh);
      else loginAttempts.delete(key);
    }
    if (loginAttempts.size > MAX_LOGIN_CLIENTS) {
      for (const key of [...loginAttempts.keys()].slice(0, loginAttempts.size - MAX_LOGIN_CLIENTS)) {
        loginAttempts.delete(key);
      }
    }
  }

  function audit(event, accountId = null, uid = "", detail = "") {
    db.prepare("INSERT INTO audit(event, account_id, uid_hint, detail, created_at) VALUES(?,?,?,?,?)").run(event, accountId, uidHint(uid), String(detail).slice(0, 500), nowIso(clock));
  }
  function protonAudit(event, protonAccountId = null, sessionUid = "", detail = "") {
    db.prepare("INSERT INTO audit(event, proton_account_id, uid_hint, detail, created_at) VALUES(?,?,?,?,?)").run(event, protonAccountId, uidHint(sessionUid), String(detail).slice(0, 500), nowIso(clock));
  }

  async function protonRequest(account, protonPath, method = "GET", payload, options = {}) {
    if (!proton.configured) throw Object.assign(new Error(proton.reason), { status: 503 });
    try {
      let response = await protonFetch(account, protonPath, method, payload);
      const refreshStatuses = options.refreshOn422 === false ? [401, 403] : [401, 403, 422];
      if (refreshStatuses.includes(response.status)) {
        const replacement = proton.defaultCookie;
        const replacementUid = String(replacement.match(/(?:^|;\s*)AUTH-([^=;]+)=/)?.[1] || "");
        if (proton.refreshCommand && account.email && account.password_encrypted) {
          await refreshProtonCredentials(account);
          account = protonAccountRow(account.id);
        } else if (replacement && replacementUid === account.uid && replacement !== decryptText(account.cookie_encrypted)) {
          const encrypted = encryptText(replacement);
          if (!encrypted) throw Object.assign(new Error("Không thể mã hóa credential Proton thay thế."), { status: 503 });
          const timestamp = nowIso(clock);
          db.prepare("UPDATE proton_accounts SET cookie_encrypted=?,updated_at=? WHERE id=?").run(encrypted, timestamp, account.id);
          account = { ...account, cookie_encrypted: encrypted };
        } else if (!(await refreshProtonCredentials(account))) {
          throw Object.assign(new Error("Credential Proton đã hết hạn. Hãy cấu hình helper renew hoặc cập nhật cookie thủ công."), { status: 503, refreshRequired: true });
        }
        account = protonAccountRow(account.id);
        response = await protonFetch(account, protonPath, method, payload);
      }
      return await protonJson(response);
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("Proton VPN phản hồi quá chậm."), { status: 504 });
      if (error.status) throw error;
      throw Object.assign(new Error("Không thể kết nối Proton VPN."), { status: 502 });
    }
  }

  async function listProtonSessions(account) {
    return protonSessionList(await protonRequest(account, "/api/auth/v4/sessions"));
  }

  async function revokeProtonSession(account, sessionUid) {
    if (sessionUid === account.uid) throw Object.assign(new Error("Không được revoke UID quản lý hiện tại."), { status: 409 });
    try {
      await protonRequest(account, `/api/auth/v4/sessions/${encodeURIComponent(sessionUid)}`, "DELETE", undefined, { refreshOn422: false });
    } catch (error) {
      if (![404, 422].includes(error.upstreamStatus)) throw error;
      const stillExists = (await listProtonSessions(account)).some((item) => protonSessionUid(item) === sessionUid);
      if (stillExists) throw error;
    }
  }

  async function cleanupProtonAccount(account, dryRun = false) {
    const sessions = await listProtonSessions(account);
    const timestamp = clock();
    const rentals = new Map(db.prepare("SELECT * FROM proton_rentals WHERE account_id=?").all(account.id).map((row) => [row.session_uid, row]));
    const result = { scanned: sessions.length, eligible: 0, revoked: 0, failed: 0, skippedCurrent: 0 };
    for (const session of sessions) {
      const sessionUid = protonSessionUid(session);
      if (sessionUid === account.uid) { result.skippedCurrent += 1; continue; }
      const rental = rentals.get(sessionUid);
      const expiry = protonExpiry(rental?.expires_at);
      if (!rental || !expiry || expiry.getTime() > timestamp) continue;
      result.eligible += 1;
      if (dryRun) continue;
      try {
        await revokeProtonSession(account, sessionUid);
        db.prepare("DELETE FROM proton_rentals WHERE session_uid=? AND account_id=?").run(sessionUid, account.id);
        result.revoked += 1;
        protonAudit("proton_cleanup_revoke", account.id, sessionUid);
      } catch { result.failed += 1; }
    }
    return result;
  }

  const gpmWorker = { enabled: gpm.configured && gpm.autoExchange, running: false, lastRunAt: null, lastError: null, exchanged: 0, failed: 0 };
  async function runGpmWorker() {
    if (!gpmWorker.enabled || gpmWorker.running) return;
    gpmWorker.running = true;
    gpmWorker.lastError = null;
    try {
      const due = db.prepare("SELECT * FROM gpm_sub_license_terms WHERE auto_exchange=1 AND expires_at IS NOT NULL AND expires_at<=? ORDER BY license_uuid,sub_license_uuid").all(nowIso(clock));
      const parents = new Map();
      for (const term of due) {
        try {
          let detail = parents.get(term.license_uuid);
          if (!detail) { detail = await gpmLicenseDetail(term.license_uuid); parents.set(term.license_uuid, detail); }
          const { child } = await requireGpmChild(term.license_uuid, term.sub_license_uuid, detail);
          const availability = gpmExchangeAvailability(child.lastDevicesResetAt);
          if (!availability.canExchange) {
            const error = `Cooldown đến ${availability.exchangeAvailableAt}`;
            db.prepare("UPDATE gpm_sub_license_terms SET last_error=?,updated_at=? WHERE sub_license_uuid=?").run(error, nowIso(clock), term.sub_license_uuid);
            gpmWorker.failed += 1;
            audit("gpm_auto_exchange_failed", null, "", `license=${term.license_uuid};sub=${term.sub_license_uuid};reason=cooldown`);
            continue;
          }
          await gpmRequest(`/licenses/sub-licenses/${encodeURIComponent(term.sub_license_uuid)}/exchange`, "POST", {});
          const refreshed = await gpmLicenseDetail(term.license_uuid);
          await requireGpmChild(term.license_uuid, term.sub_license_uuid, refreshed);
          parents.set(term.license_uuid, refreshed);
          const startsAt = nowIso(clock);
          const expiresAt = new Date(clock() + term.term_days * 86400000).toISOString();
          db.prepare("UPDATE gpm_sub_license_terms SET starts_at=?,expires_at=?,last_exchange_at=?,last_error=NULL,updated_at=? WHERE sub_license_uuid=?").run(startsAt, expiresAt, startsAt, startsAt, term.sub_license_uuid);
          gpmWorker.exchanged += 1;
          audit("gpm_auto_exchange", null, "", `license=${term.license_uuid};sub=${term.sub_license_uuid}`);
        } catch (error) {
          const safeError = String(error.message || "Auto exchange thất bại.").slice(0, 160);
          db.prepare("UPDATE gpm_sub_license_terms SET last_error=?,updated_at=? WHERE sub_license_uuid=?").run(safeError, nowIso(clock), term.sub_license_uuid);
          gpmWorker.failed += 1;
          audit("gpm_auto_exchange_failed", null, "", `license=${term.license_uuid};sub=${term.sub_license_uuid};reason=upstream`);
        }
      }
      gpmWorker.lastRunAt = nowIso(clock);
    } catch (error) {
      gpmWorker.lastError = String(error.message || "Worker GPM thất bại.").slice(0, 160);
    } finally { gpmWorker.running = false; }
  }
  if (gpmWorker.enabled) {
    const timer = setIntervalImpl(runGpmWorker, gpm.autoExchangeIntervalMs);
    timer.unref();
  }

  const protonWorker = { enabled: proton.autoRevoke, running: false, lastRunAt: null, lastError: null };
  async function runProtonWorker() {
    if (protonWorker.running) return;
    protonWorker.running = true;
    protonWorker.lastError = null;
    try {
      for (const account of db.prepare("SELECT * FROM proton_accounts ORDER BY id").all()) {
        try {
          const result = await cleanupProtonAccount(account, false);
          if (result.failed) protonWorker.lastError = `Account ${account.id} (${account.name}): ${result.failed} session revoke thất bại.`;
        } catch (error) {
          const reason = error.upstreamStatus ? `Proton API lỗi HTTP ${error.upstreamStatus}.` : "Không thể xử lý account.";
          protonWorker.lastError = `Account ${account.id} (${account.name}): ${reason}`;
        }
      }
      protonWorker.lastRunAt = nowIso(clock);
    } catch (error) { protonWorker.lastError = String(error.message || "Worker Proton thất bại.").slice(0, 160); }
    finally { protonWorker.running = false; }
  }
  if (proton.autoRevoke) {
    const timer = setIntervalImpl(runProtonWorker, proton.autoRevokeIntervalMs);
    if (typeof timer?.unref === "function") timer.unref();
  }
  function accountProjection(row) {
    return {
      status: row.archived_at ? "archived" : row.status,
      uid: row.uid,
      keyHint: row.key_hint,
      plan: row.plan,
      activatedAt: row.activated_at,
      expiresAt: row.expires_at,
      lastSeenAt: row.last_seen_at,
    };
  }
  function findByToken(token) {
    if (!token) return null;
    return db.prepare(`SELECT s.*, a.plan, a.status, a.activated_at, a.expires_at, a.archived_at, k.key_hint, d.uid, d.last_seen_at
      FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN account_keys k ON k.account_id=a.id JOIN devices d ON d.id=s.device_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.generation=a.generation AND d.released_at IS NULL`).get(sha256(token));
  }
  function findAnyByToken(token) {
    if (!token) return null;
    return db.prepare(`SELECT s.*, a.status, a.expires_at, a.archived_at, d.uid
      FROM sessions s JOIN accounts a ON a.id=s.account_id JOIN devices d ON d.id=s.device_id
      WHERE s.token_hash=? AND d.released_at IS NULL`).get(sha256(token));
  }
  function bearer(req) {
    const match = String(req.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]{30,200})$/);
    return match?.[1] || "";
  }
  function adminSession(req) {
    const token = parseCookies(req.headers.cookie).zpm_admin;
    if (!token) return null;
    return db.prepare("SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at>?").get(sha256(token), nowIso(clock));
  }
  function requireAdmin(req) {
    const session = adminSession(req);
    if (!session) throw Object.assign(new Error("Cần đăng nhập."), { status: 401 });
    return session;
  }
  function requireCsrf(req, session, body) {
    const token = req.headers["x-csrf-token"] || body.csrf;
    if (!token) throw Object.assign(new Error("CSRF token không hợp lệ."), { status: 403 });
    const expected = Buffer.from(issueCsrf(session));
    const actual = Buffer.from(String(token));
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      throw Object.assign(new Error("CSRF token không hợp lệ."), { status: 403 });
    }
  }
  function secureRequest(req, url) {
    if (!production || url.pathname === "/health") return true;
    const trustedForwarder = trustProxy && (isLoopback(req.socket.remoteAddress) || isGateway(req.socket.remoteAddress, dockerGateway));
    return req.socket.encrypted || trustedForwarder && String(req.headers["x-forwarded-proto"]).toLowerCase() === "https";
  }
  function revokeSessions(accountId) {
    db.prepare("UPDATE sessions SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL").run(nowIso(clock), accountId);
  }
  function releaseBinding(accountId, timestamp) {
    db.prepare("UPDATE devices SET released_at=? WHERE account_id=? AND released_at IS NULL").run(timestamp, accountId);
  }
  function archiveAccount(accountId, timestamp) {
    revokeSessions(accountId);
    db.prepare("UPDATE commands SET acked_at=COALESCE(acked_at,?) WHERE account_id=?").run(timestamp, accountId);
    releaseBinding(accountId, timestamp);
    db.prepare("UPDATE accounts SET archived_at=?,status='locked',enabled=0,generation=generation+1,updated_at=? WHERE id=? AND archived_at IS NULL").run(timestamp, timestamp, accountId);
  }
  function queueCommand(accountId, type, generation) {
    const pending = db.prepare("SELECT id FROM commands WHERE account_id=? AND generation=? AND type=? AND acked_at IS NULL").get(accountId, generation, type);
    if (!pending) db.prepare("INSERT INTO commands(account_id,type,created_at,generation) VALUES(?,?,?,?)").run(accountId, type, nowIso(clock), generation);
  }

  async function activate(req, res) {
    const body = await readBody(req);
    const key = text(body.key, 20, 100, "Key");
    const uid = text(body.uid, 64, 64, "UID").toLowerCase();
    if (!UID_PATTERN.test(uid)) throw Object.assign(new Error("UID không hợp lệ."), { status: 400 });
    let row = db.prepare(`SELECT a.*, k.key_hint, d.id device_id, d.uid FROM account_keys k JOIN accounts a ON a.id=k.account_id LEFT JOIN devices d ON d.account_id=a.id AND d.released_at IS NULL WHERE k.key_hash=?`).get(sha256(key));
    if (!row || row.archived_at || row.status !== "active" || row.expires_at <= nowIso(clock)) {
      audit("activation_denied", row?.id || null, uid, "invalid_status_or_expiry");
      return json(res, 403, { error: STATUS_ERROR });
    }
    if (row.uid && row.uid !== uid) {
      audit("activation_wrong_device", row.id, uid, "binding_preserved");
      return json(res, 403, { error: STATUS_ERROR });
    }
    const timestamp = nowIso(clock);
    db.exec("BEGIN IMMEDIATE");
    try {
      row = db.prepare(`SELECT a.*, k.key_hint, d.id device_id, d.uid FROM account_keys k JOIN accounts a ON a.id=k.account_id LEFT JOIN devices d ON d.account_id=a.id AND d.released_at IS NULL WHERE a.id=?`).get(row.id);
      if (row.archived_at || row.status !== "active" || row.expires_at <= timestamp || row.uid && row.uid !== uid) {
        db.exec("ROLLBACK");
        audit(row.uid && row.uid !== uid ? "activation_wrong_device" : "activation_denied", row.id, uid, "transaction_recheck_failed");
        return json(res, 403, { error: STATUS_ERROR });
      }
      let deviceId = row.device_id;
      if (!deviceId) {
        const existingDevice = db.prepare("SELECT id, account_id FROM devices WHERE uid=? AND released_at IS NULL").get(uid);
        if (existingDevice && existingDevice.account_id !== row.id) {
          archiveAccount(existingDevice.account_id, timestamp);
        }
        const result = db.prepare("INSERT INTO devices(account_id,uid,last_seen_at,created_at) VALUES(?,?,?,?)").run(row.id, uid, timestamp, timestamp);
        deviceId = Number(result.lastInsertRowid);
        db.prepare("UPDATE accounts SET activated_at=COALESCE(activated_at,?), updated_at=? WHERE id=?").run(timestamp, timestamp, row.id);
      }
      revokeSessions(row.id);
      const generation = Number(row.generation) + 1;
      db.prepare("UPDATE accounts SET generation=?,updated_at=? WHERE id=?").run(generation, timestamp, row.id);
      const token = randomToken(32);
      db.prepare("INSERT INTO sessions(account_id,device_id,token_hash,created_at,last_seen_at,generation) VALUES(?,?,?,?,?,?)").run(row.id, deviceId, sha256(token), timestamp, timestamp, generation);
      db.exec("COMMIT");
      audit("activation_succeeded", row.id, uid);
      const account = db.prepare(`SELECT a.*, k.key_hint, d.uid, d.last_seen_at FROM accounts a JOIN account_keys k ON k.account_id=a.id JOIN devices d ON d.account_id=a.id AND d.released_at IS NULL WHERE a.id=?`).get(row.id);
      return json(res, 200, { token, generation, leaseSeconds: 30, graceSeconds: 300, account: accountProjection(account) });
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function heartbeat(req, res) {
    const session = findByToken(bearer(req));
    if (!session) return json(res, 401, { error: "Phiên không hợp lệ." });
    const body = await readBody(req);
    const sequence = positiveInt(body.sequence, 1, Number.MAX_SAFE_INTEGER, "Sequence");
    if (sequence <= session.last_sequence) return json(res, 409, { error: "Heartbeat đã được xử lý." });
    const timestamp = nowIso(clock);
    const expired = session.expires_at <= timestamp;
    db.exec("BEGIN IMMEDIATE");
    let command;
    try {
      const updated = db.prepare("UPDATE sessions SET last_sequence=?, last_seen_at=? WHERE id=? AND revoked_at IS NULL AND last_sequence<?").run(sequence, timestamp, session.id, sequence);
      if (Number(updated.changes) !== 1) {
        db.exec("ROLLBACK");
        return json(res, 409, { error: "Heartbeat đã được xử lý." });
      }
      db.prepare("UPDATE devices SET last_seen_at=? WHERE id=?").run(timestamp, session.device_id);
      command = db.prepare("SELECT * FROM commands WHERE account_id=? AND generation=? AND acked_at IS NULL ORDER BY id LIMIT 1").get(session.account_id, session.generation);
      if (command) db.prepare("UPDATE commands SET delivered_at=COALESCE(delivered_at,?) WHERE id=?").run(timestamp, command.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const blocked = Boolean(session.archived_at) || session.status !== "active" || expired || Boolean(command);
    return json(res, 200, {
      leaseSeconds: 30,
      graceSeconds: 300,
      generation: session.generation,
      command: command ? { id: command.id, type: command.type, generation: command.generation } : null,
      blocked,
      account: { ...accountProjection({ ...session, last_seen_at: timestamp }), status: expired ? "expired" : session.status },
    });
  }

  async function acknowledgeCommand(req, res) {
    const session = findAnyByToken(bearer(req));
    if (!session) return json(res, 401, { error: "Phiên không hợp lệ." });
    const body = await readBody(req);
    const commandId = positiveInt(body.commandId, 1, Number.MAX_SAFE_INTEGER, "Command");
    const generation = positiveInt(body.generation, 1, Number.MAX_SAFE_INTEGER, "Generation");
    const timestamp = nowIso(clock);
    db.exec("BEGIN IMMEDIATE");
    try {
      const command = db.prepare("SELECT * FROM commands WHERE id=? AND account_id=? AND generation=?").get(commandId, session.account_id, generation);
      if (!command || generation !== session.generation) {
        db.exec("ROLLBACK");
        return json(res, 409, { error: "Command không thuộc phiên hiện tại." });
      }
      db.prepare("UPDATE commands SET delivered_at=COALESCE(delivered_at,?),acked_at=COALESCE(acked_at,?) WHERE id=?").run(timestamp, timestamp, command.id);
      db.prepare("UPDATE sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(timestamp, session.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    audit("command_acknowledged", session.account_id, session.uid, `${commandId}:${generation}`);
    return json(res, 200, { ok: true });
  }

  async function agentLogout(req, res) {
    const session = findByToken(bearer(req));
    if (session) {
      db.prepare("UPDATE sessions SET revoked_at=? WHERE id=?").run(nowIso(clock), session.id);
      audit("agent_logout", session.account_id, session.uid);
    }
    return json(res, 200, { ok: true });
  }

  // CSRF token được dẫn xuất tất định từ token_hash của session + secret của
  // server, nên nó ổn định suốt phiên mà không cần lưu thêm gì. Trước đây mỗi lần
  // GET /admin lại ghi đè csrf_hash, nên mở tab thứ hai (hoặc refresh) là mọi form
  // đang mở ở tab cũ bị 403.
  function issueCsrf(session) {
    return crypto.createHmac("sha256", `zpm-csrf:${adminPasswordHash}`).update(String(session.token_hash)).digest("base64url").slice(0, 32);
  }

  function renderAdmin(req, res, session, message = "", copyKey = "") {
    const csrf = issueCsrf(session);
    const accounts = db.prepare(`SELECT a.*, k.key_hint, k.key_hash, d.uid, d.last_seen_at,
      (SELECT COUNT(*) FROM commands c WHERE c.account_id=a.id AND c.acked_at IS NULL) pending_commands
      FROM accounts a JOIN account_keys k ON k.account_id=a.id
      LEFT JOIN devices d ON d.account_id=a.id AND d.released_at IS NULL
      WHERE a.archived_at IS NULL ORDER BY a.id DESC`).all();
    const archivedAccounts = db.prepare(`SELECT a.*, k.key_hint, d.uid, d.released_at
      FROM accounts a JOIN account_keys k ON k.account_id=a.id
      LEFT JOIN devices d ON d.account_id=a.id AND d.id=(SELECT MAX(id) FROM devices WHERE account_id=a.id)
      WHERE a.archived_at IS NOT NULL ORDER BY a.id DESC`).all();
    const audits = db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT 60").all();
    
    const nowTime = clock();
    const expiryMs = (value) => { const d = parseIsoDate(value); return d ? d.getTime() : Number.POSITIVE_INFINITY; };
    const onlineCount = accounts.filter((item) => {
      const d = parseIsoDate(item.last_seen_at);
      return d && (nowTime - d.getTime() < 90000);
    }).length;
    const depletedCount = accounts.filter((item) => expiryMs(item.expires_at) <= nowTime).length;
    const depletingCount = accounts.filter((item) => {
      const exp = expiryMs(item.expires_at);
      return exp > nowTime && (exp - nowTime < 7 * 86400000);
    }).length;
    const disabledCount = accounts.filter((item) => item.status === "locked" || item.enabled === 0).length;
    const activeStatusCount = accounts.filter((item) => item.status === "active" && item.enabled !== 0 && expiryMs(item.expires_at) > nowTime).length;

    const rows = accounts.map((item) => {
      const parsedLastSeen = parseIsoDate(item.last_seen_at);
      const isOnline = Boolean(parsedLastSeen && (nowTime - parsedLastSeen.getTime() < 90000));
      const isEnabled = item.status === "active" && item.enabled !== 0;
      const displayName = item.name || item.note || `May${item.id}`;
      const search = escapeHtml(`#${item.id} ${displayName} ${item.key_hint} ${item.plan} ${item.note} ${item.uid || ""}`.toLocaleLowerCase("vi"));
      const expiry = item.expires_at.slice(0, 10);
      const lastSeenFormatted = formatVietnamDateTime(item.last_seen_at);
      const detailedExpiry = formatDetailedRemainingTime(item.expires_at, clock);
      const isExpired = expiryMs(item.expires_at) <= nowTime;

      return `<tr data-search="${search}" data-key-hash="${escapeHtml(item.key_hash)}" data-created="${escapeHtml(item.created_at)}" data-expires="${escapeHtml(item.expires_at)}" data-status="${escapeHtml(item.status)}" data-online="${isOnline ? "true" : "false"}" data-bound="${item.uid ? "true" : "false"}">
        <td><input type="checkbox" class="row-checkbox" value="${item.id}"></td>
        <td>
          <div class="action-buttons">
            <button type="button" class="btn-action-icon" data-action="copy" data-id="${item.id}" data-hint="${escapeHtml(item.key_hint)}" title="Copy key đầy đủ">📋</button>
            <form class="inline-action-form" method="post" action="/admin/accounts/${item.id}/action">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="action" value="reset_binding">
              <button class="btn-action-icon" type="submit" title="Reset binding">🔄</button>
            </form>
            <button type="button" class="btn-action-icon" data-action="edit" data-id="${item.id}" data-name="${escapeHtml(displayName)}" data-plan="${escapeHtml(item.plan)}" data-note="${escapeHtml(item.note)}" data-expiry="${escapeHtml(expiry)}" title="Chỉnh sửa">✏️</button>
            <form class="inline-action-form" method="post" action="/admin/accounts/${item.id}/action">
              <input type="hidden" name="csrf" value="${csrf}">
              <input type="hidden" name="action" value="archive">
              <button class="btn-action-icon danger" type="submit" title="Lưu trữ">🗑️</button>
            </form>
          </div>
        </td>
        <td>
          <label class="toggle-switch">
            <input type="checkbox" class="toggle-switch-input" data-id="${item.id}" ${isEnabled ? "checked" : ""}>
            <span class="toggle-switch-slider"></span>
          </label>
        </td>
        <td>
          <span class="status-pill ${isOnline ? "online" : "offline"}">${isOnline ? "🟢 Trực tuyến" : "⚪ Ngoại tuyến"}</span>
        </td>
        <td>
          <div class="customer-info">
            <strong>${escapeHtml(displayName)}</strong>
            <small class="customer-note" title="${escapeHtml(item.uid || "Chưa bind UID")}">${escapeHtml(item.note || "Không có ghi chú")}</small>
            <small class="key-hint">${escapeHtml(item.key_hint)}</small>
          </div>
        </td>
        <td>
          <form class="row-control-form" method="post" action="/admin/accounts/${item.id}/action">
            <input type="hidden" name="csrf" value="${csrf}">
            <select name="action" aria-label="Điều khiển account ${item.id}">
              <option value="extend">Gia hạn 30 ngày</option>
              <option value="lock">Khóa account</option>
              <option value="unlock">Mở khóa</option>
              <option value="force_logout">Force logout</option>
              <option value="reset_binding">Reset binding</option>
            </select>
            <button class="row-control-button" type="submit" title="Gửi lệnh">Gửi</button>
          </form>
        </td>
        <td><span class="last-seen-text">${escapeHtml(lastSeenFormatted)}</span></td>
        <td><span class="expiry-pill ${isExpired ? "expired" : ""}">${escapeHtml(detailedExpiry)}</span></td>
      </tr>`;
    }).join("");

    const archivedRows = archivedAccounts.map((item) => `<tr data-search="${escapeHtml(`#${item.id} ${item.name || item.note || ""} ${item.key_hint} ${item.plan} ${item.uid || ""}`.toLocaleLowerCase("vi"))}"><td><div class="account-identity"><span class="account-avatar">${item.id}</span><div><strong>${escapeHtml(item.name || `Account #${item.id}`)}</strong><small class="key-hint">${escapeHtml(item.key_hint)}</small></div></div></td><td><strong>${escapeHtml(item.plan)}</strong><small>${escapeHtml(item.uid ? `UID lịch sử: ${uidHint(item.uid)}` : item.note || "Không có binding")}</small></td><td>${escapeHtml(item.archived_at.replace("T", " ").slice(0, 19))}</td><td><span class="status-pill offline">Tombstone vĩnh viễn</span></td></tr>`).join("");
    const auditRows = audits.map((item) => `<tr data-search="${escapeHtml(`${item.created_at} ${item.event} ${item.account_id || ""} ${item.uid_hint || ""} ${item.detail}`.toLocaleLowerCase("vi"))}"><td>${escapeHtml(item.created_at.replace("T", " ").slice(0, 19))}</td><td><span class="audit-code">${escapeHtml(item.event)}</span></td><td>${escapeHtml(item.account_id || "-")}</td><td class="uid-hint">${escapeHtml(item.uid_hint || "-")}</td><td title="${escapeHtml(item.detail)}">${escapeHtml(item.detail || "-")}</td></tr>`).join("");
    const copyAction = copyKey ? `<button class="copy-key" type="button" data-copy-key="${escapeHtml(copyKey)}">Copy key</button>` : "";
    const replacements = {
      "{{CSRF}}": csrf,
      "{{ROWS}}": rows || '<tr class="empty-row"><td colspan="9"><strong>Chưa có account</strong><span>Tạo key đầu tiên để bắt đầu.</span></td></tr>',
      "{{ARCHIVED_ROWS}}": archivedRows || '<tr class="empty-row"><td colspan="4"><strong>Chưa có key lưu trữ</strong><span>Account được archive sẽ xuất hiện tại đây.</span></td></tr>',
      "{{AUDIT_ROWS}}": auditRows || '<tr class="empty-row"><td colspan="5"><strong>Chưa có audit</strong><span>Sự kiện hệ thống sẽ xuất hiện tại đây.</span></td></tr>',
      "{{MESSAGE}}": escapeHtml(message),
      "{{MESSAGE_TEXT}}": escapeHtml(message),
      "{{MESSAGE_ACTION}}": copyAction,
      "{{TOTAL_COUNT}}": String(accounts.length),
      "{{ONLINE_COUNT}}": String(onlineCount),
      "{{DEPLETED_COUNT}}": String(depletedCount),
      "{{DEPLETING_COUNT}}": String(depletingCount),
      "{{DISABLED_COUNT}}": String(disabledCount),
      "{{ACTIVE_STATUS_COUNT}}": String(activeStatusCount),
      "{{ARCHIVED_COUNT}}": String(archivedAccounts.length),
    };
    const html = adminHtml.replace(/\{\{[A-Z_]+\}\}/g, (placeholder) => replacements[placeholder] ?? placeholder);
    const data = Buffer.from(html);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": data.length, "cache-control": "no-store", "content-security-policy": "default-src 'self'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", "x-content-type-options": "nosniff" });
    res.end(data);
  }

  return async function handler(req, res) {
    const url = new URL(req.url, "http://localhost");
    try {
      if (!secureRequest(req, url)) return json(res, 426, { error: "HTTPS bắt buộc." });
      if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
      if (req.method === "POST" && url.pathname === "/api/v1/activate") return await activate(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/heartbeat") return await heartbeat(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/commands/ack") return await acknowledgeCommand(req, res);
      if (req.method === "POST" && url.pathname === "/api/v1/logout") return await agentLogout(req, res);
      if (req.method === "GET" && url.pathname === "/admin.css") {
        const data = Buffer.from(adminCss); res.writeHead(200, { "content-type": "text/css; charset=utf-8", "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" }); return res.end(data);
      }
      if (req.method === "GET" && url.pathname === "/admin.js") {
        const data = Buffer.from(adminJs); res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "content-length": data.length, "cache-control": "no-store", "x-content-type-options": "nosniff" }); return res.end(data);
      }
      if (req.method === "GET" && url.pathname === "/admin/login") {
        const data = Buffer.from(`<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><link rel="stylesheet" href="/admin.css"><title>Đăng nhập Zpool Account Manager</title></head><body class="login"><form class="login-card" method="post"><div class="login-brand"><span class="brand-mark">Z</span><div><strong>Zpool Account Manager</strong><small>Server console</small></div></div><p class="eyebrow">SECURE ADMIN ACCESS</p><h1>Đăng nhập quản trị</h1><p>Nhập mật khẩu quản trị để truy cập account server.</p><label><span>Mật khẩu</span><input name="password" type="password" minlength="12" required autofocus autocomplete="current-password"></label><button class="primary-button" type="submit">Đăng nhập</button></form></body></html>`); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": data.length, "cache-control": "no-store" }); return res.end(data);
      }
      if (req.method === "POST" && url.pathname === "/admin/login") {
        const body = await readBody(req);
        const forwarded = trustProxy && (isLoopback(req.socket.remoteAddress) || isGateway(req.socket.remoteAddress, dockerGateway))
          ? String(req.headers["x-forwarded-for"] || "").split(",", 1)[0].trim()
          : "";
        const client = forwarded || req.socket.remoteAddress || "unknown";
        pruneLoginAttempts();
        const recent = (loginAttempts.get(client) || []).filter((time) => clock() - time < LOGIN_WINDOW_MS);
        if (recent.length >= 5) throw Object.assign(new Error("Thử đăng nhập quá nhiều. Vui lòng thử lại sau."), { status: 429 });
        if (!await verifyPassword(body.password, adminPasswordHash)) { recent.push(clock()); loginAttempts.set(client, recent); audit("admin_login_failed"); throw Object.assign(new Error("Sai thông tin đăng nhập."), { status: 401 }); }
        loginAttempts.delete(client);
        const token = randomToken(32); const created = nowIso(clock); const expires = new Date(clock() + 8 * 3600000).toISOString();
        db.prepare("DELETE FROM admin_sessions WHERE expires_at<=?").run(created);
        // csrf_hash giữ lại cho tương thích schema; token thật được dẫn xuất từ
        // token_hash trong issueCsrf() nên không cần lưu.
        db.prepare("INSERT INTO admin_sessions(token_hash,csrf_hash,expires_at,created_at) VALUES(?,?,?,?)").run(sha256(token), sha256(randomToken(24)), expires, created);
        return redirect(res, "/admin", { "set-cookie": `zpm_admin=${token}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=28800${production ? "; Secure" : ""}` });
      }
      if (req.method === "POST" && url.pathname === "/admin/logout") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); db.prepare("DELETE FROM admin_sessions WHERE id=?").run(session.id);
        return redirect(res, "/admin/login", { "set-cookie": "zpm_admin=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0" });
      }
      if (req.method === "GET" && url.pathname === "/admin") {
        const session = adminSession(req); if (!session) return redirect(res, "/admin/login"); return renderAdmin(req, res, session, url.searchParams.get("message") || "");
      }
      if (req.method === "GET" && url.pathname === "/admin/vless") {
        requireAdmin(req);
        if (!xui.configured) return json(res, 200, { configured: false, reason: xui.reason, inbounds: [] });
        return json(res, 200, { configured: true, inbounds: await listVless() });
      }
      if (url.pathname === "/admin/gpm/account" && req.method === "GET") {
        requireAdmin(req);
        if (!gpm.configured) return json(res, 200, { configured: false, reason: gpm.reason, account: null });
        return json(res, 200, { configured: true, account: projectGpmAccount(await gpmRequest("/auth/me")), worker: { ...gpmWorker } });
      }
      if (url.pathname === "/admin/gpm/worker" && req.method === "GET") {
        requireAdmin(req);
        return json(res, 200, { worker: { ...gpmWorker } });
      }
      if (url.pathname === "/admin/gpm/licenses" && req.method === "GET") {
        requireAdmin(req);
        if (!gpm.configured) return json(res, 200, { configured: false, reason: gpm.reason, licenses: [], worker: { ...gpmWorker } });
        const data = await gpmRequest("/licenses");
        const list = Array.isArray(data) ? data : data?.data || data?.licenses || data?.items;
        if (!Array.isArray(list)) throw Object.assign(new Error("GPM trả danh sách license không hợp lệ."), { status: 502 });
        return json(res, 200, { configured: true, licenses: list.map(projectGpmLicense).filter(Boolean), worker: { ...gpmWorker } });
      }
      const gpmLicenseMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)$/i);
      if (gpmLicenseMatch && req.method === "GET") {
        requireAdmin(req); const uuid = gpmUuid(gpmLicenseMatch[1]);
        return json(res, 200, { license: projectGpmDetail(await gpmLicenseDetail(uuid)) });
      }
      const gpmResetMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/reset-devices$/i);
      if (gpmResetMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const uuid = gpmUuid(gpmResetMatch[1]);
        const note = text(body.note || "", 0, 300, "Note");
        await gpmRequest(`/licenses/${uuid}/reset-devices`, "POST", note ? { note } : {});
        audit("admin_gpm_reset_devices", null, "", `license=${uuid};note=${note ? "provided" : "empty"}`);
        return json(res, 200, { ok: true });
      }
      const gpmSubMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses$/i);
      if (gpmSubMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const uuid = gpmUuid(gpmSubMatch[1]); const quantity = positiveInt(body.quantity, 1, 1000, "Quantity");
        const termDays = body.termDays === undefined ? null : positiveInt(body.termDays, 1, 3650, "Term days");
        const result = await gpmRequest(`/licenses/${uuid}/sub-licenses`, "POST", { quantity });
        audit("admin_gpm_create_sub_licenses", null, "", `license=${uuid};quantity=${quantity}`);
        const list = Array.isArray(result) ? result : result?.subLicenses;
        if (!Array.isArray(list)) throw Object.assign(new Error("GPM trả danh sách sub-license không hợp lệ."), { status: 502 });
        if (termDays) {
          const startsAt = nowIso(clock); const expiresAt = new Date(clock() + termDays * 86400000).toISOString();
          for (const item of list) if (UUID_PATTERN.test(String(item?.uuid || ""))) upsertGpmTerm(String(item.uuid), uuid, startsAt, expiresAt, termDays, true);
        }
        return json(res, 201, { subLicenses: list.map((item) => ({ uuid: String(item?.uuid || ""), subLicenseMasked: maskKey(item?.subLicense), os: String(item?.os || "").slice(0, 40), machineName: String(item?.machineName || "").slice(0, 80) })).filter((item) => UUID_PATTERN.test(item.uuid)) });
      }
      const gpmScheduleMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses\/([0-9a-f-]+)\/schedule$/i);
      if (gpmScheduleMatch && req.method === "PUT") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const parentUuid = gpmUuid(gpmScheduleMatch[1]); const childUuid = gpmUuid(gpmScheduleMatch[2]);
        const termDays = positiveInt(body.termDays, 1, 3650, "Term days");
        if (typeof body.autoExchange !== "boolean") throw Object.assign(new Error("Auto exchange không hợp lệ."), { status: 400 });
        const displayName = text(body.name || "", 0, 120, "Tên sub-license");
        const starts = body.startsAt === undefined ? new Date(clock()) : parseIsoDate(body.startsAt);
        if (!starts) throw Object.assign(new Error("startsAt không hợp lệ."), { status: 400 });
        await requireGpmChild(parentUuid, childUuid);
        upsertGpmTerm(childUuid, parentUuid, starts.toISOString(), new Date(starts.getTime() + termDays * 86400000).toISOString(), termDays, body.autoExchange, null, displayName);
        audit("admin_gpm_schedule_sub_license", null, "", `license=${parentUuid};sub=${childUuid};days=${termDays}`);
        return json(res, 200, { license: projectGpmDetail(await gpmLicenseDetail(parentUuid)) });
      }
      const gpmExtendMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses\/([0-9a-f-]+)\/extend$/i);
      if (gpmExtendMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const parentUuid = gpmUuid(gpmExtendMatch[1]); const childUuid = gpmUuid(gpmExtendMatch[2]); const days = positiveInt(body.days, 1, 3650, "Days");
        await requireGpmChild(parentUuid, childUuid);
        const current = gpmTerm(childUuid); const existingExpiry = parseIsoDate(current?.expires_at); const base = Math.max(clock(), existingExpiry?.getTime() || clock()); const startsAt = current?.starts_at || nowIso(clock); const termDays = (current?.term_days || 0) + days;
        upsertGpmTerm(childUuid, parentUuid, startsAt, new Date(base + days * 86400000).toISOString(), termDays, current ? current.auto_exchange === 1 : true, current?.last_error || null);
        audit("admin_gpm_extend_sub_license", null, "", `license=${parentUuid};sub=${childUuid};days=${days}`);
        return json(res, 200, { license: projectGpmDetail(await gpmLicenseDetail(parentUuid)) });
      }
      const gpmExchangeMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses\/([0-9a-f-]+)\/exchange$/i);
      if (gpmExchangeMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const parentUuid = gpmUuid(gpmExchangeMatch[1]); const childUuid = gpmUuid(gpmExchangeMatch[2]);
        const { child } = await requireGpmChild(parentUuid, childUuid); const refreshed = await exchangeGpmChild(parentUuid, childUuid, child, gpmTerm(childUuid), true);
        audit("admin_gpm_exchange_sub_license", null, "", `license=${parentUuid};sub=${childUuid}`);
        return json(res, 200, { license: projectGpmDetail(refreshed) });
      }
      const gpmSubAllMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses\/all$/i);
      if (gpmSubAllMatch && req.method === "DELETE") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const uuid = gpmUuid(gpmSubAllMatch[1]);
        await gpmRequest(`/licenses/${uuid}/sub-licenses/all`, "DELETE");
        audit("admin_gpm_delete_sub_licenses", null, "", `license=${uuid}`);
        return json(res, 200, { ok: true });
      }
      const gpmRevealSubMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/sub-licenses\/([0-9a-f-]+)\/reveal$/i);
      if (gpmRevealSubMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const parentUuid = gpmUuid(gpmRevealSubMatch[1]); const childUuid = gpmUuid(gpmRevealSubMatch[2]);
        const detail = await gpmLicenseDetail(parentUuid); const child = (Array.isArray(detail?.subLicenses) ? detail.subLicenses : []).find((item) => String(item?.uuid || "").toLowerCase() === childUuid.toLowerCase());
        if (!child) throw Object.assign(new Error("Sub-license không thuộc license cha."), { status: 404 });
        const key = gpmFullKey(child, "subLicense"); audit("admin_gpm_reveal_sub_license", null, "", `license=${parentUuid};sub=${childUuid}`);
        return json(res, 200, { key });
      }
      const gpmRevealMatch = url.pathname.match(/^\/admin\/gpm\/licenses\/([0-9a-f-]+)\/reveal$/i);
      if (gpmRevealMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const uuid = gpmUuid(gpmRevealMatch[1]);
        const detail = await gpmLicenseDetail(uuid); const key = gpmFullKey(detail, "license"); audit("admin_gpm_reveal_license", null, "", `license=${uuid}`);
        return json(res, 200, { key });
      }
      if (url.pathname === "/admin/proton/overview" && req.method === "GET") {
        requireAdmin(req);
        const accounts = db.prepare("SELECT * FROM proton_accounts ORDER BY id DESC").all();
        const rentals = db.prepare("SELECT * FROM proton_rentals").all();
        const timestamp = clock();
        return json(res, 200, {
          accounts: accounts.map(safeProtonAccount),
          stats: { accounts: accounts.length, rentals: rentals.length, active: rentals.filter((row) => protonExpiry(row.expires_at)?.getTime() > timestamp).length, expired: rentals.filter((row) => protonExpiry(row.expires_at)?.getTime() <= timestamp).length },
          worker: { ...protonWorker },
           config: { baseUrl: proton.baseUrl, appVersion: proton.appVersion, autoRevoke: proton.autoRevoke, autoRevokeIntervalMs: proton.autoRevokeIntervalMs, credentialRefreshConfigured: Boolean(proton.refreshCommand), defaultCookieRotationConfigured: Boolean(proton.defaultCookie) },
        });
      }
      if (url.pathname === "/admin/proton/accounts" && req.method === "GET") {
        requireAdmin(req);
        return json(res, 200, { accounts: db.prepare("SELECT * FROM proton_accounts ORDER BY id DESC").all().map(safeProtonAccount) });
      }
      if (url.pathname === "/admin/proton/accounts" && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        const name = text(body.name, 1, 120, "Tên Proton account");
        const email = text(body.email, 1, 320, "Email Proton").toLowerCase();
        if (!PROTON_EMAIL_PATTERN.test(email)) throw Object.assign(new Error("Email Proton không hợp lệ."), { status: 400 });
        const cookie = text(body.cookie, 1, 20000, "Cookie Proton");
        const uid = text(body.uid, 1, 200, "UID Proton");
        const password = body.password ? text(body.password, 1, 512, "Password Proton") : "";
        const appVersion = text(body.appVersion || proton.appVersion || "", 0, 80, "App version");
        const cookieEncrypted = encryptText(cookie); if (!cookieEncrypted) throw Object.assign(new Error("KEY_ENCRYPTION_SECRET chưa được cấu hình để mã hóa credential Proton."), { status: 503 });
        const passwordEncrypted = password ? encryptText(password) : "";
        const timestamp = nowIso(clock);
        try {
          const result = db.prepare("INSERT INTO proton_accounts(name,email,cookie_encrypted,uid,password_encrypted,app_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(name, email, cookieEncrypted, uid, passwordEncrypted, appVersion, timestamp, timestamp);
          const id = Number(result.lastInsertRowid); protonAudit("proton_account_created", id, uid); return json(res, 201, { account: safeProtonAccount(db.prepare("SELECT * FROM proton_accounts WHERE id=?").get(id)) });
        } catch (error) { if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("UID Proton đã tồn tại."), { status: 409 }); throw error; }
      }
      const protonAccountMatch = url.pathname.match(/^\/admin\/proton\/accounts\/(\d+)$/);
      if (protonAccountMatch && req.method === "PATCH") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const id = positiveInt(protonAccountMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account");
        const account = protonAccountRow(id); const values = { name: body.name === undefined ? account.name : text(body.name, 1, 120, "Tên Proton account"), email: body.email === undefined ? account.email : text(body.email, 1, 320, "Email Proton").toLowerCase(), appVersion: body.appVersion === undefined ? account.app_version : text(body.appVersion, 0, 80, "App version") };
        if (!PROTON_EMAIL_PATTERN.test(values.email)) throw Object.assign(new Error("Email Proton không hợp lệ."), { status: 400 });
        let cookieEncrypted = account.cookie_encrypted;
        if (body.cookie !== undefined) { const cookie = text(body.cookie, 1, 20000, "Cookie Proton"); cookieEncrypted = encryptText(cookie); if (!cookieEncrypted) throw Object.assign(new Error("Không thể mã hóa cookie Proton."), { status: 503 }); }
        let passwordEncrypted = account.password_encrypted;
        if (body.clearPassword === true) passwordEncrypted = "";
        else if (body.password !== undefined) { passwordEncrypted = encryptText(text(body.password, 1, 512, "Password Proton")); if (!passwordEncrypted) throw Object.assign(new Error("Không thể mã hóa password Proton."), { status: 503 }); }
        const timestamp = nowIso(clock); db.prepare("UPDATE proton_accounts SET name=?,email=?,cookie_encrypted=?,password_encrypted=?,app_version=?,updated_at=? WHERE id=?").run(values.name, values.email, cookieEncrypted, passwordEncrypted, values.appVersion, timestamp, id); protonAudit("proton_account_updated", id, account.uid); return json(res, 200, { account: safeProtonAccount(db.prepare("SELECT * FROM proton_accounts WHERE id=?").get(id)) });
      }
      if (protonAccountMatch && req.method === "DELETE") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const id = positiveInt(protonAccountMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account"); const account = protonAccountRow(id);
        const rental = db.prepare("SELECT session_uid FROM proton_rentals WHERE account_id=? LIMIT 1").get(id); if (rental) throw Object.assign(new Error("Không thể xóa Proton account còn rental; hãy unassign trước."), { status: 409 });
        db.prepare("DELETE FROM proton_accounts WHERE id=?").run(id); protonAudit("proton_account_deleted", id, account.uid); return json(res, 200, { ok: true });
      }
      const protonSessionsMatch = url.pathname.match(/^\/admin\/proton\/accounts\/(\d+)\/sessions$/);
      if (protonSessionsMatch && req.method === "GET") {
        requireAdmin(req); const id = positiveInt(protonSessionsMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account"); const account = protonAccountRow(id); const sessions = await listProtonSessions(account); const rentals = new Map(db.prepare("SELECT * FROM proton_rentals").all().map((row) => [row.session_uid, row])); const timestamp = clock();
        const projected = sessions.map((item) => { const sessionUid = protonSessionUid(item); const rental = rentals.get(sessionUid); const status = protonStatus(item, rental, account.uid, timestamp); const expiresAt = rental?.expires_at || ""; return { sessionUid, uid: sessionUid, device: protonDeviceName(item), status, state: status, createdAt: protonCreatedAt(item), customer: rental?.customer || "", phone: rental?.phone || "", note: rental?.note || "", expiresAt, timeLeft: protonTimeLeft(status, expiresAt, timestamp), isCurrent: sessionUid === account.uid, rental: rental ? safeProtonRental(rental) : null, lastSeenAt: String(item.LastUsed || item.lastSeenAt || item.last_seen_at || "") }; });
        const statusStats = Object.fromEntries(["manager", "unassigned", "invalid", "expired", "active"].map((status) => [status, projected.filter((item) => item.status === status).length]));
        return json(res, 200, { account: safeProtonAccount(account), sessions: projected, stats: { total: projected.length, active: statusStats.active, expired: statusStats.expired + statusStats.invalid, available: Math.max(0, PROTON_MAX_DEVICES - projected.length), capacity: PROTON_MAX_DEVICES, ...statusStats } });
      }
      const protonRentalMatch = url.pathname.match(/^\/admin\/proton\/rentals\/([^/]+)$/);
      if (protonRentalMatch && req.method === "PUT") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const sessionUid = text(decodeURIComponent(protonRentalMatch[1]), 1, 200, "Session UID"); const accountId = positiveInt(body.accountId, 1, Number.MAX_SAFE_INTEGER, "Account ID"); const account = protonAccountRow(accountId);
        if (sessionUid === account.uid) throw Object.assign(new Error("Không thể assign session UID quản lý hiện tại."), { status: 409 });
        const remote = (await listProtonSessions(account)).find((item) => protonSessionUid(item) === sessionUid); if (!remote) throw Object.assign(new Error("Session không thuộc Proton account."), { status: 400 });
        const customer = text(body.customer, 1, 160, "Customer"); const phone = text(body.phone || "", 0, 40, "Phone"); const note = text(body.note || "", 0, 500, "Note"); const expiresAt = durationExpiry(body, clock()); const timestamp = nowIso(clock);
        db.exec("BEGIN IMMEDIATE"); try { db.prepare("INSERT INTO proton_rentals(session_uid,account_id,customer,phone,note,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_uid) DO UPDATE SET account_id=excluded.account_id,customer=excluded.customer,phone=excluded.phone,note=excluded.note,expires_at=excluded.expires_at,updated_at=excluded.updated_at").run(sessionUid, accountId, customer, phone, note, expiresAt, timestamp, timestamp); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
        protonAudit("proton_rental_assigned", accountId, sessionUid); return json(res, 200, { rental: safeProtonRental(db.prepare("SELECT * FROM proton_rentals WHERE session_uid=?").get(sessionUid)) });
      }
      if (protonRentalMatch && req.method === "DELETE") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const sessionUid = text(decodeURIComponent(protonRentalMatch[1]), 1, 200, "Session UID"); const rental = db.prepare("SELECT * FROM proton_rentals WHERE session_uid=?").get(sessionUid); if (!rental) return json(res, 404, { error: "Không tìm thấy rental." }); db.prepare("DELETE FROM proton_rentals WHERE session_uid=?").run(sessionUid); protonAudit("proton_rental_unassigned", rental.account_id, sessionUid); return json(res, 200, { ok: true });
      }
      const protonRevokeMatch = url.pathname.match(/^\/admin\/proton\/accounts\/(\d+)\/sessions\/([^/]+)\/revoke$/);
      if (protonRevokeMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const id = positiveInt(protonRevokeMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account"); const account = protonAccountRow(id); const sessionUid = text(decodeURIComponent(protonRevokeMatch[2]), 1, 200, "Session UID");
        await revokeProtonSession(account, sessionUid); db.prepare("DELETE FROM proton_rentals WHERE session_uid=? AND account_id=?").run(sessionUid, id); protonAudit("proton_session_revoked", id, sessionUid); return json(res, 200, { ok: true, sessionUid });
      }
      const protonCleanupMatch = url.pathname.match(/^\/admin\/proton\/accounts\/(\d+)\/cleanup$/);
      if (protonCleanupMatch && req.method === "POST") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const id = positiveInt(protonCleanupMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account"); const result = await cleanupProtonAccount(protonAccountRow(id), body.dryRun === true); protonAudit(body.dryRun === true ? "proton_cleanup_dry_run" : "proton_cleanup", id, "", JSON.stringify(result)); return json(res, 200, result);
      }
      if (url.pathname === "/admin/proton/export.json" && req.method === "GET") {
        requireAdmin(req); const rentals = db.prepare("SELECT * FROM proton_rentals ORDER BY session_uid").all().map(safeProtonRental); return json(res, 200, { rentals });
      }
      if (url.pathname === "/admin/proton/export.csv" && req.method === "GET") {
        requireAdmin(req); const rows = db.prepare("SELECT * FROM proton_rentals ORDER BY session_uid").all(); const csv = ["sessionUid,accountId,customer,phone,note,expiresAt", ...rows.map((row) => [row.session_uid, row.account_id ?? "", row.customer, row.phone, row.note, row.expires_at || ""].map((value) => `"${String(value).replaceAll('"', '""')}"`).join(","))].join("\n"); const data = Buffer.from(csv); res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": "attachment; filename=proton-rentals.csv", "content-length": data.length, "cache-control": "no-store" }); return res.end(data);
      }
      if (url.pathname === "/admin/proton/import" && req.method === "POST") {
        const session = requireAdmin(req); if (String(req.headers["content-type"] || "").split(";", 1)[0] !== "application/json") throw Object.assign(new Error("Import Proton chỉ nhận application/json."), { status: 415 }); const body = await readBody(req); requireCsrf(req, session, body); const rentals = Array.isArray(body) ? body : body?.rentals; if (!Array.isArray(rentals)) throw Object.assign(new Error("Import phải là array hoặc object rentals."), { status: 400 }); const overwrite = body && !Array.isArray(body) && body.overwrite === true; const result = { scanned: rentals.length, imported: 0, skipped: 0, failed: 0 };
        db.exec("BEGIN IMMEDIATE"); try { for (const item of rentals) { try { const sessionUid = text(item.sessionUid, 1, 200, "Session UID"); const accountId = item.accountId === null || item.accountId === undefined || item.accountId === "" ? null : positiveInt(item.accountId, 1, Number.MAX_SAFE_INTEGER, "Account ID"); if (accountId && !db.prepare("SELECT id FROM proton_accounts WHERE id=?").get(accountId)) throw new Error("Account ID không tồn tại."); const customer = text(item.customer || "", 0, 160, "Customer"); const phone = text(item.phone || "", 0, 40, "Phone"); const note = text(item.note || "", 0, 500, "Note"); const expiresAt = item.expiresAt ? durationExpiry({ expiresAt: item.expiresAt }, clock()) : null; const exists = db.prepare("SELECT session_uid FROM proton_rentals WHERE session_uid=?").get(sessionUid); if (exists && !overwrite) { result.skipped += 1; continue; } db.prepare("INSERT INTO proton_rentals(session_uid,account_id,customer,phone,note,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_uid) DO UPDATE SET account_id=excluded.account_id,customer=excluded.customer,phone=excluded.phone,note=excluded.note,expires_at=excluded.expires_at,updated_at=excluded.updated_at").run(sessionUid, accountId, customer, phone, note, expiresAt, nowIso(clock), nowIso(clock)); result.imported += 1; } catch { result.failed += 1; } } db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; } audit("proton_import", null, "", `scanned=${result.scanned};imported=${result.imported};skipped=${result.skipped};failed=${result.failed}`); return json(res, 200, result);
      }
      const protonRefreshMatch = url.pathname.match(/^\/admin\/proton\/accounts\/(\d+)\/refresh-credentials$/);
      if (protonRefreshMatch && req.method === "POST") {
         const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
         const account = protonAccountRow(positiveInt(protonRefreshMatch[1], 1, Number.MAX_SAFE_INTEGER, "Proton account"));
         if (!proton.refreshCommand) return json(res, 503, { ok: false, configured: false, status: "refresh_unconfigured", error: "Chưa cấu hình PROTON_REFRESH_COMMAND/PROTON_REFRESH_ARGS." });
         await refreshProtonCredentials(account);
         return json(res, 200, { ok: true, configured: true, account: safeProtonAccount(db.prepare("SELECT * FROM proton_accounts WHERE id=?").get(account.id)) });
      }
      if (req.method === "POST" && url.pathname === "/admin/vless/clients") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        const inboundId = positiveInt(body.inboundId, 1, Number.MAX_SAFE_INTEGER, "Inbound");
        const email = vlessEmail(body.email);
        if ([body.limitIp, body.limitGb, body.limitDays].some((value) => value === "" || value === null || value === undefined)) throw Object.assign(new Error("Các giới hạn VLESS là bắt buộc."), { status: 400 });
        const limitIp = positiveInt(body.limitIp, 0, 1000, "Giới hạn IP");
        const limitGb = finiteNumber(body.limitGb, 0, 1000000, "Giới hạn dung lượng");
        const limitDays = positiveInt(body.limitDays, 0, 36500, "Hạn sử dụng");
        const totalGB = Math.round(limitGb * 1024 * 1024 * 1024);
        const expiryTime = limitDays === 0 ? 0 : clock() + limitDays * 86400000;
        const inbounds = await listVless();
        const inbound = inbounds.find((item) => item.id === inboundId);
        if (!inbound) throw Object.assign(new Error("Inbound VLESS không tồn tại."), { status: 400 });
        if (!inbound.enabled) throw Object.assign(new Error("Inbound VLESS đang tắt."), { status: 400 });
        if (inbounds.some((item) => item.clients.some((client) => client.email === email))) throw Object.assign(new Error("VLESS client đã tồn tại."), { status: 409 });
        await panelRequest("/panel/api/clients/add", "POST", {
          client: { email, totalGB, expiryTime, tgId: 0, limitIp, enable: true },
          inboundIds: [inboundId],
        });
        audit("admin_vless_create", null, "", `email=${email}; inbound=${inboundId}`);
        try {
          return json(res, 201, { created: true, email, key: await revealVless(email) });
        } catch (error) {
          return json(res, 502, { created: true, email, error: "Client đã được tạo nhưng chưa lấy được VLESS key. Hãy tải lại danh sách và thử sao chép." });
        }
      }
      const vlessRevealMatch = url.pathname.match(/^\/admin\/vless\/clients\/([^/]+)\/reveal$/);
      if (req.method === "POST" && vlessRevealMatch) {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        let email;
        try { email = vlessEmail(decodeURIComponent(vlessRevealMatch[1])); } catch (error) { if (error instanceof URIError) throw Object.assign(new Error("Tên client không hợp lệ."), { status: 400 }); throw error; }
        await requireUniqueVlessClient(email);
        const key = await revealVless(email);
        audit("admin_vless_reveal", null, "", `email=${email}`);
        return json(res, 200, { key });
      }
      const vlessDeleteMatch = url.pathname.match(/^\/admin\/vless\/clients\/([^/]+)$/);
      if (req.method === "DELETE" && vlessDeleteMatch) {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        let email;
        try { email = vlessEmail(decodeURIComponent(vlessDeleteMatch[1])); } catch (error) { if (error instanceof URIError) throw Object.assign(new Error("Tên client không hợp lệ."), { status: 400 }); throw error; }
        await requireUniqueVlessClient(email);
        await panelRequest(`/panel/api/clients/del/${encodeURIComponent(email)}?keepTraffic=0`, "POST");
        audit("admin_vless_delete", null, "", `email=${email}`);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/admin/accounts") {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        const plan = text(body.plan, 1, 60, "Gói");
        const name = text(body.name || body.note || body.plan || "Khách hàng", 1, 100, "Tên khách hàng");
        const note = text(body.note || "", 0, 300, "Ghi chú");
        const days = positiveInt(body.days, 1, 3650, "Hạn dùng");
        const key = createKey(); const timestamp = nowIso(clock);
        const startDate = body.startDate ? String(body.startDate).trim() : null;
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = db.prepare("INSERT INTO accounts(name,plan,note,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(name, plan, note, addDays(clock, days, startDate), timestamp, timestamp);
          const accountId = Number(result.lastInsertRowid); db.prepare("INSERT INTO account_keys(account_id,key_hash,key_hint,full_key,created_at) VALUES(?,?,?,?,?)").run(accountId, sha256(key), `${key.slice(0, 8)}...${key.slice(-4)}`, encryptText(key), timestamp); db.exec("COMMIT"); audit("account_created", accountId);
           return renderAdmin(req, res, session, `Key mới (chỉ hiển thị lần này): ${key}`, key);
        } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
      }
      const revealMatch = url.pathname.match(/^\/admin\/accounts\/(\d+)\/reveal-key$/);
      if (req.method === "POST" && revealMatch) {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        const id = Number(revealMatch[1]);
        const row = db.prepare("SELECT k.full_key, k.key_hint FROM account_keys k WHERE k.account_id=?").get(id);
        if (!row) throw Object.assign(new Error("Không tìm thấy tài khoản."), { status: 404 });
        const key = decryptText(row.full_key);
        if (!key) throw Object.assign(new Error("Key đầy đủ không còn khả dụng. Chỉ key tạo sau khi cấu hình KEY_ENCRYPTION_SECRET mới có thể xem lại."), { status: 409 });
        audit("admin_reveal_key", id, "", `key_hint=${row.key_hint}`);
        return json(res, 200, { key });
      }
      const toggleMatch = url.pathname.match(/^\/admin\/accounts\/(\d+)\/toggle$/);
      if (req.method === "POST" && toggleMatch) {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body);
        const id = Number(toggleMatch[1]);
        const account = db.prepare("SELECT * FROM accounts WHERE id=? AND archived_at IS NULL").get(id);
        if (!account) throw Object.assign(new Error("Không tìm thấy tài khoản."), { status: 404 });
        const newStatus = account.status === "active" ? "locked" : "active";
        const newEnabled = newStatus === "active" ? 1 : 0;
        const timestamp = nowIso(clock);
        db.exec("BEGIN IMMEDIATE");
        try {
          db.prepare("UPDATE accounts SET status=?, enabled=?, updated_at=? WHERE id=?").run(newStatus, newEnabled, timestamp, id);
          if (newStatus === "locked") queueCommand(id, "lock", account.generation);
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        audit(`admin_toggle_${newStatus}`, id);
        return json(res, 200, { ok: true, status: newStatus, enabled: Boolean(newEnabled) });
      }
      if (req.method === "POST" && url.pathname === "/admin/accounts/bulk-action") {
        const session = requireAdmin(req);
        const body = await readBody(req);
        requireCsrf(req, session, body);
        const action = text(body.action, 1, 30, "Thao tác hàng loạt");
        const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(n => Number.isInteger(n) && n > 0) : [];
        if (ids.length === 0) throw Object.assign(new Error("Vui lòng chọn ít nhất 1 khách hàng."), { status: 400 });
        const timestamp = nowIso(clock);
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const id of ids) {
            const account = db.prepare("SELECT * FROM accounts WHERE id=? AND archived_at IS NULL").get(id);
            if (!account) continue;
            if (action === "extend") {
              db.prepare("UPDATE accounts SET expires_at=?,updated_at=? WHERE id=?").run(extendExpiry(account.expires_at, clock), timestamp, id);
            } else if (action === "lock") {
              db.prepare("UPDATE accounts SET status='locked',enabled=0,updated_at=? WHERE id=?").run(timestamp, id);
              queueCommand(id, "lock", account.generation);
            } else if (action === "unlock") {
              const pendingLock = db.prepare("SELECT id FROM commands WHERE account_id=? AND type='lock' AND acked_at IS NULL LIMIT 1").get(id);
              const supersedesLock = account.status === "locked" || Boolean(pendingLock);
              db.prepare("UPDATE accounts SET status='active',enabled=1,generation=generation+?,updated_at=? WHERE id=?").run(supersedesLock ? 1 : 0, timestamp, id);
              if (supersedesLock) db.prepare("UPDATE commands SET acked_at=? WHERE account_id=? AND acked_at IS NULL").run(timestamp, id);
            } else if (action === "force_logout") {
              queueCommand(id, "force_logout", account.generation);
            } else if (action === "reset_binding") {
              revokeSessions(id);
              db.prepare("UPDATE commands SET acked_at=COALESCE(acked_at,?) WHERE account_id=?").run(timestamp, id);
              releaseBinding(id, timestamp);
              db.prepare("UPDATE accounts SET activated_at=NULL,generation=generation+1,updated_at=? WHERE id=?").run(timestamp, id);
            } else if (action === "archive") {
              archiveAccount(id, timestamp);
            }
          }
          db.exec("COMMIT");
        } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; }
        audit(`admin_bulk_${action}`, null, "", `count=${ids.length}`);
        return json(res, 200, { ok: true, count: ids.length });
      }
      const actionMatch = url.pathname.match(/^\/admin\/accounts\/(\d+)\/action$/);
      if (req.method === "POST" && actionMatch) {
        const session = requireAdmin(req); const body = await readBody(req); requireCsrf(req, session, body); const id = Number(actionMatch[1]);
        const account = db.prepare("SELECT * FROM accounts WHERE id=? AND archived_at IS NULL").get(id); if (!account) throw Object.assign(new Error("Không tìm thấy tài khoản."), { status: 404 });
        const timestamp = nowIso(clock);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (body.action === "extend") {
            db.prepare("UPDATE accounts SET expires_at=?,updated_at=? WHERE id=?").run(extendExpiry(account.expires_at, clock), timestamp, id);
          }
          else if (body.action === "edit") {
            const name = text(body.name || body.plan, 1, 100, "Tên khách hàng");
            const plan = text(body.plan, 1, 60, "Gói"); const note = text(body.note || "", 0, 300, "Ghi chú");
            const expires = new Date(`${text(body.expiresAt, 10, 10, "Ngày hết hạn")}T08:00:00.000Z`);
            if (Number.isNaN(expires.getTime())) throw Object.assign(new Error("Ngày hết hạn không hợp lệ."), { status: 400 });
            db.prepare("UPDATE accounts SET name=?,plan=?,note=?,expires_at=?,updated_at=? WHERE id=?").run(name, plan, note, expires.toISOString(), timestamp, id);
            if (body.newKey !== undefined && String(body.newKey).trim() !== "") throw Object.assign(new Error("Không được thay đổi key đã cấp."), { status: 409 });
          }
          else if (body.action === "lock") { db.prepare("UPDATE accounts SET status='locked',enabled=0,updated_at=? WHERE id=?").run(timestamp, id); queueCommand(id, "lock", account.generation); }
          else if (body.action === "unlock") {
            const pendingLock = db.prepare("SELECT id FROM commands WHERE account_id=? AND type='lock' AND acked_at IS NULL LIMIT 1").get(id);
            const supersedesLock = account.status === "locked" || Boolean(pendingLock);
            db.prepare(`UPDATE accounts SET status='active',enabled=1,generation=generation+?,updated_at=? WHERE id=?`).run(supersedesLock ? 1 : 0, timestamp, id);
            if (supersedesLock) db.prepare("UPDATE commands SET acked_at=? WHERE account_id=? AND acked_at IS NULL").run(timestamp, id);
          }
          else if (body.action === "force_logout") queueCommand(id, "force_logout", account.generation);
          else if (body.action === "reset_binding") { revokeSessions(id); db.prepare("UPDATE commands SET acked_at=COALESCE(acked_at,?) WHERE account_id=?").run(timestamp, id); releaseBinding(id, timestamp); db.prepare("UPDATE accounts SET activated_at=NULL,generation=generation+1,updated_at=? WHERE id=?").run(timestamp, id); }
          else if (body.action === "archive") archiveAccount(id, timestamp);
          else throw Object.assign(new Error("Thao tác không hợp lệ."), { status: 400 });
          db.exec("COMMIT");
        } catch (error) { db.exec("ROLLBACK"); throw error; }
        audit(`admin_${body.action}`, id); return redirect(res, "/admin");
      }
      if (req.method === "GET" && url.pathname === "/admin/realtime-status") {
        const session = adminSession(req);
        if (!session) return json(res, 401, { error: "Cần đăng nhập." });
        const nowTime = clock();
        const accounts = db.prepare(`SELECT a.id, a.status, a.enabled, d.last_seen_at
          FROM accounts a
          LEFT JOIN devices d ON d.account_id=a.id AND d.released_at IS NULL
          WHERE a.archived_at IS NULL`).all();
        const result = accounts.map((item) => {
          const parsed = parseIsoDate(item.last_seen_at);
          const isOnline = Boolean(parsed && (nowTime - parsed.getTime() < 90000));
          return {
            id: item.id,
            isOnline,
            status: item.status,
            enabled: item.enabled,
            lastSeenFormatted: formatVietnamDateTime(item.last_seen_at)
          };
        });
        return json(res, 200, { accounts: result });
      }
      return json(res, 404, { error: "Không tìm thấy." });
    } catch (error) {
      const status = error.status || (error instanceof SyntaxError ? 400 : 500);
       if (status >= 500) {
         console.error("Request failed:", JSON.stringify({ method: req.method, path: url.pathname, status, upstreamStatus: error.upstreamStatus || null, message: String(error.message || "").slice(0, 200) }));
       }
      if (String(req.headers.accept || "").includes("text/html") && url.pathname.startsWith("/admin")) {
        const data = Buffer.from(`<p>${escapeHtml(status >= 500 ? "Lỗi hệ thống." : error.message)}</p><p><a href="/admin">Quay lại</a></p>`); res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": data.length, "cache-control": "no-store" }); return res.end(data);
      }
      return json(res, status, { error: status >= 500 ? "Lỗi hệ thống." : error.message });
    }
  };
}

module.exports = { createApp, isGateway };
