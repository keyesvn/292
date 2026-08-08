"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { UpdateManager, compareVersions, parseVersion, selectInstaller, updateResponseError } = require("../src/update-manager");

test("update version parser accepts release tags and compares semantic versions", () => {
  assert.deepEqual(parseVersion("v0.2.0"), [0, 2, 0]);
  assert.equal(compareVersions("0.2.0", "0.1.9"), 1);
  assert.equal(compareVersions("v0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("0.1.9", "0.2.0"), -1);
  assert.throws(() => compareVersions("latest", "0.2.0"), /không hợp lệ/);
});

test("release selection only accepts the exact versioned ZPool installer", () => {
  const release = {
    tag_name: "v0.2.0",
    draft: false,
    prerelease: false,
    assets: [
      { name: "other.exe", browser_download_url: "https://example.com/other.exe" },
      { name: "ZPool.Setup.0.2.0.exe", browser_download_url: "https://github.com/keyesvn/292/releases/download/v0.2.0/ZPool.Setup.0.2.0.exe" },
    ],
  };
  assert.equal(selectInstaller(release).asset.name, "ZPool.Setup.0.2.0.exe");
  const spacedAsset = {
    name: "ZPool Setup 0.2.0.exe",
    browser_download_url: "https://github.com/keyesvn/292/releases/download/v0.2.0/ZPool%20Setup%200.2.0.exe",
  };
  assert.equal(selectInstaller({ ...release, assets: [spacedAsset] }).asset.name, spacedAsset.name);
  assert.equal(selectInstaller({ ...release, prerelease: true }), null);
  assert.equal(selectInstaller({ ...release, assets: [release.assets[0]] }), null);
  for (const name of ["ZPoolSetup0.2.0.exe", "ZPool---Setup---0.2.0.exe", "ZPool Setup.0.2.0.exe"]) {
    assert.equal(selectInstaller({
      ...release,
      assets: [{ name, browser_download_url: `https://github.com/keyesvn/292/releases/download/v0.2.0/${name}` }],
    }), null);
  }
  for (const browser_download_url of [
    "https://example.com/ZPool.Setup.0.2.0.exe",
    "https://github.com/other/292/releases/download/v0.2.0/ZPool.Setup.0.2.0.exe",
    "https://github.com/keyesvn/292/releases/download/v9.9.9/ZPool.Setup.0.2.0.exe",
  ]) {
    assert.equal(selectInstaller({ ...release, assets: [{ ...release.assets[1], browser_download_url }] }), null);
  }
});

test("update check accepts GitHub-normalized installer names", async () => {
  let requestedUrl = "";
  const manager = new UpdateManager({
    currentVersion: "0.2.0",
    downloadDirectory: "unused",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        json: async () => ({
          tag_name: "v0.2.0",
          html_url: "https://github.com/keyesvn/292/releases/tag/v0.2.0",
          draft: false,
          prerelease: false,
          assets: [{
            name: "ZPool.Setup.0.2.0.exe",
            browser_download_url: "https://github.com/keyesvn/292/releases/download/v0.2.0/ZPool.Setup.0.2.0.exe",
          }],
        }),
      };
    },
  });

  const result = await manager.check();

  assert.equal(requestedUrl, "https://api.github.com/repos/keyesvn/292/releases/latest");
  assert.equal(result.status, "up-to-date");
  assert.equal(result.latestVersion, "0.2.0");
  assert.equal(result.error, "");
});

test("update check detects a newer GitHub release before downloading it", async () => {
  const manager = new UpdateManager({
    currentVersion: "0.2.0",
    downloadDirectory: "unused",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        tag_name: "v0.3.0",
        draft: false,
        prerelease: false,
        assets: [{
          name: "ZPool.Setup.0.3.0.exe",
          browser_download_url: "https://github.com/keyesvn/292/releases/download/v0.3.0/ZPool.Setup.0.3.0.exe",
        }],
      }),
    }),
  });
  manager.download = async () => {};

  const result = await manager.check();

  assert.equal(result.status, "available");
  assert.equal(result.latestVersion, "0.3.0");
});

test("update response errors explain missing GitHub releases instead of reporting a network failure", () => {
  assert.match(updateResponseError({ status: 404 }).message, /repository hoặc release/);
  assert.match(updateResponseError({ status: 403 }).message, /giới hạn/);
  assert.match(updateResponseError({ status: 503 }).message, /GitHub/);
});

test("update check reports API rate limits with structured diagnostics", async () => {
  const manager = new UpdateManager({
    currentVersion: "0.3.0",
    downloadDirectory: "unused",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  await assert.rejects(manager.check(), /giới hạn/);
  const state = manager.projection();
  assert.equal(state.status, "error");
  assert.equal(state.errorStage, "api");
  assert.equal(state.errorCause, "rate-limit");
  assert.equal("installerPath" in state, false);
});

test("update check distinguishes DNS failures and timeouts", async () => {
  const dns = new UpdateManager({
    currentVersion: "0.3.0",
    downloadDirectory: "unused",
    fetchImpl: async () => { throw Object.assign(new Error("net::ERR_NAME_NOT_RESOLVED"), { code: "ENOTFOUND" }); },
  });
  await assert.rejects(dns.check(), /DNS/);
  assert.deepEqual([dns.state.errorStage, dns.state.errorCause], ["api", "dns"]);

  const timeout = new UpdateManager({
    currentVersion: "0.3.0",
    downloadDirectory: "unused",
    timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
  });
  await assert.rejects(timeout.check(), /thời gian chờ/);
  assert.deepEqual([timeout.state.errorStage, timeout.state.errorCause], ["api", "timeout"]);
});

test("update API timeout remains active while the GitHub response body is read", async () => {
  const manager = new UpdateManager({
    currentVersion: "0.3.0",
    downloadDirectory: "unused",
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    }),
  });

  await assert.rejects(manager.check(), /thời gian chờ/);
  assert.deepEqual([manager.state.errorStage, manager.state.errorCause], ["api", "timeout"]);
});

test("main injects Electron net.fetch without exposing a detached method", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  assert.match(source, /fetchImpl: \(\.\.\.args\) => net\.fetch\(\.\.\.args\)/);
  assert.doesNotMatch(source, /fetchImpl:\s*net\.fetch/);
});

test("interrupted installer stream is diagnosed and partial file is removed", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zpm-update-"));
  const finalPath = path.join(directory, "ZPool.Setup.0.4.0.exe");
  const manager = new UpdateManager({ currentVersion: "0.3.0", downloadDirectory: directory, fetchImpl: async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": "20" }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(Buffer.from("MZpartial")));
        controller.error(new Error("stream interrupted"));
      },
    }),
  }) });
  try {
    await assert.rejects(manager.download({ browser_download_url: "https://github.com/keyesvn/292/file.exe", size: 20 }, finalPath), /kết nối/);
    assert.equal(fs.existsSync(finalPath), false);
    assert.equal(fs.existsSync(`${finalPath}.part`), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
