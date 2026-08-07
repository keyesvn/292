"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { persistGeneratedIdentity } = require("../src/identity-persistence");

const identityResult = { ip: "8.8.8.8", identity: { sourceIp: "8.8.8.8" } };

test("generated identity merges into the latest registry before metadata", () => {
  const latest = [{ id: "one", proxy: { host: "a" } }, { id: "added", value: 2 }];
  let written;
  let metadataProfile;
  const result = persistGeneratedIdentity({
    id: "one",
    expectedProfile: latest[0],
    identityResult,
    readProfiles: () => latest,
    readRegistry: () => Buffer.from("previous"),
    writeProfiles: (profiles) => { written = profiles; },
    restoreRegistry: () => assert.fail("rollback should not run"),
    ensureProfileData: (profile) => { metadataProfile = profile; },
    sameGenerationConfig: () => true,
  });
  assert.equal(written[1].id, "added");
  assert.deepEqual(metadataProfile.automaticIdentity, identityResult.identity);
  assert.deepEqual(result.launchProfile, written[0]);
});

test("metadata failure restores exact previous registry bytes", () => {
  const previous = Buffer.from([0, 1, 2, 255]);
  let restored;
  assert.throws(() => persistGeneratedIdentity({
    id: "one",
    expectedProfile: { id: "one" },
    identityResult,
    readProfiles: () => [{ id: "one" }],
    readRegistry: () => previous,
    writeProfiles: () => {},
    restoreRegistry: (content) => { restored = Buffer.from(content); },
    ensureProfileData: () => { throw new Error("meta failed"); },
    sameGenerationConfig: () => true,
  }), /meta failed/);
  assert.deepEqual(restored, previous);
});

test("generated identity aborts when profile route/config changed", () => {
  let wrote = false;
  assert.throws(() => persistGeneratedIdentity({
    id: "one",
    expectedProfile: { id: "one", proxy: { host: "old" } },
    identityResult,
    readProfiles: () => [{ id: "one", proxy: { host: "new" } }],
    readRegistry: () => Buffer.from("previous"),
    writeProfiles: () => { wrote = true; },
    restoreRegistry: () => {},
    ensureProfileData: () => {},
    sameGenerationConfig: () => false,
  }), /thay đổi/);
  assert.equal(wrote, false);
});
