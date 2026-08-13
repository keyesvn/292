"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const vm = require("node:vm");
const asar = require("@electron/asar");
const electron = require("electron");
const afterPack = require("../scripts/after-pack");

function writePeFixture(filePath) {
  const fixture = Buffer.alloc(128);
  fixture.write("MZ", 0, "ascii");
  fixture.writeUInt32LE(64, 0x3c);
  fixture.write("PE\0\0", 64, "binary");
  fixture.writeUInt16LE(0x8664, 68);
  fs.writeFileSync(filePath, fixture);
}
const { decodeMeta, defaultBrowserPolicy, encodeMetaV2 } = require("../src/native-core");
const {
  ensurePatched,
  ensureProfileData,
  inspectArchive,
  killProfile,
  launchZalo,
  resolveZaloInstall,
  watchWindowTitle,
} = require("../src/native-core");

const execFileAsync = promisify(execFile);

test("profile metadata is written only inside a temp appdata root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-meta-test-"));
  try {
    const profile = { appDataId: 1001, name: "Test", note: "", proxy: { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "", password: "" } };
    const result = ensureProfileData(root, profile);
    assert.equal(path.dirname(result.dataPath), root);
    assert.equal(decodeMeta(fs.readFileSync(result.metaPath, "utf8")).id, "1001");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("launch uses an argument array and detached process", () => {
  let call;
  const pid = launchZalo("C:\\Zalo\\Zalo.exe", 1001, (command, args, options) => {
    call = { command, args, options, unref: false };
    return { pid: 77, unref() { call.unref = true; } };
  });
  assert.equal(pid, 77);
  assert.deepEqual(call.args, ["--appdata-id=1001"]);
  assert.equal(call.options.detached, true);
  assert.equal(call.unref, true);
});

test("kill targets only the exact profile root PID", async () => {
  const calls = [];
  let queryCount = 0;
  const runner = async (command, args) => {
    calls.push({ command, args });
    if (command === "powershell.exe") {
      queryCount += 1;
      return { stdout: queryCount === 1 ? JSON.stringify([
        { ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" },
        { ProcessId: 42, ParentProcessId: 41, CommandLine: "Zalo.exe --appdata-id=1001" },
        { ProcessId: 51, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=10010" },
      ]) : "" };
    }
    return { stdout: "" };
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
  assert.deepEqual(calls[1], { command: "taskkill.exe", args: ["/F", "/T", "/PID", "41"] });
});

test("kill is idempotent when the profile has no process", async () => {
  const calls = [];
  const runner = async (command) => { calls.push(command); return { stdout: "" }; };
  assert.equal(await killProfile(1001, runner), false);
  assert.deepEqual(calls, ["powershell.exe"]);
});

test("kill succeeds when taskkill fails but the profile disappears", async () => {
  let queryCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      return { stdout: queryCount === 1 ? JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) : "" };
    }
    throw new Error("There is no running instance of the task");
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
});

test("kill refreshes the root PID when the parent changes", async () => {
  const killPids = [];
  let queryCount = 0;
  const snapshots = [
    [
      { ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" },
      { ProcessId: 91, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=10010" },
    ],
    [
      { ProcessId: 51, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" },
      { ProcessId: 91, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=10010" },
    ],
    [],
  ];
  const runner = async (command, args) => {
    if (command === "powershell.exe") return { stdout: JSON.stringify(snapshots[queryCount++] || []) };
    killPids.push(args.at(-1));
    if (killPids.length === 1) throw new Error("Access is denied");
    return { stdout: "" };
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
  assert.deepEqual(killPids, ["41", "51"]);
  assert.equal(killPids.includes("91"), false);
});

test("kill retries a temporary access denial", async () => {
  let queryCount = 0;
  let taskkillCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      return { stdout: queryCount < 3 ? JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) : "" };
    }
    taskkillCount += 1;
    if (taskkillCount === 1) throw new Error("Access is denied");
    return { stdout: "" };
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
  assert.equal(taskkillCount, 2);
});

test("kill reports live PIDs and the last terminate error after retry exhaustion", async () => {
  let taskkillCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") return { stdout: JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) };
    taskkillCount += 1;
    throw new Error(taskkillCount === 1 ? "Access is denied" : "terminate denied again");
  };
  await assert.rejects(
    killProfile(1001, runner, { maxAttempts: 2, delay: async () => {} }),
    (error) => error.message.includes("PID còn sống: 41") && error.message.includes("terminate denied again")
  );
  assert.equal(taskkillCount, 2);
});

test("kill terminates every orphan root in one verified snapshot", async () => {
  const killPids = [];
  let queryCount = 0;
  const runner = async (command, args) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      return { stdout: queryCount === 1 ? JSON.stringify([
        { ProcessId: 41, ParentProcessId: 999, CommandLine: "Zalo.exe --appdata-id=1001" },
        { ProcessId: 42, ParentProcessId: 999, CommandLine: "Zalo.exe --appdata-id=1001" },
      ]) : "" };
    }
    killPids.push(args.at(-1));
    return { stdout: "" };
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
  assert.deepEqual(killPids, ["41", "42"]);
});

test("kill retries a transient CIM query failure", async () => {
  let queryCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      if (queryCount === 1) throw new Error("CIM unavailable");
      return { stdout: queryCount === 2 ? JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) : "" };
    }
    return { stdout: "" };
  };
  assert.equal(await killProfile(1001, runner, { delay: async () => {} }), true);
  assert.equal(queryCount, 3);
});

test("kill fails clearly when CIM query remains unavailable", async () => {
  let queryCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      throw new Error("CIM unavailable");
    }
    throw new Error("must not terminate without a verified snapshot");
  };
  await assert.rejects(
    killProfile(1001, runner, { maxQueryAttempts: 2, delay: async () => {} }),
    /Không thể xác minh process profile qua CIM sau 2 lần thử: CIM unavailable/
  );
  assert.equal(queryCount, 2);
});

test("kill does not assume success when post-terminate CIM verification keeps failing", async () => {
  let queryCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      queryCount += 1;
      if (queryCount === 1) return { stdout: JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) };
      throw new Error("CIM verification unavailable");
    }
    return { stdout: "" };
  };
  await assert.rejects(
    killProfile(1001, runner, { maxQueryAttempts: 2, delay: async () => {} }),
    (error) => error.message.includes("PID đã biết còn sống: 41") && error.message.includes("CIM verification unavailable")
  );
  assert.equal(queryCount, 3);
});

