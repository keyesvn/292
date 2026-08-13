"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  isCallHelper,
  isCaptureHelper,
  isolateCallArguments,
  isolatePipe,
} = require("../src/zpool/zpool-helper");
const {
  AUTOMATIC_USER_AGENTS,
  IDENTITY_ACCURACY_METERS,
  IDENTITY_RADIUS_METERS,
  assertOwnedProfilePath,
  assertResolvedProxyRoute,
  decodeMeta,
  defaultBrowserPolicy,
  encodeMetaV2,
  distanceMeters,
  ensureProfileData,
  generateAutomaticIdentity,
  ipVersion,
  isGlobalIp,
  locateZaloInstall,
  metaPayload,
  nextAvailableAppDataId,
  parseAppDataId,
  parsePowerShellProcesses,
  patchBootstrap,
  processQueryScript,
  publicProfile,
  reconcileProfileRuntime,
  resolveZaloInstall,
  processesForAppDataId,
  rootProcessesForAppDataId,
  sameBrowserPolicy,
  sameAutomaticIdentity,
  sameLaunchConfig,
  sameProxyConfig,
  sanitizeBrowserPolicy,
  sanitizeProfile,
  sanitizeUserAgent,
  titleWatcherScript,
  validateGeoIpResponse,
} = require("../src/native-core");

