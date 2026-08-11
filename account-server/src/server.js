"use strict";

const http = require("node:http");
const { createApp } = require("./app");
const { openDatabase } = require("./database");

const port = Number(process.env.PORT || 8080);
const databasePath = process.env.DATABASE_PATH || "/data/accounts.sqlite";
const adminPasswordHash = process.env.ADMIN_PASSWORD_HASH;
if (!adminPasswordHash) throw new Error("ADMIN_PASSWORD_HASH là bắt buộc. Chạy scripts/hash-password.js để tạo.");
if (process.env.NODE_ENV === "production" && (!process.env.KEY_ENCRYPTION_SECRET || process.env.KEY_ENCRYPTION_SECRET.length < 16)) {
  throw new Error("KEY_ENCRYPTION_SECRET là bắt buộc trong production và phải dài ít nhất 16 ký tự.");
}
const db = openDatabase(databasePath);
const dockerGateway = (() => {
  try {
    const fs = require("node:fs");
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
})();
const server = http.createServer(createApp({
  db,
  adminPasswordHash,
  production: process.env.NODE_ENV === "production",
  trustProxy: process.env.TRUST_PROXY === "1",
  dockerGateway,
  xui: {
    baseUrl: process.env["292VPN_PANEL_API_URL"] || "",
    token: process.env["292VPN_PANEL_API_TOKEN"] || "",
    username: process.env["292VPN_PANEL_USERNAME"] || "",
    password: process.env["292VPN_PANEL_PASSWORD"] || "",
    allowInsecureHttp: process.env["292VPN_ALLOW_INSECURE_HTTP"] === "1",
    onlineWindowMs: (Number(process.env["292VPN_ONLINE_WINDOW_HOURS"]) || 24) * 3600 * 1000,
  },
  gpm: {
    email: process.env.GPM_EMAIL || process.env.GPM_email || "",
    password: process.env.GPM_PASSWORD || process.env.GPM_pass || "",
    baseUrl: process.env.GPM_API_BASE_URL || "",
    autoExchange: process.env.GPM_AUTO_EXCHANGE !== "0",
    autoExchangeIntervalMs: Number(process.env.GPM_AUTO_EXCHANGE_INTERVAL_MS) || 60000,
    expiringWindowMs: (Number(process.env.GPM_EXPIRING_WINDOW_HOURS) || 72) * 3600000,
  },
  proton: {
    baseUrl: process.env.PROTON_API_BASE_URL || "https://account.protonvpn.com",
    appVersion: process.env.PROTON_APP_VERSION || "",
    autoRevoke: process.env.PROTON_AUTO_REVOKE === "1",
    autoRevokeIntervalMs: Number(process.env.PROTON_AUTO_REVOKE_INTERVAL_MS) || 3600000,
    cookie: process.env.PROTON_COOKIE || "",
    password: process.env.PROTON_PASSWORD || "",
    refreshCommand: process.env.PROTON_REFRESH_COMMAND || "",
    refreshArgs: (() => {
      const raw = String(process.env.PROTON_REFRESH_ARGS || "").trim();
      if (!raw) return [];
      try { return JSON.parse(raw).map(String); } catch {}
      // Docker --env-file strips the inner quotes from values such as
      // ["/app/scripts/refresh-proton.py"]. Accept that deterministic bracket
      // form without invoking a shell or interpreting arbitrary syntax.
      const match = raw.match(/^\[(.*)\]$/s);
      return match ? match[1].split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean) : [];
    })(),
    refreshTimeoutMs: Number(process.env.PROTON_REFRESH_TIMEOUT_MS) || 120000,
  },
}));
server.listen(port, "0.0.0.0", () => console.log(`Account server listening on ${port}`));

function shutdown() { server.close(() => { db.close(); process.exit(0); }); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