test("kill waits between terminate and verification and retry", async () => {
  const events = [];
  let queryCount = 0;
  const runner = async (command) => {
    if (command === "powershell.exe") {
      events.push("query");
      queryCount += 1;
      return { stdout: queryCount < 3 ? JSON.stringify({ ProcessId: 41, ParentProcessId: 0, CommandLine: "Zalo.exe --appdata-id=1001" }) : "" };
    }
    events.push("kill");
    throw new Error("Access is denied");
  };
  assert.equal(await killProfile(1001, runner, {
    maxAttempts: 2,
    delay: async () => { events.push("delay"); },
  }), true);
  assert.deepEqual(events, ["query", "kill", "delay", "query", "kill", "delay", "query"]);
});

test("window title watcher retries and remains fail-soft", async () => {
  let attempts = 0;
  const result = await watchWindowTitle(77, "Test | DIRECT | Zalo", {
    attempts: 3,
    intervalMs: 1,
    update: async () => { attempts += 1; return attempts === 3; },
  });
  assert.equal(result, true);
  assert.equal(attempts, 3);
});

test("activity uses HH:mm - dd/MM/yyyy order", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "renderer.js"), "utf8");
  const match = source.match(/function activityTime\(value\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  const activityTime = vm.runInNewContext(`(${match[0]})`);
  assert.equal(activityTime("2026-07-30T17:05:00.000Z"), "00:05 - 31/07/2026");
  assert.equal(activityTime(null), "Chưa từng mở");
  assert.equal(activityTime("invalid"), "Không xác định");
});

