"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  RUNTIME_MANIFEST,
  archiveHooksMatch,
  archiveUnpackDirPattern,
  ensurePatched,
  inspectArchive,
  locateZaloInstall,
  sha256File,
  validatePeExecutable,
} = require("../src/native-core");

const EXCLUDED_FILES = new Set([
  "update.exe",
  "uninstall zalo.exe",
  "update_meta.json",
  "app-update.yml",
]);

function isArchiveSidecar(relativePath) {
  const name = path.basename(relativePath).toLowerCase();
  if (name === "app.asar" || name === "app.asar.unpacked") return false;
  return name.startsWith("app.asar") || (name.startsWith("app.") && (name.endsWith(".asar") || name.endsWith(".asar.unpacked")));
}

function shouldCopyRuntime(sourcePath) {
  if (fs.existsSync(sourcePath) && fs.lstatSync(sourcePath).isSymbolicLink()) {
    throw new Error(`ZaloPC build source chứa symbolic link không được phép: ${sourcePath}`);
  }
  const name = path.basename(sourcePath).toLowerCase();
  return !EXCLUDED_FILES.has(name) && !isArchiveSidecar(sourcePath);
}

function findForbiddenRuntimeEntries(root, relative = "") {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const entryRelative = path.join(relative, entry.name);
    const entryPath = path.join(root, entryRelative);
    if (fs.lstatSync(entryPath).isSymbolicLink()) found.push(entryRelative);
    else if (!shouldCopyRuntime(entryPath)) found.push(entryRelative);
    else if (entry.isDirectory()) found.push(...findForbiddenRuntimeEntries(root, entryRelative));
  }
  return found;
}

function verifyRuntime(runtimeRoot, hookRoot, expectedVersion = path.basename(runtimeRoot).slice("Zalo-".length)) {
  const executable = path.join(runtimeRoot, "Zalo.exe");
  const resourcesDir = path.join(runtimeRoot, "resources");
  const archive = path.join(resourcesDir, "app.asar");
  if (!fs.existsSync(executable)) throw new Error(`Bundled ZaloPC thiếu executable: ${executable}`);
  if (!fs.existsSync(archive)) throw new Error(`Bundled ZaloPC thiếu archive: ${archive}`);
  validatePeExecutable(executable);
  const forbidden = findForbiddenRuntimeEntries(runtimeRoot);
  if (forbidden.length) throw new Error(`Bundled ZaloPC còn updater/uninstaller hoặc symbolic link: ${forbidden.join(", ")}`);
  const info = inspectArchive(archive);
  if (info.version !== expectedVersion) {
    throw new Error(`Bundled ZaloPC sai phiên bản: cần ${expectedVersion}, nhận ${info.version}`);
  }
  if (!info.patched || !info.hooksPresent) throw new Error("Bundled ZaloPC chưa có bootstrap/hook Zpool hợp lệ.");
  for (const name of ["zpool-app-init.js", "zpool-helper.js", "zpool.js"]) {
    if (!fs.existsSync(path.join(hookRoot, name))) throw new Error(`Thiếu packaged hook Zpool: ${path.join(hookRoot, name)}`);
  }
  if (!archiveHooksMatch(archive, hookRoot)) throw new Error("Hook Zpool trong bundled app.asar không khớp packaged hooks hiện hành.");
  const unpackedEntries = archiveUnpackDirPattern(archive);
  const unpackedRoot = `${archive}.unpacked`;
  if (unpackedEntries.length && !fs.statSync(unpackedRoot, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Bundled ZaloPC thiếu app.asar.unpacked: ${unpackedRoot}`);
  }
  for (const entry of unpackedEntries) {
    const unpackedPath = path.join(unpackedRoot, ...entry.split("/"));
    const stat = fs.statSync(unpackedPath, { throwIfNoEntry: false });
    if (!stat || (!stat.isFile() && !stat.isDirectory())) {
      throw new Error(`Bundled ZaloPC thiếu unpacked entry: ${entry}`);
    }
  }
  return { executable, archive, info };
}

async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("Không xác định được LOCALAPPDATA để bundle ZaloPC.");
  const source = locateZaloInstall(localAppData, "win32", inspectArchive, { validateExecutable: true, requireVersion: true });
  const sourceRoot = source.root;
  const sourceArchive = path.join(sourceRoot, "resources", "app.asar");
  const runtimeDirectory = path.basename(sourceRoot);

  const sourceHash = sha256File(sourceArchive);
  const resourcesPath = path.join(context.appOutDir, "resources");
  const runtimeContainer = path.join(resourcesPath, "zalo-runtime");
  const runtimeRoot = path.join(runtimeContainer, runtimeDirectory);
  const hookRoot = path.join(resourcesPath, "app.asar.unpacked", "src", "zpool");
  const forbiddenSource = findForbiddenRuntimeEntries(sourceRoot).filter((entry) => fs.lstatSync(path.join(sourceRoot, entry)).isSymbolicLink());
  if (forbiddenSource.length) throw new Error(`ZaloPC build source chứa symbolic link/junction không được phép: ${forbiddenSource.join(", ")}`);
  fs.rmSync(runtimeContainer, { recursive: true, force: true });
  fs.mkdirSync(runtimeContainer, { recursive: true });
  fs.cpSync(sourceRoot, runtimeRoot, { recursive: true, filter: shouldCopyRuntime });

  const outputArchive = path.join(runtimeRoot, "resources", "app.asar");
  const patchResult = await ensurePatched(outputArchive, hookRoot);
  if (patchResult.backup) fs.rmSync(patchResult.backup, { force: true });
  verifyRuntime(runtimeRoot, hookRoot, source.version);
  fs.writeFileSync(path.join(runtimeContainer, RUNTIME_MANIFEST), `${JSON.stringify({ version: source.version, directory: runtimeDirectory }, null, 2)}\n`);
  if (sha256File(sourceArchive) !== sourceHash) throw new Error("ZaloPC build source đã bị thay đổi trong afterPack.");
}

module.exports = afterPack;
module.exports.isArchiveSidecar = isArchiveSidecar;
module.exports.shouldCopyRuntime = shouldCopyRuntime;
module.exports.verifyRuntime = verifyRuntime;
module.exports.findForbiddenRuntimeEntries = findForbiddenRuntimeEntries;