function identityFixture(overrides = {}) {
  return {
    sourceIp: "8.8.8.8",
    ipVersion: 4,
    country: "United States",
    countryCode: "US",
    region: "California",
    city: "Mountain View",
    providerLatitude: 37.4056,
    providerLongitude: -122.0775,
    radiusMeters: IDENTITY_RADIUS_METERS,
    latitude: 37.4056,
    longitude: -122.0775,
    accuracyMeters: IDENTITY_ACCURACY_METERS,
    userAgent: AUTOMATIC_USER_AGENTS[0],
    generatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function writePeFixture(filePath) {
  const fixture = Buffer.alloc(128);
  fixture.write("MZ", 0, "ascii");
  fixture.writeUInt32LE(64, 0x3c);
  fixture.write("PE\0\0", 64, "binary");
  fixture.writeUInt16LE(0x8664, 68);
  fs.writeFileSync(filePath, fixture);
}

test("legacy-key V2 codec round-trips and uses the expected prefix", () => {
  const value = { id: "1001", proxyConfig: { enabled: true, password: "secret" } };
  const encoded = encodeMetaV2(value);
  assert.match(encoded, /^v2:/);
  assert.deepEqual(decodeMeta(encoded), value);
});

test("updating legacy metadata preserves cookies and unknown fields", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-meta-preserve-test-"));
  const dataPath = path.join(root, "ZaloData_1001");
  const metaPath = path.join(dataPath, "meta.bin");
  try {
    fs.mkdirSync(dataPath, { recursive: true });
    fs.writeFileSync(metaPath, encodeMetaV2({
      id: "1001",
      name: "Old",
      note: "old",
      proxyConfig: { enabled: false },
      cookies: "persist-me",
      futureField: { value: 1 },
    }));
    ensureProfileData(root, {
      appDataId: 1001,
      name: "New",
      note: "new",
      proxyPublicIp: "",
      proxy: { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "", password: "" },
    });
    const updated = decodeMeta(fs.readFileSync(metaPath, "utf8"));
    assert.equal(updated.name, "New");
    assert.equal(updated.cookies, "persist-me");
    assert.deepEqual(updated.futureField, { value: 1 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata carries the observed public proxy IP", () => {
  const profile = { appDataId: 1001, name: "Proxy", note: "", proxyPublicIp: "203.0.113.9", proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 8080, useAuthentication: false, username: "", password: "" } };
  assert.equal(require("../src/native-core").metaPayload(profile).proxyPublicIp, "203.0.113.9");
});

test("profile IDs are allocated and profile output never exposes password", () => {
  const first = sanitizeProfile({ name: "One", proxy: { enabled: true, host: "127.0.0.1", port: 8080, useAuthentication: true, username: "u", password: "p" } }, {}, 1000);
  assert.equal(first.appDataId, 1000);
  assert.equal(nextAvailableAppDataId([first]), 1001);
  assert.equal(nextAvailableAppDataId([first], 1000, [1001, 1002]), 1003);
  assert.equal("password" in publicProfile(first).proxy, false);
});

test("profile keeps public IP only while proxy identity is unchanged", () => {
  const existing = sanitizeProfile({ name: "One", proxy: { enabled: true, protocol: "http", host: "127.0.0.1", port: 8080 } }, {}, 1000);
  existing.proxyPublicIp = "203.0.113.9";
  const unchanged = sanitizeProfile({ name: "One", proxy: { ...existing.proxy, password: "" } }, existing, 1000);
  const changed = sanitizeProfile({ name: "One", proxy: { ...existing.proxy, host: "127.0.0.2", password: "" } }, existing, 1000);
  assert.equal(unchanged.proxyPublicIp, "203.0.113.9");
  assert.equal(changed.proxyPublicIp, "");
});

test("proxy identity includes active authentication credentials", () => {
  const active = { enabled: true, protocol: "http", host: "127.0.0.1", port: 8080, useAuthentication: true, username: "user", password: "old" };
  assert.equal(sameProxyConfig(active, { ...active, password: "new" }), false);
  assert.equal(sameProxyConfig({ enabled: false }, { enabled: false, host: "ignored", password: "ignored" }), true);
});

test("ownership rejects unregistered and nested paths", () => {
  assert.throws(() => assertOwnedProfilePath("C:\\AppData", "C:\\AppData\\ZaloData_1001", 1001, [1002]));
  assert.throws(() => assertOwnedProfilePath("C:\\AppData", "C:\\AppData\\ZaloData_1001\\nested", 1001, [1001]));
});

test("process matching requires exact numeric appdata ID", () => {
  assert.equal(parseAppDataId('"Zalo.exe" --appdata-id=1001'), 1001);
  assert.equal(parseAppDataId('Zalo.exe --appdata-id=10010'), 10010);
  const processes = parsePowerShellProcesses(JSON.stringify([
    { ProcessId: 11, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" },
    { ProcessId: 12, ParentProcessId: 11, CommandLine: "Zalo.exe --appdata-id=1001" },
    { ProcessId: 21, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1002" },
  ]));
  assert.deepEqual(rootProcessesForAppDataId(processes, 1001).map((item) => item.pid), [11]);
  assert.deepEqual(processesForAppDataId(processes, 1001).map((item) => item.pid), [11, 12]);
});

test("process matching can require the selected Zalo executable", () => {
  const bundled = "C:\\Program Files\\ZPool\\resources\\zalo-runtime\\Zalo-26.7.10\\Zalo.exe";
  const processes = [
    { pid: 11, parentPid: 0, appDataId: 1001, executablePath: bundled.toLowerCase() },
    { pid: 21, parentPid: 0, appDataId: 1001, executablePath: "C:\\Users\\User\\AppData\\Local\\Programs\\Zalo\\Zalo-26.7.10\\Zalo.exe" },
  ];
  assert.deepEqual(rootProcessesForAppDataId(processes, 1001, bundled).map((item) => item.pid), [11]);
});

test("managed process matching never widens an exact appdata ID", () => {
  const processes = [
    { pid: 11, parentPid: 0, appDataId: 1001 },
    { pid: 12, parentPid: 0, appDataId: 10010 },
    { pid: 13, parentPid: 0, appDataId: null },
  ];
  assert.deepEqual(processesForAppDataId(processes, 1001).map((item) => item.pid), [11]);
  assert.deepEqual(rootProcessesForAppDataId(processes, 1001).map((item) => item.pid), [11]);
});

test("runtime reconciliation clears profiles after Zalo exits", () => {
  const profiles = [{ id: "a", appDataId: 1001 }, { id: "b", appDataId: 1002 }];
  const runtime = new Map([
    ["a", { status: "running", pid: 11 }],
    ["b", { status: "restart-required", pid: 21 }],
  ]);
  assert.equal(reconcileProfileRuntime(runtime, profiles, []), true);
  assert.equal(runtime.size, 0);
});

test("runtime reconciliation preserves active transitions and discovers processes", () => {
  const profiles = [{ id: "a", appDataId: 1001 }, { id: "b", appDataId: 1002 }];
  const runtime = new Map([["a", { status: "starting" }]]);
  const processes = [{ pid: 21, parentPid: 0, appDataId: 1002 }];
  assert.equal(reconcileProfileRuntime(runtime, profiles, processes, new Set(["a"])), true);
  assert.deepEqual(runtime.get("a"), { status: "starting" });
  const bRuntime = runtime.get("b");
  assert.equal(bRuntime.status, "running");
  assert.equal(bRuntime.pid, 21);
  assert.ok("activeBrowserPolicy" in bRuntime);
});

test("bootstrap patch is marker-based and injects hooks before main", () => {
  const source = "require('./main-dist/migration'); if (app.requestSingleInstanceLock()) { require('./main-dist/main'); }";
  const patched = patchBootstrap(source);
  assert.match(patched, /zpool-app-init/);
  assert.ok(patched.indexOf("zpool-app-init") < patched.indexOf("zpool');"));
  assert.ok(patched.indexOf("main-dist/migration") < patched.indexOf("zpool-app-init"));
  assert.ok(patched.indexOf("zpool');") < patched.indexOf("main-dist/main"));
  assert.match(patched, /require\('\.\/zpool-app-init'\)/);
  assert.match(patched, /require\('\.\/zpool'\)/);
  assert.equal(patchBootstrap(patched), patched);
});

test("bootstrap patch migrates the blocking legacy zax V1 hook to synchronous Zpool V2", () => {
  const source = "require('./main-dist/migration'); /* ZALO_PROFILE_MANAGER_BOOTSTRAP_V1 */ require('./zax-app-init'); if (app.requestSingleInstanceLock()) { require('./zax').then(() => require('./main-dist/main')).catch((error) => { console.error('[zpm-hook] Startup blocked:', error); require('electron').app.exit(1); }); }";
  const patched = patchBootstrap(source);
  assert.match(patched, /ZALO_PROFILE_MANAGER_BOOTSTRAP_V2/);
  assert.doesNotMatch(patched, /\.then\(/);
  assert.ok(patched.indexOf("main-dist/migration") < patched.indexOf("zpool-app-init"));
  assert.ok(patched.indexOf("zpool-app-init") < patched.indexOf("zpool');"));
  assert.doesNotMatch(patched, /require\('\.\/zax(?:-app-init)?'\)/);
});

test("bootstrap patch replaces legacy zax V2 initialization with Zpool only", () => {
  const source = "require('./main-dist/migration'); /* ZALO_PROFILE_MANAGER_BOOTSTRAP_V2 */ require('./zax-app-init'); if (app.requestSingleInstanceLock()) { require('./zax'); require('./main-dist/main'); }";
  const patched = patchBootstrap(source);
  assert.ok(patched.indexOf("main-dist/migration") < patched.indexOf("zpool-app-init"));
  assert.ok(patched.indexOf("zpool-app-init") < patched.indexOf("zpool');"));
  assert.ok(patched.indexOf("zpool');") < patched.indexOf("main-dist/main"));
  assert.equal((patched.match(/zpool-app-init/g) || []).length, 1);
  assert.equal((patched.match(/require\('\.\/zpool'\)/g) || []).length, 1);
  assert.doesNotMatch(patched, /require\('\.\/zax(?:-app-init)?'\)/);
});

test("PowerShell process query uses encoded command and no shell concatenation", () => {
  assert.match(processQueryScript(1001), /1001/);
  assert.doesNotMatch(processQueryScript(1001), /;\s*Invoke/);
});

test("window title script targets every window for one exact appdata ID", () => {
  const script = titleWatcherScript(1001, "One | 203.0.113.9");
  assert.match(script, /Get-CimInstance Win32_Process/);
  assert.match(script, /MainWindowHandle/);
  assert.match(script, /1001\(\?:\\s\|\$\)/);
  assert.doesNotMatch(script, /Get-Process -Id 1001;/);
});

test("profile title contains only profile name and public route", () => {
  const title = require("../src/native-core").profileTitle({
    name: "One",
    proxyPublicIp: "203.0.113.9",
    proxy: { enabled: true, host: "127.0.0.1" },
  });
  assert.equal(title, "One | 203.0.113.9");
});

test("manager window close keeps profiles running but explicit quit enforces shutdown", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /managerWindow\.on\("close"[\s\S]*event\.preventDefault\(\)[\s\S]*managerWindow\.hide\(\)/);
  assert.match(source, /app\.on\("before-quit"[\s\S]*isQuitting = true[\s\S]*killManagedProfiles\(\)/);
});

test("second instance reuses the existing manager window without touching profiles", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.ok(source.indexOf("app.requestSingleInstanceLock()") < source.indexOf("app.whenReady()"));
  assert.match(source, /if \(managerWindow && !managerWindow\.isDestroyed\(\)\) \{\s*bringManagerWindowToForeground\(\);\s*return managerWindow;/);
  assert.match(source, /app\.on\("second-instance", \(\) => createManagerWindow\(\)\)/);
  assert.doesNotMatch(source, /app\.on\("second-instance"[^\n]*(?:openProfile|closeProfile|killManagedProfiles)\(/);
});

test("foreground helper restores a minimized manager before showing it", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /if \(managerWindow\.isMinimized\(\)\) managerWindow\.restore\(\);\s*managerWindow\.show\(\)/);
});

test("foreground helper shows, raises, and focuses a hidden manager window", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /managerWindow\.show\(\);\s*managerWindow\.setAlwaysOnTop\(true\);\s*managerWindow\.moveTop\(\);\s*managerWindow\.focus\(\)/);
});

test("foreground helper renews its timer and safely removes always-on-top", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /if \(managerForegroundTimer\) clearTimeout\(managerForegroundTimer\)/);
  assert.match(source, /managerForegroundTimer = setTimeout\(\(\) => \{\s*managerForegroundTimer = null;\s*if \(!window\.isDestroyed\(\)\) window\.setAlwaysOnTop\(false\);\s*\}, 1000\)/);
});

test("saving a running profile refreshes metadata with its active proxy", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /runtime\.status === "running" \|\| runtime\.status === "restart-required"/);
  assert.match(source, /proxy: runtime\.activeProxy \|\| existing\.proxy \|\| saved\.proxy/);
  assert.match(source, /ensureProfileData\(app\.getPath\("appData"\), activeProfile\)/);
  assert.match(source, /profileTitle\(activeProfile\)/);
});

