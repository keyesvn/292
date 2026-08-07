"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { compareVersions, parseVersion, selectInstaller, updateResponseError } = require("../src/update-manager");

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
      { name: "ZPool Setup 0.2.0.exe", browser_download_url: "https://github.com/keyesvn/292/releases/download/v0.2.0/ZPool.exe" },
    ],
  };
  assert.equal(selectInstaller(release).asset.name, "ZPool Setup 0.2.0.exe");
  assert.equal(selectInstaller({ ...release, prerelease: true }), null);
  assert.equal(selectInstaller({ ...release, assets: [release.assets[0]] }), null);
});

test("update response errors explain missing GitHub releases instead of reporting a network failure", () => {
  assert.match(updateResponseError({ status: 404 }).message, /repository hoặc release/);
  assert.match(updateResponseError({ status: 403 }).message, /giới hạn/);
  assert.match(updateResponseError({ status: 503 }).message, /GitHub/);
});
