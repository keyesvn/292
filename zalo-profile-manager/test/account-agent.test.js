"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AccountAgent } = require("../src/account/agent");
const { AccountApiClient } = require("../src/account/api-client");
const { CredentialStore } = require("../src/account/credential-store");

function memoryStore(saved = null) {
  return { saved, uid: "a".repeat(64), getOrCreateUid() { return this.uid; }, loadSession() { return this.saved; }, saveSession(value) { this.saved = value; }, clearSession() { this.saved = null; }, recover() { this.saved = null; } };
}

test("matrix: agent activates, exposes projection only and guards sensitive operations", async () => {
  const store = memoryStore();
  const api = { activate: async () => ({ token: "secret-token", generation: 1, leaseSeconds: 30, account: { status: "active", keyHint: "292sv-ZP-ABC...1234", plan: "Pro" } }) };
  const agent = new AccountAgent({ store, api, clock: () => 1000, setTimer: () => 1, clearTimer: () => {} });
  await agent.initialize();
  const projection = await agent.activate("292sv-ZP-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  assert.equal(projection.canOperate, true);
  assert.equal(JSON.stringify(projection).includes("secret-token"), false);
  assert.doesNotThrow(() => agent.assertAllowed("open"));
  assert.doesNotThrow(() => agent.assertAllowed("close"));
});

test("regression: đổi ngày giữ nguyên credential khi heartbeat vẫn hợp lệ", async () => {
  let now = Date.parse("2026-07-30T16:59:00.000Z");
  const store = memoryStore({ token: "token-value", sequence: 0, generation: 3, account: { status: "active", expiresAt: "2026-08-05T01:00:00.000Z" } });
  const api = { heartbeat: async () => ({ generation: 3, leaseSeconds: 30, graceSeconds: 300, blocked: false, command: null, account: { status: "active", expiresAt: "2026-08-05T01:00:00.000Z" } }) };
  const agent = new AccountAgent({ store, api, clock: () => now, setTimer: () => 1, clearTimer: () => {} });

  await agent.initialize();
  now += 2 * 60000; // 23:59 -> 00:01 GMT+7.
  await agent.heartbeat();

  assert.equal(agent.projection().status, "active");
  assert.equal(store.saved.token, "token-value");
  assert.equal(store.saved.sequence, 2);
  assert.equal(store.saved.account.expiresAt, "2026-08-05T01:00:00.000Z");
});

test("matrix: mất mạng chặn operation mới ngay, hết grace 5 phút thì enforce một lần", async () => {
  let now = 1000;
  let enforced = 0;
  const store = memoryStore({ token: "token-value", sequence: 0, generation: 1, account: { status: "active" } });
  const agent = new AccountAgent({ store, api: { heartbeat: async () => { throw new Error("offline"); } }, clock: () => now, setTimer: () => 1, clearTimer: () => {}, onEnforce: async () => { enforced += 1; } });
  await agent.initialize();
  assert.equal(agent.projection().status, "offline-grace");
  assert.throws(() => agent.assertAllowed("open"));
  assert.doesNotThrow(() => agent.assertAllowed("close"));
  now += 300001;
  await agent.heartbeat();
  await agent.heartbeat();
  assert.equal(agent.projection().status, "offline-blocked");
  assert.equal(enforced, 1);
});

test("matrix: force logout chỉ ACK và xóa session sau enforcement thành công", async () => {
  let enforced = 0;
  let acknowledged = 0;
  const store = memoryStore({ token: "token-value", sequence: 4, generation: 7, account: { status: "active" } });
  const api = { heartbeat: async () => ({ generation: 7, blocked: true, command: { id: 3, type: "force_logout", generation: 7 }, account: { status: "active" } }), acknowledge: async () => { acknowledged += 1; } };
  const agent = new AccountAgent({ store, api, clock: () => 1000, setTimer: () => 1, clearTimer: () => {}, onEnforce: async () => { enforced += 1; } });
  await agent.initialize();
  assert.equal(agent.projection().status, "revoked");
  assert.equal(store.saved, null);
  assert.equal(enforced, 1);
  assert.equal(acknowledged, 1);
});

test("matrix: failed enforcement keeps command and token persisted for retry", async () => {
  const store = memoryStore({ token: "token-value", sequence: 1, generation: 2, account: { status: "active" } });
  let acknowledged = 0;
  const api = { heartbeat: async () => ({ generation: 2, blocked: true, command: { id: 8, type: "lock", generation: 2 }, account: { status: "locked" } }), acknowledge: async () => { acknowledged += 1; } };
  const agent = new AccountAgent({ store, api, setTimer: () => 1, clearTimer: () => {}, onEnforce: async () => { throw new Error("process remains"); } });
  await agent.initialize();
  assert.equal(acknowledged, 0);
  assert.equal(store.saved.token, "token-value");
  assert.equal(store.saved.pendingCommand.id, 8);
});

test("pending command is enforced locally when restart heartbeat is offline", async () => {
  const store = memoryStore({ token: "token-value", sequence: 1, generation: 2, account: { status: "locked" }, pendingCommand: { id: 8, type: "lock", generation: 2 } });
  let enforced = 0;
  const agent = new AccountAgent({ store, api: { heartbeat: async () => { throw new Error("offline"); } }, setTimer: () => 1, clearTimer: () => {}, onEnforce: async () => { enforced += 1; } });
  await agent.initialize();
  assert.equal(enforced, 1);
  assert.equal(agent.projection().status, "locked");
});

test("logout keeps retryable session when enforcement fails", async () => {
  const store = memoryStore({ token: "token-value", sequence: 1, generation: 1, account: { status: "active" } });
  const agent = new AccountAgent({ store, api: { heartbeat: async () => { throw new Error("offline"); } }, setTimer: () => 1, clearTimer: () => {}, onEnforce: async () => { throw new Error("process remains"); } });
  await agent.initialize();
  await assert.rejects(agent.logout(), /process remains/);
  assert.equal(store.saved.token, "token-value");
  assert.equal(agent.projection().status, "inactive");
});

test("matrix: offline grace deadline survives restart and wall-clock rollback fails closed", async () => {
  let now = 1000;
  let mono = 100;
  const store = memoryStore({ token: "token-value", sequence: 0, generation: 1, account: { status: "active" } });
  const api = { heartbeat: async () => { throw new Error("offline"); } };
  const first = new AccountAgent({ store, api, clock: () => now, monotonic: () => mono, setTimer: () => 1, clearTimer: () => {} });
  await first.initialize();
  const deadline = store.saved.graceUntil;
  now += 120000;
  mono = 10;
  const second = new AccountAgent({ store, api, clock: () => now, monotonic: () => mono, setTimer: () => 1, clearTimer: () => {} });
  await second.initialize();
  assert.equal(store.saved.graceUntil, deadline);
  now = 500;
  await second.heartbeat();
  assert.equal(second.projection().status, "offline-blocked");
});

test("matrix: lifecycle calls serialize so stale activation cannot overwrite logout", async () => {
  let release;
  const store = memoryStore();
  const api = {
    activate: () => new Promise((resolve) => { release = () => resolve({ token: "token", generation: 1, leaseSeconds: 30, account: { status: "active" } }); }),
    logout: async () => {},
  };
  const agent = new AccountAgent({ store, api, setTimer: () => 1, clearTimer: () => {} });
  await agent.initialize();
  const activating = agent.activate("292sv-ZP-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
  const loggingOut = agent.logout();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([activating, loggingOut]);
  assert.equal(agent.projection().status, "inactive");
  assert.equal(store.saved, null);
});

test("credential corruption fails closed and recovery remains available", async () => {
  let recovered = 0;
  const store = { getOrCreateUid() { throw new Error("corrupt"); }, recover() { recovered += 1; } };
  const agent = new AccountAgent({ store, api: {}, setTimer: () => 1, clearTimer: () => {} });
  await agent.initialize();
  assert.equal(agent.projection().status, "credential-error");
  await agent.recover();
  assert.equal(recovered, 1);
  assert.equal(agent.projection().status, "inactive");
});

test("credential store encrypts installation ID/session and UID is stable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-account-store-"));
  const filePath = path.join(root, "account.secure");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xaa), decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0xaa).toString() };
  try {
    const store = new CredentialStore({ safeStorage, filePath });
    const first = store.getOrCreateUid();
    store.saveSession({ token: "top-secret" });
    const raw = fs.readFileSync(filePath).toString("utf8");
    assert.equal(raw.includes("top-secret"), false);
    assert.equal(store.getOrCreateUid(), first);
    assert.equal(store.loadSession().token, "top-secret");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("regression: credential recovery preserves UID and removes only the session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-account-recover-"));
  const filePath = path.join(root, "account.secure");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xaa), decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0xaa).toString() };
  try {
    const store = new CredentialStore({ safeStorage, filePath });
    const uid = store.getOrCreateUid();
    store.saveSession({ token: "expired-session" });
    const agent = new AccountAgent({ store, api: {}, setTimer: () => 1, clearTimer: () => {} });
    await agent.recover();
    assert.equal(agent.projection().uid, uid);
    assert.equal(store.getOrCreateUid(), uid);
    assert.equal(store.loadSession(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("regression: corrupted credential restores stable UID from encrypted identity backup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-account-identity-"));
  const filePath = path.join(root, "account.secure");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xaa), decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0xaa).toString() };
  try {
    const store = new CredentialStore({ safeStorage, filePath });
    const uid = store.getOrCreateUid();
    fs.writeFileSync(filePath, "corrupt");
    assert.equal(store.getOrCreateUid(), uid);
    assert.equal(store.loadSession(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("regression: corrupted identity backup is repaired from the primary credential", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-account-identity-repair-"));
  const filePath = path.join(root, "account.secure");
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xaa), decryptString: (buffer) => Buffer.from(buffer).map((byte) => byte ^ 0xaa).toString() };
  try {
    const store = new CredentialStore({ safeStorage, filePath });
    const uid = store.getOrCreateUid();
    fs.writeFileSync(`${filePath}.identity`, "corrupt");
    assert.equal(store.getOrCreateUid(), uid);
    assert.equal(store.readIdentity().length > 0, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("API client refuses HTTP and credentials in URL", () => {
  assert.throws(() => new AccountApiClient("http://example.com"));
  assert.throws(() => new AccountApiClient("https://user:pass@example.com"));
  assert.doesNotThrow(() => new AccountApiClient("https://accounts.example.com"));
});

test("main-process regression: sensitive IPC guarded, close/logout allowed, kill uses registry", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  for (const channel of ["profiles:save", "profiles:delete", "profiles:open", "profiles:restart", "proxy:test"]) assert.match(source, new RegExp(`guarded\\("${channel}"`));
  assert.match(source, /ipcMain\.handle\("profiles:close"[\s\S]*assertTrustedSender/);
  assert.match(source, /ipcMain\.handle\("account:logout"[\s\S]*accountAgent\.logout/);
  assert.match(source, /for \(const profile of readProfiles\(\)\)[\s\S]*killProfile\(profile\.appDataId\)/);
  assert.match(source, /operation === "open" \|\| operation === "restart"[\s\S]*killManagedProfiles\(\)/);
  assert.doesNotMatch(source, /killProfile\([^)]*0[^)]*\)/);
  assert.match(source, /new Tray\(/);
  assert.match(source, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(source, /shell\.openExternal\("https:\/\/t\.me\/Trung292sv"\)/);
  assert.match(source, /before-quit[\s\S]*killManagedProfiles\(\)/);
});

test("manager window scales content proportionally when resized or maximized", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  assert.match(main, /screen\.getPrimaryDisplay\(\)\.workAreaSize/);
  assert.match(main, /Math\.min\(1280, workWidth\)/);
  assert.match(main, /Math\.min\(900, workHeight\)/);
  assert.match(main, /width: windowWidth,[\s\S]*height: windowHeight,[\s\S]*resizable: true,[\s\S]*maximizable: true,[\s\S]*fullscreenable: false/);
  assert.match(main, /zoomFactor: 1/);
  assert.match(main, /setVisualZoomLevelLimits\(1, 1\)/);
  assert.doesNotMatch(main, /setLayoutZoomLevelLimits/);
  assert.match(main, /before-input-event[\s\S]*\["\+", "=", "-", "0"\]/);
  assert.match(main, /zoom-changed[\s\S]*event\.preventDefault\(\)[\s\S]*setZoomFactor\(1\)/);
  assert.match(main, /useContentSize: true/);
  assert.match(main, /minWidth: Math\.min\(640, workWidth\)/);
  assert.match(main, /minHeight: Math\.min\(450, workHeight\)/);
  assert.match(main, /webContents\.send\("window:content-size", managerWindow\.getContentSize\(\)\)/);
  assert.match(main, /managerWindow\.on\("resize", sendContentSize\)/);
  assert.match(main, /did-finish-load[\s\S]*sendContentSize/);
  assert.match(preload, /window:content-size/);
  assert.match(preload, /windowApi/);
  assert.match(renderer, /DESIGN_WIDTH = 1280/);
  assert.match(renderer, /DESIGN_HEIGHT = 900/);
  assert.match(renderer, /Math\.min\(width \/ DESIGN_WIDTH, height \/ DESIGN_HEIGHT\)/);
  assert.match(renderer, /root\.style\.setProperty\("--ui-scale", String\(scale\)\)/);
  assert.match(renderer, /--ui-offset-x/);
  assert.match(css, /\.ui-scale-root[\s\S]*translate\(var\(--ui-offset-x\), var\(--ui-offset-y\)\) scale\(var\(--ui-scale\)\)/);
  assert.doesNotMatch(css, /@media \(max-width:/);
  assert.match(css, /\.app-shell[\s\S]*width: 1280px; height: 900px/);
  assert.match(css, /main \{[^}]*height: 900px/);
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  assert.match(css, /body \{[^}]*overflow: hidden/);
  assert.match(css, /\.sidebar \{[\s\S]*overflow-y: auto/);
  assert.match(css, /main \{[^}]*overflow-y: auto/);
  assert.match(css, /dialog \{[\s\S]*max-height: calc\(900px - 32px\);[\s\S]*overflow: auto;[\s\S]*transform: scale\(var\(--ui-scale\)\)/);
});

test("responsive account UI contains required menu, summary and Telegram CTA", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const accountMenu = html.match(/<button class="nav-item"[^>]*data-page="account"[\s\S]*?<\/button>/);
  assert.ok(accountMenu);
  assert.match(accountMenu[0], /<span>Tài Khoản<\/span>/);
  assert.doesNotMatch(accountMenu[0], /02/);
  assert.match(accountMenu[0], /id="navAccountStatus"[^>]*>OFF<\/em>/);
  assert.match(renderer, /const active = account\.status === "active"/);
  assert.match(renderer, /#navAccountStatus"\)\.textContent = active \? "ON" : "OFF"/);
  assert.match(html, /@Trung292sv/);
  assert.doesNotMatch(html, /accountUid|UID cài đặt|logoZP1\.png/);
  assert.match(html, /logoZP2\.png/);
  assert.match(html, /sidebarAccountStatus/);
});

test("update UI and IPC expose an hourly automatic release flow", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  assert.match(main, /ipcMain\.handle\("update:get"[\s\S]*assertTrustedSender/);
  assert.match(main, /ipcMain\.handle\("update:check"[\s\S]*assertTrustedSender/);
  assert.match(main, /ipcMain\.handle\("update:install"[\s\S]*assertTrustedSender[\s\S]*killManagedProfiles\(\)/);
  assert.match(preload, /updateApi[\s\S]*update:get[\s\S]*update:check[\s\S]*update:install[\s\S]*update:changed/);
  assert.match(html, /data-page="update"[\s\S]*id="updatePage"[\s\S]*id="checkUpdateButton"[\s\S]*id="installUpdateButton"[^>]*>Cài bản mới/);
  assert.match(renderer, /#installUpdateButton"\)\.hidden = update\.status !== "downloaded"/);
});

test("profile toolbar exposes A-Z and Z-A sorting through the filter button", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  assert.match(html, /id="sortButton"[\s\S]*data-sort="asc">Tên: A-Z<[\s\S]*data-sort="desc">Tên: Z-A</);
  assert.match(renderer, /left\.name\.localeCompare\(right\.name, "vi"/);
  assert.match(renderer, /state\.sort === "desc" \? -comparison : comparison/);
  assert.match(renderer, /selectSort\(option\.dataset\.sort\)[\s\S]*closeSortMenu\(true\)[\s\S]*render\(\)/);
  assert.match(renderer, /event\.key === "Escape"[\s\S]*event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(renderer, /setAttribute\("aria-label", `Sắp xếp profile: \$\{label\}`\)/);
});

test("profile UI exposes bulk creation, selection and protected bulk IPC", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "src", "preload.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  assert.match(html, /data-action="create-many"[\s\S]*id="bulkCreateDialog"[\s\S]*id="bulkActionBar"/);
  assert.match(html, /id="selectAllProfiles"[\s\S]*data-bulk-action="open"[^>]*>Chạy<[\s\S]*data-bulk-action="close"[\s\S]*data-bulk-action="delete"/);
  assert.match(renderer, /selected: new Set\(\)/);
  assert.match(renderer, /window\.profilesApi\.createMany/);
  assert.match(renderer, /window\.profilesApi\.openMany/);
  assert.match(preload, /profiles:create-many/);
  assert.match(preload, /profiles:open-many/);
  assert.match(preload, /profiles:delete-many/);
  assert.match(main, /guarded\("profiles:create-many", "save"/);
  assert.match(main, /guarded\("profiles:open-many", "open"/);
  assert.match(main, /runtime\.status === "running"[\s\S]*skipped \+= 1/);
  assert.match(main, /return \{ opened, skipped \}/);
  assert.match(main, /guarded\("profiles:delete-many", "delete"/);
});

test("profile editor keeps save actions visible below extended settings", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  assert.match(html, /<div class="testing-panel">[\s\S]*<div class="dialog-actions">[\s\S]*type="submit">Save profile<\/button>/);
  assert.match(css, /\.dialog-actions\s*\{[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*-28px;/);
  assert.match(css, /\.confirm-dialog \.dialog-actions \{ position: static;/);
});

test("profile editor exposes automatic identity read-only and no manual user agent input", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "src", "index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  assert.match(html, /id="automaticIdentity"[\s\S]*id="identityUserAgent"/);
  assert.doesNotMatch(html, /id="browserUserAgent"/);
  assert.doesNotMatch(renderer, /#browserUserAgent/);
  assert.match(renderer, /Boolean\(profile\?\.browserPolicy\?\.permissions\?\.geolocation\)/);
  assert.match(renderer, /identity\.latitude\.toFixed\(6\)/);
});

test("new profiles keep geolocation denied by default", () => {
  const renderer = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  assert.match(renderer, /#permGeolocation"\)\.checked = Boolean\(profile\?\.browserPolicy\?\.permissions\?\.geolocation\)/);
  assert.doesNotMatch(renderer, /#permGeolocation"\)\.checked = profile \?[^;]+: true/);
});

test("main generates automatic identity once using one isolated route session before metadata and launch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /if \(!launchProfile\.automaticIdentity\)[\s\S]*generateIdentityForProfile\(profile\)/);
  assert.match(source, /session\.fromPartition\(`identity-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(source, /requestPublicIp\(identitySession, proxy\)[\s\S]*https:\/\/ipwho\.is\/\$\{ip\}[\s\S]*session: identitySession/);
  assert.match(source, /api64\.ipify\.org/);
  assert.match(source, /persistGeneratedIdentity\([\s\S]*ensureProfileData:/);
  assert.ok(source.indexOf("persistGeneratedIdentity({", source.indexOf("async function openProfile")) < source.indexOf("launchProfileProcess(install.executable", source.indexOf("async function openProfile")));
  assert.match(source, /if \(activeProfileOperations\.has\(id\)\) throw new Error/);
  assert.match(source, /sameProxyConfig\(expected\.proxy, current\.proxy\)/);
  assert.match(source, /activeAutomaticIdentity: activeRoute\.automaticIdentity/);
  assert.match(source, /Object\.hasOwn\(runtime, "activeAutomaticIdentity"\)/);
});

test("main serializes Zalo startup to avoid concurrent Chromium process bursts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /let zaloLaunchQueue = Promise\.resolve\(\)/);
  assert.match(source, /function launchProfileProcess\([\s\S]*zaloLaunchQueue\.then\([\s\S]*launchZalo\([\s\S]*waitForProfileProcess\([\s\S]*setTimeout\(resolve, 1000\)[\s\S]*zaloLaunchQueue = operation\.catch/);
  assert.match(source, /const processInfo = await launchProfileProcess\(install\.executable, profile\.appDataId\)/);
});

test("compose keeps the account server private behind a trusted HTTPS proxy", () => {
  const compose = fs.readFileSync(path.join(__dirname, "..", "..", "account-server", "compose.yaml"), "utf8");
  assert.match(compose, /TRUST_PROXY:\s*["']?1/);
  assert.match(compose, /127\.0\.0\.1:8080:8080/);
});