test("opening an existing process reads its active route from metadata", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /const activeRoute = readActiveRoute\(profile\.appDataId\)/);
  assert.doesNotMatch(source, /if \(existing\.length > 0\)[\s\S]*?await refreshRuntimeOnce\(\)/);
  assert.match(source, /activeProxy: activeProfile\.proxy/);
});

test("lifecycle shutdown delegates process verification to killProfile", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const killBlock = source.match(/async function killManagedProfiles\(\) \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(killBlock, /await killProfile\(profile\.appDataId\)/);
  assert.doesNotMatch(killBlock, /queryZaloProcesses\(profile\.appDataId\)/);
});

test("update install starts only after managed shutdown succeeds", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const installBlock = source.match(/ipcMain\.handle\("update:install"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.ok(installBlock.indexOf("await killManagedProfiles()") < installBlock.indexOf("launchInstallerAfterExit(installer)"));
  assert.match(source, /Get-Process -Id \$targetPid[\s\S]*Start-Process -FilePath \$installer/);
  assert.doesNotMatch(installBlock, /spawn\(installer/);
});

test("before-quit calls app.quit only from the successful shutdown branch", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  const quitBlock = source.match(/app\.on\("before-quit"[\s\S]*?\n\}\);/)?.[0] || "";
  assert.match(quitBlock, /killManagedProfiles\(\)\.then\([\s\S]*app\.quit\(\)/);
  assert.match(quitBlock, /\.catch\([\s\S]*isQuitting = false/);
});

test("runtime preserves the active proxy separately from pending settings", () => {
  const runtime = new Map([["profile", { status: "restart-required", pid: 10, activeProxy: { enabled: false }, proxyPublicIp: "DIRECT" }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy: { enabled: true, host: "pending" }, proxyPublicIp: "pending" }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.deepEqual(runtime.get("profile").activeProxy, { enabled: false });
  assert.equal(runtime.get("profile").proxyPublicIp, "DIRECT");
});

test("runtime restores restart-required when active and pending proxies differ", () => {
  const activeProxy = { enabled: true, protocol: "http", host: "active", port: 80, useAuthentication: false, username: "" };
  const pendingProxy = { ...activeProxy, host: "pending" };
  assert.equal(sameProxyConfig(activeProxy, pendingProxy), false);
  const runtime = new Map();
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy: pendingProxy, activeProxy }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "restart-required");
  assert.deepEqual(runtime.get("profile").activeProxy, activeProxy);
});

test("runtime clears restart-required when pending settings match the active proxy", () => {
  const activeProxy = { enabled: true, protocol: "http", host: "active", port: 80, useAuthentication: true, username: "user", password: "secret" };
  const runtime = new Map([["profile", { status: "restart-required", pid: 10, activeProxy }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy: { ...activeProxy } }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "running");
});

test("runtime trusts metadata when the discovered Zalo root PID changes", () => {
  const oldProxy = { enabled: true, protocol: "http", host: "old", port: 80, useAuthentication: false, username: "" };
  const newProxy = { ...oldProxy, host: "new" };
  const runtime = new Map([["profile", { status: "running", pid: 10, activeProxy: oldProxy }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy: newProxy, activeProxy: newProxy }], [{ pid: 20, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").pid, 20);
  assert.deepEqual(runtime.get("profile").activeProxy, newProxy);
  assert.equal(runtime.get("profile").status, "running");
});

test("Zalo discovery selects the newest validated versioned installation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-install-test-"));
  try {
    for (const version of ["26.5.10", "26.6.11"]) {
      const versionRoot = path.join(root, "Programs", "Zalo", `Zalo-${version}`);
      fs.mkdirSync(path.join(versionRoot, "resources"), { recursive: true });
      fs.writeFileSync(path.join(versionRoot, "Zalo.exe"), "");
      fs.writeFileSync(path.join(versionRoot, "resources", "app.asar"), "");
    }
    const result = locateZaloInstall(root, "win32", () => ({ layout: "main-dist" }));
    assert.equal(result.version, "26.6.11");
    assert.match(result.archive, /Zalo-26\.6\.11[\\/]resources[\\/]app\.asar$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Zalo discovery accepts a newer installation when its archive is compatible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-install-current-test-"));
  try {
    const versionRoot = path.join(root, "Programs", "Zalo", "Zalo-26.7.10");
    fs.mkdirSync(path.join(versionRoot, "resources"), { recursive: true });
    fs.writeFileSync(path.join(versionRoot, "Zalo.exe"), "");
    fs.writeFileSync(path.join(versionRoot, "resources", "app.asar"), "");
    assert.equal(locateZaloInstall(root, "win32", () => ({ layout: "main-dist" })).version, "26.7.10");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release source discovery skips a newer candidate with an invalid PE", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-zalo-release-source-test-"));
  try {
    const installDir = path.join(root, "Programs", "Zalo");
    for (const version of ["26.7.10", "26.6.20"]) {
      const candidate = path.join(installDir, `Zalo-${version}`);
      fs.mkdirSync(path.join(candidate, "resources"), { recursive: true });
      fs.writeFileSync(path.join(candidate, "resources", "app.asar"), "fixture");
    }
    fs.writeFileSync(path.join(installDir, "Zalo-26.7.10", "Zalo.exe"), "MZ-only");
    writePeFixture(path.join(installDir, "Zalo-26.6.20", "Zalo.exe"));
    const result = locateZaloInstall(root, "win32", (archive) => ({
      layout: "main-dist",
      version: path.basename(path.dirname(path.dirname(archive))).slice("Zalo-".length),
    }), { validateExecutable: true, requireVersion: true });
    assert.equal(result.version, "26.6.20");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Zalo discovery falls back to older version when newest archive is incompatible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-install-fallback-test-"));
  try {
    for (const version of ["26.5.10", "26.6.11", "26.7.10"]) {
      const versionRoot = path.join(root, "Programs", "Zalo", `Zalo-${version}`);
      fs.mkdirSync(path.join(versionRoot, "resources"), { recursive: true });
      fs.writeFileSync(path.join(versionRoot, "Zalo.exe"), "");
      fs.writeFileSync(path.join(versionRoot, "resources", "app.asar"), "");
    }
    let callCount = 0;
    const inspect = (archive) => {
      callCount += 1;
      if (archive.includes("26.7.10")) throw new Error("ENOENT, not found in app.asar");
      return { layout: "main-dist" };
    };
    const result = locateZaloInstall(root, "win32", inspect);
    assert.equal(result.version, "26.6.11");
    assert.match(result.archive, /Zalo-26\.6\.11[\\\/]resources[\\\/]app\.asar$/);
    assert.ok(callCount >= 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Zalo discovery throws descriptive error when all versions are incompatible", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-install-none-test-"));
  try {
    for (const version of ["26.5.10", "26.7.10"]) {
      const versionRoot = path.join(root, "Programs", "Zalo", `Zalo-${version}`);
      fs.mkdirSync(path.join(versionRoot, "resources"), { recursive: true });
      fs.writeFileSync(path.join(versionRoot, "Zalo.exe"), "");
      fs.writeFileSync(path.join(versionRoot, "resources", "app.asar"), "");
    }
    const inspect = () => { throw new Error("incompatible"); };
    assert.throws(
      () => locateZaloInstall(root, "win32", inspect),
      (error) => {
        assert.match(error.message, /Không có phiên bản ZaloPC nào tương thích/);
        assert.match(error.message, /26\.7\.10: incompatible/);
        assert.match(error.message, /26\.5\.10: incompatible/);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packaged Zalo resolution prefers the validated bundled runtime", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-bundled-first-test-"));
  try {
    const resourcesPath = path.join(root, "resources");
    const runtimeRoot = path.join(resourcesPath, "zalo-runtime");
    const bundledRoot = path.join(runtimeRoot, "Zalo-26.7.10");
    const localRoot = path.join(root, "local", "Programs", "Zalo", "Zalo-26.7.10");
    for (const candidate of [bundledRoot, localRoot]) {
      fs.mkdirSync(path.join(candidate, "resources"), { recursive: true });
      writePeFixture(path.join(candidate, "Zalo.exe"));
      fs.writeFileSync(path.join(candidate, "resources", "app.asar"), "");
    }
    fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), JSON.stringify({ version: "26.7.10", directory: "Zalo-26.7.10" }));
    const result = resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({
      layout: "main-dist", version: "26.7.10", patched: true, hooksPresent: true,
    }));
    assert.equal(result.bundled, true);
    assert.equal(result.version, "26.7.10");
    assert.equal(result.root, bundledRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("development Zalo resolution falls back locally when no bundle exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-dev-fallback-test-"));
  try {
    const resourcesPath = path.join(root, "resources");
    const localRoot = path.join(root, "local", "Programs", "Zalo", "Zalo-26.7.10");
    fs.mkdirSync(path.join(localRoot, "resources"), { recursive: true });
    fs.writeFileSync(path.join(localRoot, "Zalo.exe"), "");
    fs.writeFileSync(path.join(localRoot, "resources", "app.asar"), "");
    const result = resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({ layout: "dist-main" }));
    assert.equal(result.bundled, false);
    assert.equal(result.version, "26.7.10");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a present but broken bundle blocks fallback to local Zalo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-broken-bundle-test-"));
  try {
    const resourcesPath = path.join(root, "resources");
    const runtimeRoot = path.join(resourcesPath, "zalo-runtime");
    const bundledRoot = path.join(runtimeRoot, "Zalo-26.7.10");
    const localRoot = path.join(root, "local", "Programs", "Zalo", "Zalo-26.7.10");
    fs.mkdirSync(path.join(bundledRoot, "resources"), { recursive: true });
    writePeFixture(path.join(bundledRoot, "Zalo.exe"));
    fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), JSON.stringify({ version: "26.7.10", directory: "Zalo-26.7.10" }));
    fs.mkdirSync(path.join(localRoot, "resources"), { recursive: true });
    fs.writeFileSync(path.join(localRoot, "Zalo.exe"), "");
    fs.writeFileSync(path.join(localRoot, "resources", "app.asar"), "");
    assert.throws(
      () => resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({ layout: "main-dist" })),
      /Runtime ZaloPC bundled không hợp lệ: thiếu archive/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("clean machine resolution reports the missing local installation when bundle is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-clean-machine-test-"));
  try {
    assert.throws(
      () => resolveZaloInstall(path.join(root, "resources"), path.join(root, "local"), "win32", () => ({ layout: "main-dist" })),
      /Không tìm thấy thư mục cài đặt Zalo/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("main resolves Zalo from process.resourcesPath", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /resolveZaloInstall\(process\.resourcesPath,[\s\S]*hookRoot\)/);
  assert.match(source, /const patchResult = install\.bundled[\s\S]*await ensurePatched/);
  assert.match(source, /status: !patchResult\.changed && sameLaunchConfig/);
  assert.doesNotMatch(source, /const install = locateZaloInstall\(\)/);
});

test("bundled Zalo resolution rejects invalid PE, wrong version and unpatched archives", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-bundle-validation-test-"));
  const resourcesPath = path.join(root, "resources");
  const runtimeRoot = path.join(resourcesPath, "zalo-runtime");
  const bundledRoot = path.join(runtimeRoot, "Zalo-26.7.10");
  const executable = path.join(bundledRoot, "Zalo.exe");
  try {
    fs.mkdirSync(path.join(bundledRoot, "resources"), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), JSON.stringify({ version: "26.7.10", directory: "Zalo-26.7.10" }));
    fs.writeFileSync(executable, "bad executable");
    fs.writeFileSync(path.join(bundledRoot, "resources", "app.asar"), "fixture");
    assert.throws(
      () => resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({
        layout: "main-dist", version: "26.7.10", patched: true, hooksPresent: true,
      })),
      /regular file PE hợp lệ/
    );
    writePeFixture(executable);
    assert.throws(
      () => resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({
        layout: "main-dist", version: "26.7.9", patched: true, hooksPresent: true,
      })),
      /archive sai phiên bản/
    );
    assert.throws(
      () => resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", () => ({
        layout: "main-dist", version: "26.7.10", patched: false, hooksPresent: false,
      })),
      /archive chưa có bootstrap\/hook Zpool/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled Zalo resolution requires a matching fail-closed manifest", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-bundle-manifest-test-"));
  const resourcesPath = path.join(root, "resources");
  const runtimeRoot = path.join(resourcesPath, "zalo-runtime");
  const bundledRoot = path.join(runtimeRoot, "Zalo-26.7.10");
  try {
    fs.mkdirSync(path.join(bundledRoot, "resources"), { recursive: true });
    writePeFixture(path.join(bundledRoot, "Zalo.exe"));
    fs.writeFileSync(path.join(bundledRoot, "resources", "app.asar"), "fixture");
    assert.throws(() => resolveZaloInstall(resourcesPath, "missing", "win32", () => ({})), /manifest không đọc được/);
    fs.writeFileSync(path.join(runtimeRoot, "manifest.json"), JSON.stringify({ version: "26.7.9", directory: "Zalo-26.7.9" }));
    assert.throws(() => resolveZaloInstall(resourcesPath, "missing", "win32", () => ({})), /manifest không khớp runtime versioned duy nhất/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("call helpers receive the same per-instance pipe suffix as listening servers", () => {
  const suffix = "123456";
  assert.equal(isCallHelper("C:\\Zalo\\ZaloCall.exe"), true);
  assert.equal(isCallHelper("C:\\Zalo\\ZaviMeet.exe"), true);
  assert.equal(isCaptureHelper("C:\\Zalo\\ZaloCap.exe"), true);
  assert.equal(isolatePipe("\\\\.\\pipe\\PipeZCallSend", suffix), "\\\\.\\pipe\\PipeZCallSend123456");
  assert.deepEqual(
    isolateCallArguments("ZaloCall.exe", ["PipeZCallRecv3", "unchanged"], suffix),
    ["PipeZCallRecv3123456", "unchanged"]
  );
  assert.deepEqual(isolateCallArguments("other.exe", ["PipeZCallSend"], suffix), ["PipeZCallSend"]);
});

// --- browser policy ---

test("browser policy defaults to deny all permissions and empty user agent", () => {
  const profile = sanitizeProfile({ name: "Test", proxy: { enabled: false, protocol: "http", host: "", port: "" } }, {}, 1001);
  assert.equal(profile.browserPolicy.permissions.geolocation, false);
  assert.equal(profile.browserPolicy.permissions.camera, false);
  assert.equal(profile.browserPolicy.permissions.microphone, false);
  assert.equal(profile.browserPolicy.permissions.notifications, false);
  assert.equal(profile.browserPolicy.userAgent, "");
});

test("sanitizeBrowserPolicy preserves individual permission flags", () => {
  const bp = sanitizeBrowserPolicy({ permissions: { geolocation: true, camera: false, microphone: true, notifications: false }, userAgent: "" });
  assert.equal(bp.permissions.geolocation, true);
  assert.equal(bp.permissions.camera, false);
  assert.equal(bp.permissions.microphone, true);
  assert.equal(bp.permissions.notifications, false);
});

test("sanitizeUserAgent accepts exactly 512 characters", () => {
  const ua = "A".repeat(512);
  assert.equal(sanitizeUserAgent(ua).length, 512);
});

test("sanitizeUserAgent rejects strings longer than 512 characters", () => {
  assert.throws(() => sanitizeUserAgent("A".repeat(513)), /512/);
});

test("sanitizeUserAgent rejects CR, LF, NUL and other C0 control characters", () => {
  for (const char of ["\r", "\n", "\u0000", "\u0001", "\u001f", "\u007f"]) {
    assert.throws(() => sanitizeUserAgent(`valid${char}ua`), /điều khiển/);
  }
});

test("sanitizeUserAgent trims whitespace but preserves inner content", () => {
  assert.equal(sanitizeUserAgent("  Mozilla/5.0  "), "Mozilla/5.0");
});

test("sanitizeUserAgent returns empty string for non-string input", () => {
  assert.equal(sanitizeUserAgent(null), "");
  assert.equal(sanitizeUserAgent(undefined), "");
  assert.equal(sanitizeUserAgent(42), "");
});

test("metaPayload includes browserPolicy field", () => {
  const profile = {
    appDataId: 1001, name: "Test", note: "", proxyPublicIp: "",
    proxy: { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "", password: "" },
    browserPolicy: { permissions: { geolocation: true, camera: false, microphone: false, notifications: false }, userAgent: "TestUA/1.0" },
  };
  const payload = metaPayload(profile);
  assert.equal(payload.browserPolicy.permissions.geolocation, true);
  assert.equal(payload.browserPolicy.permissions.camera, false);
  assert.equal(payload.browserPolicy.userAgent, "TestUA/1.0");
});

test("metaPayload uses default deny when browserPolicy is absent", () => {
  const profile = {
    appDataId: 1001, name: "Test", note: "", proxyPublicIp: "",
    proxy: { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "", password: "" },
  };
  const payload = metaPayload(profile);
  assert.deepEqual(payload.browserPolicy.permissions, defaultBrowserPolicy().permissions);
  assert.equal(payload.browserPolicy.userAgent, "");
});

test("sameBrowserPolicy detects changes in each permission field", () => {
  const base = defaultBrowserPolicy();
  for (const key of ["geolocation", "camera", "microphone", "notifications"]) {
    const changed = { ...base, permissions: { ...base.permissions, [key]: true } };
    assert.equal(sameBrowserPolicy(base, changed), false, `should detect change in ${key}`);
  }
  assert.equal(sameBrowserPolicy(base, base), true);
});

test("sameBrowserPolicy detects user agent change", () => {
  const a = { permissions: defaultBrowserPolicy().permissions, userAgent: "UA1" };
  const b = { permissions: defaultBrowserPolicy().permissions, userAgent: "UA2" };
  assert.equal(sameBrowserPolicy(a, b), false);
  assert.equal(sameBrowserPolicy(a, a), true);
});

test("sameLaunchConfig detects proxy change", () => {
  const proxy1 = { enabled: true, protocol: "http", host: "a", port: 80, useAuthentication: false, username: "" };
  const proxy2 = { ...proxy1, host: "b" };
  const bp = defaultBrowserPolicy();
  assert.equal(sameLaunchConfig({ proxy: proxy1, browserPolicy: bp }, { proxy: proxy2, browserPolicy: bp }), false);
  assert.equal(sameLaunchConfig({ proxy: proxy1, browserPolicy: bp }, { proxy: proxy1, browserPolicy: bp }), true);
});

test("sameLaunchConfig detects browser policy change independently of proxy", () => {
  const proxy = { enabled: false };
  const bp1 = defaultBrowserPolicy();
  const bp2 = { ...bp1, permissions: { ...bp1.permissions, camera: true } };
  assert.equal(sameLaunchConfig({ proxy, browserPolicy: bp1 }, { proxy, browserPolicy: bp2 }), false);
});

test("runtime sets restart-required when only browser policy changes", () => {
  const proxy = { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "" };
  const activeBrowserPolicy = defaultBrowserPolicy();
  const pendingBrowserPolicy = { ...activeBrowserPolicy, permissions: { ...activeBrowserPolicy.permissions, geolocation: true } };
  const runtime = new Map([["profile", { status: "running", pid: 10, activeProxy: proxy, activeBrowserPolicy }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy, browserPolicy: pendingBrowserPolicy, activeBrowserPolicy }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "restart-required");
});

test("runtime sets restart-required when only user agent changes", () => {
  const proxy = { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "" };
  const activeBrowserPolicy = { permissions: defaultBrowserPolicy().permissions, userAgent: "UA1" };
  const pendingBrowserPolicy = { ...activeBrowserPolicy, userAgent: "UA2" };
  const runtime = new Map([["profile", { status: "running", pid: 10, activeProxy: proxy, activeBrowserPolicy }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy, browserPolicy: pendingBrowserPolicy, activeBrowserPolicy }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "restart-required");
});

test("runtime clears restart-required when policy and proxy both match", () => {
  const proxy = { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "" };
  const bp = defaultBrowserPolicy();
  const runtime = new Map([["profile", { status: "restart-required", pid: 10, activeProxy: proxy, activeBrowserPolicy: bp }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy, browserPolicy: bp, activeBrowserPolicy: bp }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "running");
});

test("runtime preserves active browser policy separately from pending", () => {
  const proxy = { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "" };
  const activeBrowserPolicy = defaultBrowserPolicy();
  const pendingBrowserPolicy = { ...activeBrowserPolicy, permissions: { ...activeBrowserPolicy.permissions, camera: true } };
  const runtime = new Map([["profile", { status: "running", pid: 10, activeProxy: proxy, activeBrowserPolicy }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy, browserPolicy: pendingBrowserPolicy, activeBrowserPolicy }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").activeBrowserPolicy.permissions.camera, false);
});

test("automatic identity accepts global IPv4 and IPv6 and rejects non-global addresses", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) assert.equal(isGlobalIp(ip), true, ip);
  for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.1.1", "192.168.1.1", "203.0.113.1", "::1", "fe80::1", "fc00::1", "2001:db8::1", "malformed"]) assert.equal(isGlobalIp(ip), false, ip);
  assert.equal(ipVersion("8.8.8.8"), 4);
  assert.equal(ipVersion("2606:4700:4700::1111"), 6);
});

test("global IPv6 classifier rejects special-purpose embedded and allocation ranges", () => {
  const cases = [
    ["::8.8.8.8", false],
    ["::192.168.1.1", false],
    ["::ffff:8.8.8.8", true],
    ["::ffff:192.168.1.1", false],
    ["100::", false],
    ["100::ffff:ffff:ffff:ffff", false],
    ["2001:2::1", false],
    ["2001:10::1", false],
    ["2001:20::1", false],
    ["2001:4860:4860::8888", true],
  ];
  for (const [ip, expected] of cases) assert.equal(isGlobalIp(ip), expected, ip);
});

test("resolved proxy route must be exact with no DIRECT fallback", () => {
  assert.equal(assertResolvedProxyRoute("DIRECT", { enabled: false }), "DIRECT");
  assert.throws(() => assertResolvedProxyRoute("DIRECT; PROXY 127.0.0.1:8080", { enabled: false }), /DIRECT/);
  assert.equal(assertResolvedProxyRoute("PROXY proxy.example:8080", { enabled: true, protocol: "http", host: "proxy.example", port: 8080 }), "PROXY proxy.example:8080");
  assert.equal(assertResolvedProxyRoute("HTTPS proxy.example:8443", { enabled: true, protocol: "https", host: "proxy.example", port: 8443 }), "HTTPS proxy.example:8443");
  assert.equal(assertResolvedProxyRoute("SOCKS proxy.example:1080", { enabled: true, protocol: "socks5", host: "proxy.example", port: 1080 }), "SOCKS proxy.example:1080");
  assert.equal(assertResolvedProxyRoute("SOCKS4 proxy.example:1080", { enabled: true, protocol: "socks4", host: "proxy.example", port: 1080 }), "SOCKS4 proxy.example:1080");
  assert.throws(() => assertResolvedProxyRoute("PROXY proxy.example:8080; DIRECT", { enabled: true, protocol: "http", host: "proxy.example", port: 8080 }), /fallback/);
  assert.throws(() => assertResolvedProxyRoute("PROXY other.example:8080", { enabled: true, protocol: "http", host: "proxy.example", port: 8080 }), /endpoint/);
  assert.throws(() => assertResolvedProxyRoute("SOCKS proxy.example:8080", { enabled: true, protocol: "http", host: "proxy.example", port: 8080 }), /loại proxy/);
});

test("automatic identity generation validates provider IP/type and bounded coordinates", () => {
  const response = {
    success: true,
    ip: "8.8.8.8",
    type: "IPv4",
    country: "United States",
    country_code: "US",
    region: "California",
    city: "Mountain View",
    latitude: 37.4056,
    longitude: -122.0775,
  };
  const bytes = [Buffer.alloc(6), Buffer.alloc(6, 0xff), Buffer.alloc(6)];
  const identity = generateAutomaticIdentity("8.8.8.8", response, {
    randomBytes: () => bytes.shift(),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.ok(distanceMeters(response.latitude, response.longitude, identity.latitude, identity.longitude) <= IDENTITY_RADIUS_METERS);
  assert.equal(identity.accuracyMeters, IDENTITY_ACCURACY_METERS);
  assert.ok(AUTOMATIC_USER_AGENTS.includes(identity.userAgent));
  assert.throws(() => generateAutomaticIdentity("8.8.8.8", { ...response, success: false }), /từ chối/);
  assert.throws(() => generateAutomaticIdentity("8.8.8.8", { ...response, ip: "1.1.1.1" }), /không khớp/);
  assert.throws(() => generateAutomaticIdentity("8.8.8.8", { ...response, type: "IPv6" }), /không khớp/);
  assert.throws(() => generateAutomaticIdentity("8.8.8.8", { ...response, latitude: null }), /Latitude/);
});

test("GeoIP accepts equivalent compressed IPv6 provider notation", () => {
  const response = {
    success: true,
    ip: "2001:4860:4860::8888",
    type: "IPv6",
    country: "United States",
    country_code: "US",
    region: "California",
    city: "Mountain View",
    latitude: 37.386,
    longitude: -122.0838,
  };
  assert.equal(validateGeoIpResponse("2001:4860:4860:0:0:0:0:8888", response).countryCode, "US");
});

test("renderer profile input cannot create, replace, or remove automatic identity", () => {
  const existing = sanitizeProfile({ name: "One", proxy: { enabled: false } }, {}, 1000);
  existing.automaticIdentity = identityFixture();
  const replaced = sanitizeProfile({ name: "One", proxy: { enabled: false }, automaticIdentity: identityFixture({ sourceIp: "1.1.1.1" }) }, existing, 1000);
  assert.deepEqual(replaced.automaticIdentity, existing.automaticIdentity);
  const newProfile = sanitizeProfile({ name: "Two", proxy: { enabled: false }, automaticIdentity: identityFixture() }, {}, 1001);
  assert.equal(newProfile.automaticIdentity, undefined);
});

test("metadata and public projection carry the complete immutable identity", () => {
  const automaticIdentity = identityFixture();
  const profile = { appDataId: 1001, name: "One", note: "", proxy: { enabled: false }, automaticIdentity };
  assert.deepEqual(metaPayload(profile).automaticIdentity, automaticIdentity);
  assert.deepEqual(publicProfile(profile).automaticIdentity, automaticIdentity);
  assert.equal(sameAutomaticIdentity(automaticIdentity, { ...automaticIdentity }), true);
  assert.equal(sameAutomaticIdentity(automaticIdentity, { ...automaticIdentity, sourceIp: "1.1.1.1" }), false);
});

test("runtime preserves active identity and requires restart when pending identity differs", () => {
  const proxy = { enabled: false };
  const browserPolicy = defaultBrowserPolicy();
  const activeAutomaticIdentity = identityFixture();
  const pendingAutomaticIdentity = identityFixture({ sourceIp: "1.1.1.1", generatedAt: "2026-08-02T00:00:00.000Z" });
  const runtime = new Map([["profile", { status: "running", pid: 10, activeProxy: proxy, activeBrowserPolicy: browserPolicy, activeAutomaticIdentity }]]);
  reconcileProfileRuntime(runtime, [{ id: "profile", appDataId: 1001, proxy, browserPolicy, automaticIdentity: pendingAutomaticIdentity }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").status, "restart-required");
  assert.deepEqual(runtime.get("profile").activeAutomaticIdentity, activeAutomaticIdentity);
});

test("runtime preserves explicit active identity null from metadata", () => {
  const proxy = { enabled: false };
  const browserPolicy = defaultBrowserPolicy();
  const runtime = new Map();
  reconcileProfileRuntime(runtime, [{
    id: "profile",
    appDataId: 1001,
    proxy,
    browserPolicy,
    automaticIdentity: identityFixture(),
    activeProxy: proxy,
    activeBrowserPolicy: browserPolicy,
    activeAutomaticIdentity: null,
  }], [{ pid: 10, parentPid: 0, appDataId: 1001 }]);
  assert.equal(runtime.get("profile").activeAutomaticIdentity, null);
  assert.equal(runtime.get("profile").status, "restart-required");
});
