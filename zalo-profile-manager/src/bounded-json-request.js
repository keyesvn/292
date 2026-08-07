"use strict";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function boundedJsonRequest(requestFactory, options) {
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  const maxBytes = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs phải là số nguyên dương hữu hạn.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes phải là số nguyên dương hữu hạn.");
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = requestFactory({ method: "GET", url: options.url, session: options.session });
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const timeout = setTimeout(() => {
      request.abort();
      finish(new Error("ERR_TIMED_OUT"));
    }, timeoutMs);

    request.on("login", (authInfo, callback) => {
      if (authInfo.isProxy && options.proxy?.useAuthentication) callback(options.proxy.username, options.proxy.password);
      else callback();
    });
    request.on("response", (response) => {
      let bytes = 0;
      const chunks = [];
      response.on("data", (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          request.abort();
          finish(new Error("Response vượt quá giới hạn cho phép."));
          return;
        }
        chunks.push(buffer);
      });
      response.on("end", () => {
        if (settled) return;
        const body = Buffer.concat(chunks).toString("utf8");
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new Error(`HTTP ${response.statusCode}`));
          return;
        }
        try {
          finish(null, JSON.parse(body));
        } catch {
          finish(new Error("Response JSON không hợp lệ."));
        }
      });
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

module.exports = { DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, boundedJsonRequest };