test("Zpool hook injects the visible title into Zalo's renderer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  assert.match(source, /web-contents-created/);
  assert.match(source, /executeJavaScript/);
  assert.match(source, /#titleBar \.title-name/);
  assert.doesNotMatch(source, /#titleBar #aboutMe\.titlebar__menu/);
  assert.match(source, /titleHost\.childNodes/);
  assert.match(source, /Node\.TEXT_NODE/);
  assert.match(source, /textNode\.nodeValue = activeTitle/);
  assert.doesNotMatch(source, /removeProperty\("display"\)/);
  assert.doesNotMatch(source, /setProperty\("pointer-events"/);
  assert.doesNotMatch(source, /setProperty\("font-size"/);
  assert.doesNotMatch(source, /setProperty\("overflow"/);
  assert.doesNotMatch(source, /setProperty\("white-space"/);
  assert.doesNotMatch(source, /position: "fixed"/);
  assert.doesNotMatch(source, /document\.body\.appendChild/);
  assert.match(source, /\.login-title-bar/);
  assert.match(source, /zaloTitle \|\| loginTitle/);
  assert.doesNotMatch(source, /font-size:12px/);
  assert.match(source, /document\.title = activeTitle/);
  assert.match(source, /did-navigate-in-page/);
  assert.match(source, /const nativeSetTitle = window\.setTitle\.bind\(window\)/);
  assert.match(source, /window\.webContents\.on\("page-title-updated", applyTitle\)/);
  assert.match(source, /MutationObserver/);
  assert.match(source, /decodeURIComponent\(Buffer\.from\(value, "base64"\)/);
});

test("archive patch creates a checksum backup and verifiable hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  fs.mkdirSync(path.join(source, "dist-main"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./dist-main/migration'); if(app.requestSingleInstanceLock()){require('./dist-main/main');}");
  fs.writeFileSync(path.join(source, "dist-main", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "dist-main", "migration.js"), "module.exports = {};");
  await asar.createPackage(source, archive);
  try {
    const result = await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"));
    assert.equal(result.changed, true);
    assert.equal(fs.existsSync(result.backup), true);
    assert.match(path.basename(result.backup), /^app\.zpm-backup-[0-9a-f]{16}\.asar$/);
    assert.doesNotMatch(result.backup, /app\.asar[\\/\.]/);
    assert.equal(inspectArchive(archive).patched, true);
    const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
    assert.equal(entries.includes("zpool-helper.js"), true);
    assert.ok(asar.extractFile(archive, "zpool-helper.js").length > 0);
    assert.equal((await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"))).changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch follows the main-dist layout used by current ZaloPC", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-main-dist-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  await asar.createPackage(source, archive);
  try {
    await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"));
    const info = inspectArchive(archive);
    const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
    assert.equal(info.layout, "main-dist");
    assert.equal(info.patched, true);
    assert.equal(entries.includes("zpool-helper.js"), true);
    assert.ok(asar.extractFile(archive, "zpool-helper.js").length > 0);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch removes legacy zax hooks and leaves only Zpool bootstrap hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-zax-migration-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  const hookRoot = path.join(__dirname, "..", "src", "zpool");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "26.7.10", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); /* ZALO_PROFILE_MANAGER_BOOTSTRAP_V2 */ require('./zax-app-init'); if(app.requestSingleInstanceLock()){require('./zax'); require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zax-app-init.js", "zax-helper.js", "zax.js"]) fs.writeFileSync(path.join(source, name), `legacy-${name}`);
  await asar.createPackage(source, archive);
  try {
    const result = await ensurePatched(archive, hookRoot);
    const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
    const bootstrap = asar.extractFile(archive, "bootstrap.js").toString("utf8");
    assert.equal(result.changed, true);
    assert.equal(inspectArchive(archive).patched, true);
    for (const name of ["zax-app-init.js", "zax-helper.js", "zax.js"]) assert.equal(entries.includes(name), false, name);
    for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) assert.equal(entries.includes(name), true, name);
    assert.doesNotMatch(bootstrap, /require\((['"])\.\/zax(?:-app-init)?\1\)/);
    assert.equal((bootstrap.match(/require\('\.\/zpool-app-init'\)/g) || []).length, 1);
    assert.equal((bootstrap.match(/require\('\.\/zpool'\)/g) || []).length, 1);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive inspection rejects marker and hooks without valid bootstrap requires", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-invalid-bootstrap-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); /* ZALO_PROFILE_MANAGER_BOOTSTRAP_V2 */ if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(source, name), name);
  await asar.createPackage(source, archive);
  try {
    assert.equal(inspectArchive(archive).patched, false);
    const result = await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"));
    assert.equal(result.changed, true);
    assert.equal(inspectArchive(archive).patched, true);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch removes nested legacy zax hook files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-nested-zax-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  const legacyRoot = path.join(source, "main-dist", "assets", "js", "main");
  fs.mkdirSync(legacyRoot, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); /* ZALO_PROFILE_MANAGER_BOOTSTRAP_V2 */ require('./main-dist/assets/js/main/zax-app-init'); if(app.requestSingleInstanceLock()){require('./main-dist/assets/js/main/zax'); require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zax-app-init.js", "zax-helper.js", "zax.js"]) fs.writeFileSync(path.join(legacyRoot, name), name);
  await asar.createPackage(source, archive);
  try {
    assert.equal(inspectArchive(archive).legacyHooksPresent, true);
    await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"));
    const entries = asar.listPackage(archive).map((entry) => entry.replaceAll("\\", "/").replace(/^\//, ""));
    assert.equal(entries.some((entry) => /(^|\/)zax(?:-app-init|-helper)?\.js$/.test(entry)), false);
    assert.equal(inspectArchive(archive).patched, true);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch preserves exact unpacked native metadata and payload", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-asar-unpacked-native-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "app.asar");
  const nativeRelative = path.join("native", "nested", "fixture.node");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(path.join(source, "native", "nested"), { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, nativeRelative), "native-payload");
  await asar.createPackageWithOptions(source, archive, { unpackDir: "native" });
  const unpackedFile = path.join(`${archive}.unpacked`, nativeRelative);
  const beforeHash = require("../src/native-core").sha256File(unpackedFile);
  try {
    assert.equal(asar.statFile(archive, path.join("native", "nested", "fixture.node")).unpacked, true);
    await ensurePatched(archive, path.join(__dirname, "..", "src", "zpool"));
    assert.equal(asar.statFile(archive, path.join("native")).unpacked, true);
    assert.equal(asar.statFile(archive, path.join("native", "nested", "fixture.node")).unpacked, true);
    assert.equal(require("../src/native-core").sha256File(unpackedFile), beforeHash);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch refreshes changed hook files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-hook-refresh-test-"));
  const source = path.join(root, "source");
  const hooks = path.join(root, "hooks");
  const archive = path.join(root, "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "1.2.3", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(hooks, name), `first-${name}`);
  await asar.createPackage(source, archive);
  try {
    await ensurePatched(archive, hooks);
    fs.writeFileSync(path.join(hooks, "zpool.js"), "second-zpool.js");
    const result = await ensurePatched(archive, hooks);
    assert.equal(result.changed, true);
    assert.equal(asar.extractFile(archive, "zpool.js").toString(), "second-zpool.js");
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch reads packaged hooks from app.asar.unpacked", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-unpacked-hooks-test-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "target.asar");
  const packedHookRoot = path.join(root, "resources", "app.asar", "src", "zpool");
  const unpackedHookRoot = path.join(root, "resources", "app.asar.unpacked", "src", "zpool");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(unpackedHookRoot, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "26.7.10", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(unpackedHookRoot, name), `unpacked-${name}`);
  await asar.createPackage(source, archive);
  try {
    const result = await ensurePatched(archive, packedHookRoot);
    assert.equal(result.changed, true);
    assert.equal(asar.extractFile(archive, "zpool.js").toString(), "unpacked-zpool.js");
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("archive patch treats an external app.asar as a raw file under Electron", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-electron-asar-test-"));
  const source = path.join(root, "source");
  const hooks = path.join(root, "hooks");
  const archive = path.join(root, "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "fixture", version: "26.7.10", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(hooks, name), name);
  await asar.createPackage(source, archive);
  try {
    const fixture = path.join(__dirname, "fixtures", "electron-asar-patch.js");
    const { stdout } = await execFileAsync(electron, [fixture, archive, hooks], { timeout: 30000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout.trim()), { changed: true, patched: true });
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled resolver treats runtime app.asar as a raw file under Electron", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-electron-resolver-test-"));
  const resourcesPath = path.join(root, "resources");
  const runtimeContainer = path.join(resourcesPath, "zalo-runtime");
  const runtimeRoot = path.join(runtimeContainer, "Zalo-26.7.10");
  const source = path.join(root, "source");
  const archive = path.join(runtimeRoot, "resources", "app.asar");
  const hookRoot = path.join(__dirname, "..", "src", "zpool");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  writePeFixture(path.join(runtimeRoot, "Zalo.exe"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "26.7.10", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  await asar.createPackage(source, archive);
  try {
    const patchResult = await ensurePatched(archive, hookRoot);
    fs.rmSync(patchResult.backup, { force: true });
    fs.writeFileSync(path.join(runtimeContainer, "manifest.json"), JSON.stringify({ version: "26.7.10", directory: "Zalo-26.7.10" }));
    const fixture = path.join(__dirname, "fixtures", "electron-bundled-resolver.js");
    const { stdout } = await execFileAsync(electron, [fixture, resourcesPath, hookRoot], { timeout: 30000, windowsHide: true });
    assert.deepEqual(JSON.parse(stdout.trim()), { bundled: true, version: "26.7.10" });
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("afterPack filter removes updater, uninstaller and app.asar sidecars only", () => {
  for (const excluded of [
    "Update.exe",
    "Uninstall Zalo.exe",
    "update_meta.json",
    path.join("resources", "app-update.yml"),
    path.join("resources", "app.zpm-backup-deadbeef.asar"),
    path.join("resources", "app.asar.zpm-backup-deadbeef"),
    path.join("resources", "app.zpm-next-1.asar"),
    path.join("resources", "app.zpm-next-1.asar.unpacked"),
    path.join("resources", "nested", "app.zpm-previous-1.asar"),
    path.join("resources", "app.asar.tmp"),
    path.join("resources", "app.asar.previous"),
  ]) assert.equal(afterPack.shouldCopyRuntime(excluded), false, excluded);
  assert.equal(afterPack.shouldCopyRuntime(path.join("resources", "app.asar")), true);
  assert.equal(afterPack.shouldCopyRuntime(path.join("resources", "app.asar.unpacked")), true);
  assert.equal(afterPack.shouldCopyRuntime("Zalo.exe"), true);
  assert.equal(afterPack.shouldCopyRuntime("resources.pak"), true);
});

test("afterPack copies and patches output without modifying the runtime source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-after-pack-test-"));
  const oldLocalAppData = process.env.LOCALAPPDATA;
  const installRoot = path.join(root, "local", "Programs", "Zalo");
  const sourceRoot = path.join(installRoot, "Zalo-26.7.10");
  const sourceApp = path.join(root, "asar-source");
  const appOutDir = path.join(root, "win-unpacked");
  const hookRoot = path.join(appOutDir, "resources", "app.asar.unpacked", "src", "zpool");
  const sourceArchive = path.join(sourceRoot, "resources", "app.asar");
  fs.mkdirSync(path.join(sourceApp, "main-dist"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "resources"), { recursive: true });
  fs.mkdirSync(hookRoot, { recursive: true });
  fs.mkdirSync(path.join(sourceApp, "native"), { recursive: true });
  fs.writeFileSync(path.join(sourceApp, "package.json"), JSON.stringify({ name: "fixture", version: "26.7.10", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(sourceApp, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(sourceApp, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(sourceApp, "main-dist", "migration.js"), "module.exports = {};");
  fs.writeFileSync(path.join(sourceApp, "native", "fixture.node"), "native-payload");
  await asar.createPackageWithOptions(sourceApp, sourceArchive, { unpackDir: "native" });
  const olderRoot = path.join(installRoot, "Zalo-26.6.20");
  fs.mkdirSync(path.join(olderRoot, "resources"), { recursive: true });
  writePeFixture(path.join(olderRoot, "Zalo.exe"));
  await asar.createPackage(sourceApp, path.join(olderRoot, "resources", "app.asar"));
  writePeFixture(path.join(sourceRoot, "Zalo.exe"));
  fs.writeFileSync(path.join(sourceRoot, "Update.exe"), "excluded");
  fs.writeFileSync(path.join(sourceRoot, "Uninstall Zalo.exe"), "excluded");
  fs.writeFileSync(path.join(sourceRoot, "update_meta.json"), "excluded");
  fs.writeFileSync(path.join(sourceRoot, "resources", "app-update.yml"), "excluded");
  fs.writeFileSync(path.join(sourceRoot, "resources", "app.zpm-backup-deadbeef.asar"), "excluded");
  fs.mkdirSync(path.join(sourceRoot, "resources", "app.zpm-next-deadbeef.asar.unpacked"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "resources", "app.zpm-next-deadbeef.asar.unpacked", "native.node"), "excluded");
  fs.writeFileSync(path.join(sourceRoot, "resources", "app.asar.previous"), "excluded");
  fs.mkdirSync(path.join(sourceRoot, "nested"), { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "nested", "app.zpm-next-deadbeef.asar"), "excluded");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(hookRoot, name), `packaged-${name}`);
  const sourceHash = require("../src/native-core").sha256File(sourceArchive);
  const sourceNative = path.join(`${sourceArchive}.unpacked`, "native", "fixture.node");
  const sourceNativeHash = require("../src/native-core").sha256File(sourceNative);
  try {
    process.env.LOCALAPPDATA = path.join(root, "local");
    await afterPack({ electronPlatformName: "win32", appOutDir });
    const runtimeContainer = path.join(appOutDir, "resources", "zalo-runtime");
    const outputRoot = path.join(runtimeContainer, "Zalo-26.7.10");
    const outputArchive = path.join(outputRoot, "resources", "app.asar");
    assert.equal(fs.existsSync(path.join(outputRoot, "Zalo.exe")), true);
    assert.equal(fs.existsSync(path.join(outputRoot, "Update.exe")), false);
    assert.equal(fs.existsSync(path.join(outputRoot, "Uninstall Zalo.exe")), false);
    assert.equal(fs.existsSync(path.join(outputRoot, "resources", "app-update.yml")), false);
    assert.equal(fs.existsSync(path.join(outputRoot, "resources", "app.asar.previous")), false);
    assert.equal(fs.existsSync(path.join(outputRoot, "resources", "app.zpm-next-deadbeef.asar.unpacked")), false);
    assert.equal(fs.existsSync(path.join(outputRoot, "nested", "app.zpm-next-deadbeef.asar")), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeContainer, "manifest.json"), "utf8")), {
      version: "26.7.10", directory: "Zalo-26.7.10",
    });
    assert.deepEqual(fs.readdirSync(runtimeContainer, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name), ["Zalo-26.7.10"]);
    assert.equal(inspectArchive(outputArchive).patched, true);
    assert.equal(asar.extractFile(outputArchive, "zpool.js").toString(), "packaged-zpool.js");
    const outputNative = path.join(`${outputArchive}.unpacked`, "native", "fixture.node");
    assert.equal(require("../src/native-core").sha256File(outputNative), sourceNativeHash);
    fs.writeFileSync(path.join(hookRoot, "zpool.js"), "changed-after-pack");
    assert.throws(() => afterPack.verifyRuntime(outputRoot, hookRoot), /không khớp packaged hooks hiện hành/);
    assert.equal(require("../src/native-core").sha256File(sourceArchive), sourceHash);
    assert.equal(require("../src/native-core").sha256File(sourceNative), sourceNativeHash);
  } finally {
    if (oldLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = oldLocalAppData;
    asar.uncache(sourceArchive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("afterPack verification rejects wrong version, unpatched archives and stale hooks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-after-pack-negative-test-"));
  const source = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const hookRoot = path.join(root, "hooks");
  const archive = path.join(runtimeRoot, "resources", "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.mkdirSync(hookRoot, { recursive: true });
  writePeFixture(path.join(runtimeRoot, "Zalo.exe"));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(hookRoot, name), name);
  try {
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "26.6.19", main: "bootstrap.js" }));
    await asar.createPackage(source, archive);
    assert.throws(() => afterPack.verifyRuntime(runtimeRoot, hookRoot, "26.7.10"), /sai phiên bản/);
    asar.uncache(archive);
    fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "26.6.20", main: "bootstrap.js" }));
    await asar.createPackage(source, archive);
    assert.throws(() => afterPack.verifyRuntime(runtimeRoot, hookRoot, "26.6.20"), /chưa có bootstrap\/hook Zpool/);
    const patchResult = await ensurePatched(archive, hookRoot);
    fs.rmSync(patchResult.backup, { force: true });
    for (const name of fs.readdirSync(path.dirname(archive))) {
      if (name.toLowerCase() !== "app.asar" && name.toLowerCase().includes("asar")) {
        fs.rmSync(path.join(path.dirname(archive), name), { recursive: true, force: true });
      }
    }
    fs.writeFileSync(path.join(hookRoot, "zpool.js"), "stale");
    assert.throws(() => afterPack.verifyRuntime(runtimeRoot, hookRoot, "26.6.20"), /không khớp packaged hooks/);
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bundled resolver rejects hooks that differ from the packaged hook files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-resolver-stale-hook-test-"));
  const resourcesPath = path.join(root, "resources");
  const runtimeContainer = path.join(resourcesPath, "zalo-runtime");
  const runtimeRoot = path.join(runtimeContainer, "Zalo-26.6.20");
  const source = path.join(root, "source");
  const hookRoot = path.join(root, "hooks");
  const archive = path.join(runtimeRoot, "resources", "app.asar");
  fs.mkdirSync(path.join(source, "main-dist"), { recursive: true });
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  fs.mkdirSync(hookRoot, { recursive: true });
  writePeFixture(path.join(runtimeRoot, "Zalo.exe"));
  fs.writeFileSync(path.join(source, "package.json"), JSON.stringify({ version: "26.6.20", main: "bootstrap.js" }));
  fs.writeFileSync(path.join(source, "bootstrap.js"), "const {app}=require('electron'); require('./main-dist/migration'); if(app.requestSingleInstanceLock()){require('./main-dist/main');}");
  fs.writeFileSync(path.join(source, "main-dist", "main.js"), "module.exports = {};");
  fs.writeFileSync(path.join(source, "main-dist", "migration.js"), "module.exports = {};");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) fs.writeFileSync(path.join(hookRoot, name), name);
  await asar.createPackage(source, archive);
  try {
    const patchResult = await ensurePatched(archive, hookRoot);
    fs.rmSync(patchResult.backup, { force: true });
    fs.writeFileSync(path.join(runtimeContainer, "manifest.json"), JSON.stringify({ version: "26.6.20", directory: "Zalo-26.6.20" }));
    fs.writeFileSync(path.join(hookRoot, "zpool.js"), "new-packaged-hook");
    assert.throws(
      () => resolveZaloInstall(resourcesPath, path.join(root, "local"), "win32", inspectArchive, hookRoot),
      /không khớp packaged hooks hiện hành/
    );
  } finally {
    asar.uncache(archive);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("afterPack rejects symbolic links in the runtime source", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-after-pack-symlink-test-"));
  const target = path.join(root, "target");
  const link = path.join(root, "link");
  try {
    fs.mkdirSync(target);
    try { fs.symlinkSync(target, link, "junction"); } catch (error) {
      if (error.code === "EPERM") return t.skip("Symlink creation is unavailable on this Windows host.");
      throw error;
    }
    assert.throws(() => afterPack.shouldCopyRuntime(link), /symbolic link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("package registers afterPack and ships Zpool hooks unpacked", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(packageJson.build.afterPack, "scripts/after-pack.js");
  assert.ok(packageJson.build.asarUnpack.includes("src/zpool/**/*"));
  assert.match(packageJson.scripts.check, /scripts\/after-pack\.js/);
});

test("metadata round-trip preserves browser policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-bp-meta-test-"));
  try {
    const profile = {
      appDataId: 1001, name: "Test", note: "", proxyPublicIp: "",
      proxy: { enabled: false, protocol: "http", host: "", port: "", useAuthentication: false, username: "", password: "" },
      browserPolicy: { permissions: { geolocation: true, camera: false, microphone: true, notifications: false }, userAgent: "TestUA/2.0" },
    };
    const { metaPath } = ensureProfileData(root, profile);
    const meta = decodeMeta(fs.readFileSync(metaPath, "utf8"));
    assert.equal(meta.browserPolicy.permissions.geolocation, true);
    assert.equal(meta.browserPolicy.permissions.camera, false);
    assert.equal(meta.browserPolicy.permissions.microphone, true);
    assert.equal(meta.browserPolicy.userAgent, "TestUA/2.0");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata without browserPolicy decodes with default deny", () => {
  const { encodeMetaV2 } = require("../src/native-core");
  const legacy = encodeMetaV2({ id: "1001", name: "Old", note: "", proxyConfig: { enabled: false }, proxyPublicIp: "" });
  const meta = decodeMeta(legacy);
  const bp = meta.browserPolicy || defaultBrowserPolicy();
  assert.equal(bp.permissions?.geolocation || false, false);
  assert.equal(bp.permissions?.camera || false, false);
  assert.equal(bp.permissions?.microphone || false, false);
  assert.equal(bp.permissions?.notifications || false, false);
  assert.equal(bp.userAgent || "", "");
});

test("Zpool source scopes the user agent to non-Zalo external web views and keeps Zalo's own UA", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  assert.match(source, /session-created/);
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /setPermissionCheckHandler/);
  // The UA must never be forced process-wide: that is what broke media loading.
  assert.doesNotMatch(source, /appendSwitch\(["']user-agent["']/);
  assert.doesNotMatch(source, /session\.defaultSession\.setUserAgent/);
  // It must be derived from the running Chromium, never a hardcoded newer version.
  // (The legacy AUTOMATIC_USER_AGENTS allowlist still holds fixed strings for
  // meta.bin compatibility, so this only checks the UA builder itself.)
  assert.match(source, /process\.versions\?\.chrome/);
  assert.match(source, /Chrome\/\$\{CHROME_VERSION\}/);
  // file:// contents (Zalo's own renderer) must fall back to the native UA.
  assert.match(source, /restoreNativeUserAgent/);
  assert.match(source, /app\.userAgentFallback/);
  // Client hints must be emitted from the same version as the UA string.
  assert.match(source, /sec-ch-ua-platform/);
  assert.match(source, /CHROME_MAJOR/);
  assert.match(source, /validateAutomaticIdentity\(meta\?\.automaticIdentity\)/);
  assert.match(source, /AUTOMATIC_USER_AGENTS\.has\(input\.userAgent\)/);
  assert.match(source, /distanceMeters\(input\.providerLatitude/);
  assert.match(source, /Emulation\.setGeolocationOverride/);
  assert.match(source, /geolocationReady\.has\(webContents\)/);
  assert.match(source, /debugger\.once\("detach"[\s\S]*geolocationReady\.delete/);
  assert.match(source, /did-start-navigation/);
  assert.match(source, /render-process-gone/);
  assert.match(source, /scheduleGeolocationOverride\(contents\)/);
  assert.match(source, /\.catch\(\(\) => \{\s*geolocationReady\.delete\(contents\);\s*scheduleGeolocationOverride\(contents, 1000\);/);
  assert.match(source, /catch \{\s*geolocationPending\.delete\(contents\);\s*geolocationReady\.delete\(contents\);\s*scheduleGeolocationOverride\(contents, 1000\);/);
  assert.match(source, /configuredSessions\.add\(ses\);/);
  assert.doesNotMatch(source, /navigator\.userAgent\s*=/);
  assert.doesNotMatch(source, /Object\.defineProperty\(navigator/);
  assert.doesNotMatch(source, /navigator\.webdriver/);
  assert.doesNotMatch(source, /HTMLCanvasElement\.prototype/);
  assert.doesNotMatch(source, /WebGLRenderingContext/);
  assert.doesNotMatch(source, /AudioContext\.prototype/);
});

test("Zpool applies the profile proxy to non-default Zalo sessions like ZaX", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  assert.match(source, /ses\.setProxy\(\{ proxyRules:/);
  assert.match(source, /proxiedSessions\.add\(ses\);\s*ses\.setProxy/);
  assert.doesNotMatch(source, /closeAllConnections/);
  assert.doesNotMatch(source, /proxySetupPromises/);
  assert.match(source, /ses === session\.defaultSession/);
  assert.match(source, /configureProxy\(contents\.session\)/);
  assert.doesNotMatch(source, /appendSwitch\(["']proxy-server["']/);
});

test("Zpool permission decision is media-type-aware and fails closed", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const match = source.match(/function isPermissionAllowed\(policyArg, permission, details, webContents\) \{[\s\S]*?\n\}/);
  assert.ok(match, "isPermissionAllowed must be extractable");
  const readyContents = {};
  const isPermissionAllowed = vm.runInNewContext(`(${match[0]})`, { Array, Boolean, geolocationReady: new WeakSet([readyContents]) });

  const deny = { geolocation: false, camera: false, microphone: false, notifications: false };
  const all = { geolocation: true, camera: true, microphone: true, notifications: true };
  const p = (perm) => ({ permissions: perm });

  assert.equal(isPermissionAllowed(p(deny), "geolocation", {}, readyContents), false);
  assert.equal(isPermissionAllowed(p(all), "geolocation", {}, {}), false);
  assert.equal(isPermissionAllowed(p(all), "geolocation", {}, readyContents), true);
  assert.equal(isPermissionAllowed(p(deny), "notifications", {}), false);
  assert.equal(isPermissionAllowed(p(all), "notifications", {}), true);
  assert.equal(isPermissionAllowed(p({ ...deny, microphone: true }), "media", { mediaTypes: ["audio"] }), true);
  assert.equal(isPermissionAllowed(p({ ...deny, microphone: false }), "media", { mediaTypes: ["audio"] }), false);
  assert.equal(isPermissionAllowed(p({ ...deny, camera: true }), "media", { mediaTypes: ["video"] }), true);
  assert.equal(isPermissionAllowed(p({ ...deny, camera: true, microphone: true }), "media", { mediaTypes: ["audio", "video"] }), true);
  assert.equal(isPermissionAllowed(p({ ...deny, camera: true, microphone: false }), "media", { mediaTypes: ["audio", "video"] }), false);
  assert.equal(isPermissionAllowed(p(all), "media", { mediaTypes: [] }), false);
  assert.equal(isPermissionAllowed(p(all), "media", {}), false);
  assert.equal(isPermissionAllowed(p(all), "media", { mediaTypes: ["audio", "unknown"] }), false);
  // Permissions ZPool has no policy for are not its decision: returning a hard
  // false here is what stripped clipboard/openExternal/fullscreen from external
  // web views and stopped the Zalo Business page rendering.
  assert.equal(isPermissionAllowed(p(all), "clipboard-read", {}), undefined);
  assert.equal(isPermissionAllowed(p(deny), "clipboard-read", {}), undefined);
  assert.equal(isPermissionAllowed(p(deny), "openExternal", {}), undefined);
  assert.equal(isPermissionAllowed(p(deny), "fullscreen", {}), undefined);
  assert.equal(isPermissionAllowed(p(deny), "pointerLock", {}), undefined);
});

test("Zpool only arbitrates the three permissions it has a policy for", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const match = source.match(/const MANAGED_PERMISSIONS = new Set\(\[[\s\S]*?\n\}/);
  assert.ok(match, "MANAGED_PERMISSIONS and isPermissionManaged must be extractable");
  const isPermissionManaged = vm.runInNewContext(`(() => { ${match[0]} return isPermissionManaged; })()`, { Set });

  for (const permission of ["geolocation", "notifications", "media"]) {
    assert.equal(isPermissionManaged(permission), true, `${permission} must stay fail-closed`);
  }
  // Capabilities stock ZaloPC and ZaX leave to Chromium must not be arbitrated.
  for (const permission of [
    "clipboard-read", "clipboard-sanitized-write", "openExternal", "fullscreen",
    "pointerLock", "idle-detection", "midi", "midiSysex", "hid", "serial", "usb",
    "display-capture", "window-management", "unknown-future-permission",
  ]) {
    assert.equal(isPermissionManaged(permission), false, `${permission} must defer to Chromium`);
  }

  // The session wiring must grant unmanaged permissions rather than coercing
  // `undefined` to false, which would reintroduce the silent denial.
  assert.match(source, /isPermissionManaged\(permission\) \? Boolean\(decision\) : true/);
  // Zalo's own popup configuration must survive: no blanket window-open override.
  assert.doesNotMatch(source, /setWindowOpenHandler/);
  assert.match(source, /did-create-window/);
  assert.match(source, /did-create-window", \(window, details\)[\s\S]{0,200}syncExternalUserAgent\(window\.webContents, details\?\.url\)/);
  assert.doesNotMatch(source, /did-create-window", \(window[^)]*\)[\s\S]{0,200}applyExternalUserAgent\(window\.webContents\)/);
});

test("Zpool app init pins the in-app browser to the profile session", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool-app-init.js"), "utf8");
  const start = source.indexOf("function isZaloInAppBrowserOptions");
  const end = source.indexOf("function sharedZaloSession", start);
  assert.ok(start >= 0 && end > start);
  const isInAppBrowser = vm.runInNewContext(
    `(() => { ${source.slice(start, end)} return isZaloInAppBrowserOptions; })()`,
    { process: { env: {} }, writeZBoxDebug: () => {} }
  );
  const options = {
    width: 1250,
    height: 800,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
      devTools: false,
    },
  };
  assert.equal(isInAppBrowser(options), true);
  assert.equal(isInAppBrowser({ ...options, webPreferences: { ...options.webPreferences, sandbox: true } }), true);
  assert.equal(isInAppBrowser({ ...options, width: 1200 }), false);
  assert.equal(isInAppBrowser({ ...options, webPreferences: { ...options.webPreferences, partition: "persist:other" } }), false);
  assert.match(source, /fromPartition\("persist:zalo"\)/);
  assert.match(source, /assigning persist:zalo session to zBox/);
  assert.match(source, /webPreferences: \{ \.\.\.options\.webPreferences, session: profileSession \}/);
  assert.match(source, /request === "electron" \? profileElectron : loaded/);
  assert.doesNotMatch(source, /electron\.BrowserWindow\s*=/);
  assert.ok(source.indexOf("app.setPath(\"userData\"") < source.indexOf("patchZaloInAppBrowserSession();"));
});

test("Zpool zBox debug logging stays gated behind an env flag", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool-app-init.js"), "utf8");
  assert.match(source, /process\.stderr\.write\(\`\[zpm:zbox\]/);
});

test("Zpool patches future Electron imports without assigning its read-only BrowserWindow getter", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool-app-init.js"), "utf8");
  const start = source.indexOf("function patchZaloInAppBrowserSession");
  const end = source.indexOf("function configureProfileUserData", start);
  assert.ok(start >= 0 && end > start);
  function NativeBrowserWindow(options) { this.options = options; }
  const electron = {};
  Object.defineProperty(electron, "BrowserWindow", { enumerable: true, get: () => NativeBrowserWindow });
  const Module = { _load: (request) => request === "electron" ? electron : { request } };
  const patch = vm.runInNewContext(
    `(() => { ${source.slice(start, end)} return patchZaloInAppBrowserSession; })()`,
    {
      electron,
      Module,
      Proxy,
      Reflect,
      Object,
      process: { env: {} },
      isZBoxDebugEnabled: () => false,
      writeZBoxDebug: () => {},
      zBoxDebug: () => {},
      zBoxDebugEnabled: false,
      isZaloInAppBrowserOptions: () => false,
      sharedZaloSession: () => ({}),
      trackZBoxWindow: (window) => window,
    }
  );

  assert.doesNotThrow(() => patch());
  assert.equal(electron.BrowserWindow, NativeBrowserWindow);
  const importedElectron = Module._load("electron");
  assert.notEqual(importedElectron, electron);
  assert.notEqual(importedElectron.BrowserWindow, NativeBrowserWindow);
  assert.ok(new importedElectron.BrowserWindow({ marker: true }) instanceof NativeBrowserWindow);
  assert.deepEqual({ ...Module._load("node:fs") }, { request: "node:fs" });
});

test("persist:zalo is scoped by a distinct userData path for each appDataId", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool-app-init.js"), "utf8");
  const start = source.indexOf("function configureProfileUserData");
  const end = source.indexOf("net.createServer", start);
  assert.ok(start >= 0 && end > start);
  const paths = [];
  const configure = vm.runInNewContext(
    `(() => { ${source.slice(start, end)} return configureProfileUserData; })()`,
    {
      app: { getPath: (name) => name === "appData" ? "C:\\Users\\test\\AppData\\Roaming" : "C:\\test\\ZPool.exe", setPath: (name, value) => paths.push([name, value]) },
      global: {}, path, assert,
      writeZBoxDebug: () => {},
    }
  );

  assert.equal(configure("--appdata-id=1001"), "1001");
  assert.equal(configure("--appdata-id=1002"), "1002");
  assert.equal(configure("--appdata-id=0"), "");
  assert.deepEqual(paths, [
    ["userData", path.join("C:\\Users\\test\\AppData\\Roaming", "ZaloData_1001")],
    ["userData", path.join("C:\\Users\\test\\AppData\\Roaming", "ZaloData_1002")],
  ]);
});

test("profile session cleanup is always suppressed so periodic ZBox cleanup cannot log out Zalo", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool-app-init.js"), "utf8");
  const start = source.indexOf("function sharedZaloSession");
  const end = source.indexOf("function patchZaloInAppBrowserSession", start);
  assert.ok(start >= 0 && end > start);
  let nativeClears = 0;
  let nativeCacheClears = 0;
  const profileSession = {
    clearStorageData: async () => { nativeClears += 1; },
    clearCache: async () => { nativeCacheClears += 1; },
    cookies: { set: async () => {}, remove: async () => {} },
  };
  const scope = vm.runInNewContext(
    `(() => { const liveZBoxWindows = new Set(); ${source.slice(start, end)} return { sharedZaloSession, trackZBoxWindow, liveZBoxWindowCount }; })()`,
    {
      electron: { session: { fromPartition: (partition) => { assert.equal(partition, "persist:zalo"); return profileSession; } } },
      Promise, Set, Object, URL, assert,
      process: { env: {} },
      isZBoxDebugEnabled: () => false,
      writeZBoxDebug: () => {},
    }
  );
  const shared = scope.sharedZaloSession();
  let destroyed = false;
  scope.trackZBoxWindow({
    isDestroyed: () => destroyed,
    webContents: { on: () => {} },
  });

  // Vendor dispose() runs while the window is still alive; it must not wipe the login.
  await shared.clearCache();
  await shared.clearStorageData();
  assert.equal(nativeClears, 0);
  assert.equal(nativeCacheClears, 0);

  // dispose() calls removeAllListeners(), so liveness remains useful for
  // diagnostics but is not used as a reason to clear the shared session.
  assert.doesNotMatch(source, /once\("closed"/);
  destroyed = true;
  assert.equal(scope.liveZBoxWindowCount(), 0);

  // Cleanup after the ZBox is gone is still blocked: the profile login must
  // survive vendor cleanup that runs hours later.
  await shared.clearCache();
  await shared.clearStorageData();
  assert.equal(nativeClears, 0);
  assert.equal(nativeCacheClears, 0);

  // A cleanup scheduled one day later must remain unable to clear the profile.
  await new Promise((resolve) => setTimeout(resolve, 1));
  await shared.clearStorageData({ storages: ["cookies", "localstorage", "indexeddb"] });
  assert.equal(nativeClears, 0);
});

test("Zpool permission check handler defers unmanaged permissions and stays fail-closed otherwise", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const match = source.match(/function isPermissionCheckAllowed\(policyArg, permission, details, webContents\) \{[\s\S]*?\n\}/);
  assert.ok(match, "isPermissionCheckAllowed must be extractable");
  const readyContents = {};
  const check = vm.runInNewContext(`(${match[0]})`, { Boolean, geolocationReady: new WeakSet([readyContents]) });

  const deny = { geolocation: false, camera: false, microphone: false, notifications: false };
  const all = { geolocation: true, camera: true, microphone: true, notifications: true };
  const p = (perm) => ({ permissions: perm });

  // This handler is synchronous and silent — a false here denies with no prompt,
  // which is why an over-broad denial broke pages instead of surfacing an error.
  assert.equal(check(p(all), "geolocation", {}, readyContents), true);
  assert.equal(check(p(all), "geolocation", {}, {}), false);
  assert.equal(check(p(deny), "notifications", {}), false);
  assert.equal(check(p(all), "notifications", {}), true);
  assert.equal(check(p({ ...deny, microphone: true }), "media", { mediaType: "audio" }), true);
  assert.equal(check(p(deny), "media", { mediaType: "audio" }), false);
  assert.equal(check(p(all), "media", { mediaType: "unknown" }), false);
  assert.equal(check(p(all), "media", {}), false);

  assert.equal(check(p(deny), "clipboard-read", {}), undefined);
  assert.equal(check(p(deny), "openExternal", {}), undefined);
  assert.equal(check(p(deny), "fullscreen", {}), undefined);
});

test("Zpool standalone identity validator rejects arbitrary UA, invalid IP and out-of-radius coordinates", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const start = source.indexOf("function parseIpv4");
  const end = source.indexOf("global.__zpmValidateAutomaticIdentity", start);
  assert.ok(start >= 0 && end > start);
  const validator = vm.runInNewContext(`(() => { const AUTOMATIC_USER_AGENTS = new Set([
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
  ]); const IDENTITY_RADIUS_METERS = 500; const IDENTITY_ACCURACY_METERS = 100; ${source.slice(start, end)} return validateAutomaticIdentity; })()`);
  const valid = {
    sourceIp: "8.8.8.8", ipVersion: 4, country: "US", countryCode: "US", region: "CA", city: "Mountain View",
    providerLatitude: 37.4056, providerLongitude: -122.0775, radiusMeters: 500,
    latitude: 37.4056, longitude: -122.0775, accuracyMeters: 100,
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    generatedAt: "2026-08-01T00:00:00.000Z",
  };
  assert.deepEqual({ ...validator(valid) }, valid);
  assert.equal(validator({ ...valid, userAgent: "arbitrary" }), null);
  assert.equal(validator({ ...valid, sourceIp: "192.168.1.1" }), null);
  assert.equal(validator({ ...valid, latitude: 38 }), null);
  assert.equal(validator({ ...valid, accuracyMeters: 10 }), null);
  assert.equal(validator({ ...valid, generatedAt: "invalid" }), null);
});

test("Zpool external UA is derived from the running Chromium and carries no Electron token", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const start = source.indexOf("const CHROME_VERSION");
  const end = source.indexOf("const EXTERNAL_USER_AGENT", start);
  assert.ok(start >= 0 && end > start);
  const build = (chrome) => vm.runInNewContext(
    `(() => { const process = { versions: { chrome: ${JSON.stringify(chrome)} } };`
    + `${source.slice(start, end)} return { ua: externalUserAgent(), brands: externalBrands() }; })()`
  );

  const real = build("108.0.5359.215");
  assert.equal(real.ua, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    + "(KHTML, like Gecko) Chrome/108.0.5359.215 Safari/537.36");
  // The two fake-device giveaways must be gone.
  assert.doesNotMatch(real.ua, /Electron/);
  assert.doesNotMatch(real.ua, /Zalo/i);
  // The UA version and the client-hint version must agree.
  assert.match(real.brands, /"Chromium";v="108"/);
  assert.match(real.brands, /"Google Chrome";v="108"/);

  // A different runtime yields a different UA — nothing is hardcoded.
  const newer = build("131.0.6778.86");
  assert.match(newer.ua, /Chrome\/131\.0\.6778\.86 /);
  assert.match(newer.brands, /"Chromium";v="131"/);

  // A runtime that reports no usable version must not produce a fabricated UA.
  assert.equal(build("").ua, "");
  assert.equal(build("").brands, "");
  assert.equal(build(undefined).ua, "");
});

test("Zpool external header rewrite skips Zalo-owned pages and only applies to non-Zalo http(s) contents", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "zpool", "zpool.js"), "utf8");
  const start = source.indexOf("function isWebUrl");
  const end = source.indexOf("function configureExternalUserAgent", start);
  assert.ok(start >= 0 && end > start);
  const scope = vm.runInNewContext(
    "(() => { const EXTERNAL_USER_AGENT = 'UA'; const EXTERNAL_BRANDS = 'BRANDS';"
    + " const app = { userAgentFallback: 'NATIVE' };"
    + `${source.slice(start, end)} return { isWebUrl, isZaloOwnedUrl, shouldUseExternalUserAgent, syncExternalUserAgent, applyExternalHeaders }; })()`,
    { URL }
  );

  assert.equal(scope.isWebUrl("https://business.zalo.me/upgrade"), true);
  assert.equal(scope.isWebUrl("http://example.com"), true);
  assert.equal(scope.isZaloOwnedUrl("https://business.zalo.me/upgrade"), true);
  assert.equal(scope.isZaloOwnedUrl("https://oauth.zaloapp.com/auth"), true);
  assert.equal(scope.isZaloOwnedUrl("https://id.zalo.cloud/login"), true);
  assert.equal(scope.isZaloOwnedUrl("https://api.zalo.vn/session"), true);
  assert.equal(scope.isZaloOwnedUrl("https://example.com"), false);
  assert.equal(scope.shouldUseExternalUserAgent("https://business.zalo.me/upgrade"), false);
  assert.equal(scope.shouldUseExternalUserAgent("https://oauth.zaloapp.com/auth"), false);
  assert.equal(scope.shouldUseExternalUserAgent("https://example.com"), true);
  const contents = {
    value: "EXTERNAL",
    isDestroyed: () => false,
    getUserAgent() { return this.value; },
    setUserAgent(value) { this.value = value; },
  };
  scope.syncExternalUserAgent(contents, "https://business.zalo.me/upgrade");
  assert.equal(contents.value, "NATIVE");
  scope.syncExternalUserAgent(contents, "https://id.zalo.me/login");
  assert.equal(contents.value, "NATIVE");
  scope.syncExternalUserAgent(contents, "https://example.com/payment");
  assert.equal(contents.value, "UA");
  // ZaloPC sets its own `ZaloPC` UA on the ZBox window and the account SSO
  // depends on it, so the normalization must never touch that web contents.
  const zBoxContents = {
    value: "ZALOPC",
    __zpmZBox: true,
    isDestroyed: () => false,
    getUserAgent() { return this.value; },
    setUserAgent(value) { this.value = value; },
  };
  scope.syncExternalUserAgent(zBoxContents, "https://business.zbox.vn/");
  assert.equal(zBoxContents.value, "ZALOPC");
  scope.syncExternalUserAgent(zBoxContents, "https://id.zalo.me/login");
  assert.equal(zBoxContents.value, "ZALOPC");
  // Zalo's own renderer, Zalo-owned web pages, and internal schemes must keep native UA.
  assert.equal(scope.isWebUrl("file:///C:/app/index.html"), false);
  assert.equal(scope.isWebUrl("devtools://devtools/bundled/inspector.html"), false);
  assert.equal(scope.isWebUrl(undefined), false);

  // Existing UA/hint headers are replaced regardless of their original casing,
  // so no stale Electron-bearing value can survive alongside the new one.
  const rewritten = scope.applyExternalHeaders({
    "user-agent": "Mozilla/5.0 ZaloPC Electron/22.3.9",
    "Sec-CH-UA": "stale",
    "sec-ch-ua-full-version-list": "stale",
    Accept: "text/html",
  });
  assert.equal(rewritten["User-Agent"], "UA");
  assert.equal(rewritten["sec-ch-ua"], "BRANDS");
  assert.equal(rewritten["sec-ch-ua-mobile"], "?0");
  assert.equal(rewritten["sec-ch-ua-platform"], "\"Windows\"");
  assert.equal(rewritten.Accept, "text/html");
  assert.equal(rewritten["user-agent"], undefined);
  assert.equal(rewritten["Sec-CH-UA"], undefined);
  assert.equal(rewritten["sec-ch-ua-full-version-list"], undefined);
  assert.equal(
    Object.keys(rewritten).filter((key) => key.toLowerCase() === "user-agent").length,
    1
  );
});
