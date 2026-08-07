"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { boundedJsonRequest } = require("../src/bounded-json-request");

function requestFactory(handler) {
  return () => {
    const request = new EventEmitter();
    request.abort = () => { request.aborted = true; };
    request.end = () => handler(request);
    return request;
  };
}

function respond(request, statusCode, chunks) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  request.emit("response", response);
  for (const chunk of chunks) response.emit("data", chunk);
  response.emit("end");
}

test("bounded JSON request returns parsed HTTPS JSON", async () => {
  const value = await boundedJsonRequest(requestFactory((request) => respond(request, 200, ['{"ip":"8.8.8.8"}'])), {
    url: "https://api64.ipify.org?format=json",
  });
  assert.deepEqual(value, { ip: "8.8.8.8" });
});

test("bounded JSON request requires positive finite integer bounds and ignores chunks after overflow", async () => {
  for (const timeoutMs of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => boundedJsonRequest(requestFactory(() => {}), { url: "https://example.com", timeoutMs }), /timeoutMs/);
  }
  for (const maxBytes of [0, -1, 1.5, Infinity, NaN]) {
    assert.throws(() => boundedJsonRequest(requestFactory(() => {}), { url: "https://example.com", maxBytes }), /maxBytes/);
  }
  await assert.rejects(boundedJsonRequest(requestFactory((request) => respond(request, 200, ["123456", "ignored", "{}"])), {
    url: "https://example.com", maxBytes: 5,
  }), /giới hạn/);
});

test("bounded JSON request rejects timeout, oversized, malformed and non-2xx responses", async () => {
  let timedOutRequest;
  await assert.rejects(boundedJsonRequest(requestFactory((request) => { timedOutRequest = request; }), {
    url: "https://example.com", timeoutMs: 5,
  }), /ERR_TIMED_OUT/);
  assert.equal(timedOutRequest.aborted, true);
  await assert.rejects(boundedJsonRequest(requestFactory((request) => respond(request, 200, ["123456"])), {
    url: "https://example.com", maxBytes: 5,
  }), /giới hạn/);
  await assert.rejects(boundedJsonRequest(requestFactory((request) => respond(request, 200, ["not-json"])), {
    url: "https://example.com",
  }), /JSON/);
  await assert.rejects(boundedJsonRequest(requestFactory((request) => respond(request, 503, ["{}"])), {
    url: "https://example.com",
  }), /HTTP 503/);
});
