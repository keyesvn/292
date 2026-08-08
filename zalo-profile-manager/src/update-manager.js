"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const RELEASE_API = "https://api.github.com/repos/keyesvn/292/releases/latest";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30000;

class UpdateError extends Error {
  constructor(message, stage, cause, options) {
    super(message, options);
    this.name = "UpdateError";
    this.stage = stage;
    this.updateCause = cause;
  }
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error("Phiên bản release không hợp lệ.");
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function selectInstaller(release) {
  const version = parseVersion(release?.tag_name) ? String(release.tag_name).replace(/^v/i, "") : "";
  if (!version || release?.draft || release?.prerelease) return null;
  const escapedVersion = version.replaceAll(".", "\\.");
  const pattern = new RegExp(`^ZPool(?: Setup |\\.Setup\\.)${escapedVersion}\\.exe$`, "i");
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => {
      const name = path.basename(String(item?.name || ""));
      if (!pattern.test(name)) return false;
      try {
        const url = new URL(item.browser_download_url);
        const expectedPrefix = `/keyesvn/292/releases/download/${encodeURIComponent(String(release.tag_name))}/`;
        const urlName = decodeURIComponent(path.posix.basename(url.pathname));
        return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(expectedPrefix) && urlName === name;
      } catch { return false; }
    })
    : null;
  return asset ? { asset, version } : null;
}

function updateResponseError(response, stage = "api") {
  if (response?.status === 404) {
    return new UpdateError("Không tìm thấy repository hoặc release cập nhật trên GitHub.", stage, "not-found");
  }
  if (response?.status === 403 || response?.status === 429) {
    return new UpdateError("GitHub đang giới hạn yêu cầu cập nhật. Hãy thử lại sau.", stage, "rate-limit");
  }
  if (response?.status >= 500) {
    return new UpdateError("Máy chủ GitHub đang tạm thời gặp lỗi.", stage, "server");
  }
  return new UpdateError(`Máy chủ cập nhật trả về HTTP ${response?.status || "không xác định"}.`, stage, "http");
}

function transportError(error, stage) {
  if (error instanceof UpdateError) return error;
  const detail = `${error?.code || ""} ${error?.message || ""}`.toLowerCase();
  if (error?.name === "AbortError" || detail.includes("abort")) return new UpdateError("Kết nối cập nhật đã hết thời gian chờ.", stage, "timeout", { cause: error });
  if (/cert|ssl|tls/.test(detail)) return new UpdateError("Không thể xác minh kết nối TLS tới GitHub.", stage, "tls", { cause: error });
  if (/proxy|tunnel/.test(detail)) return new UpdateError("System proxy không thể kết nối tới GitHub.", stage, "proxy", { cause: error });
  if (/dns|name_not_resolved|enotfound/.test(detail)) return new UpdateError("Không phân giải được địa chỉ GitHub. Hãy kiểm tra DNS.", stage, "dns", { cause: error });
  return new UpdateError("Không thể kết nối tới GitHub qua mạng hệ thống.", stage, "network", { cause: error });
}

class UpdateManager extends EventEmitter {
  constructor({ currentVersion, downloadDirectory, fetchImpl, intervalMs = CHECK_INTERVAL_MS, timeoutMs = REQUEST_TIMEOUT_MS }) {
    super();
    this.currentVersion = currentVersion;
    this.downloadDirectory = downloadDirectory;
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.timer = null;
    this.checkPromise = null;
    this.state = {
      status: "idle",
      currentVersion,
      latestVersion: currentVersion,
      progress: 0,
      checkedAt: null,
      releaseUrl: "https://github.com/keyesvn/292/releases",
      installerPath: "",
      error: "",
      errorStage: "",
      errorCause: "",
    };
  }

  projection() {
    const { installerPath: _installerPath, ...projection } = this.state;
    return projection;
  }

  publish(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("state", this.projection());
  }

  start() {
    if (this.timer) return;
    void this.check().catch(() => {});
    this.timer = setInterval(() => void this.check().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    if (this.checkPromise) return this.checkPromise;
    this.checkPromise = this.checkOnce().finally(() => { this.checkPromise = null; });
    return this.checkPromise;
  }

  async checkOnce() {
    this.publish({ status: "checking", error: "", errorStage: "", errorCause: "" });
    try {
      const { response, data: release } = await this.requestJson(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `ZPool/${this.currentVersion}`, "X-GitHub-Api-Version": "2022-11-28" },
      }, "api");
      if (!response.ok) throw updateResponseError(response);
      const selected = selectInstaller(release);
      if (!selected) throw new UpdateError("Release mới nhất không có đúng bộ cài ZPool.", "release", "invalid-asset");
      const common = {
        checkedAt: new Date().toISOString(),
        latestVersion: selected.version,
        releaseUrl: release.html_url || this.state.releaseUrl,
      };
      if (compareVersions(selected.version, this.currentVersion) <= 0) {
        this.publish({ ...common, status: "up-to-date", progress: 0, installerPath: "" });
        return this.projection();
      }
      const finalPath = path.join(this.downloadDirectory, path.basename(selected.asset.name));
      if (this.state.installerPath === finalPath && fs.existsSync(finalPath)) {
        this.publish({ ...common, status: "downloaded", progress: 100 });
        return this.projection();
      }
      this.publish({ ...common, status: "available", progress: 0 });
      await this.download(selected.asset, finalPath);
      return this.projection();
    } catch (error) {
      const diagnosed = transportError(error, error?.stage || "api");
      this.publish({ status: "error", checkedAt: new Date().toISOString(), error: diagnosed.message, errorStage: diagnosed.stage, errorCause: diagnosed.updateCause });
      throw diagnosed;
    }
  }

  async request(url, options, stage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
      throw transportError(error, stage);
    } finally {
      clearTimeout(timer);
    }
  }

  async requestJson(url, options, stage) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) return { response, data: null };
      try {
        return { response, data: await response.json() };
      } catch (error) {
        if (controller.signal.aborted) throw transportError(error, stage);
        throw new UpdateError("GitHub trả dữ liệu release không hợp lệ.", stage, "invalid-json", { cause: error });
      }
    } catch (error) {
      throw transportError(error, stage);
    } finally {
      clearTimeout(timer);
    }
  }

  async download(asset, finalPath) {
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    const partialPath = `${finalPath}.part`;
    fs.rmSync(partialPath, { force: true });
    this.publish({ status: "downloading", progress: 0, error: "", errorStage: "", errorCause: "" });
    let inactivityTimer;
    try {
      const response = await this.request(asset.browser_download_url, { headers: { Accept: "application/octet-stream", "User-Agent": `ZPool/${this.currentVersion}` } }, "download");
      if (!response.ok || !response.body) {
        throw response.ok ? new UpdateError("Máy chủ cập nhật không trả về dữ liệu bộ cài.", "download", "empty-body") : updateResponseError(response, "download");
      }
      const total = Number(response.headers.get("content-length")) || Number(asset.size) || 0;
      let received = 0;
      let lastProgress = -1;
      const progressStream = new Transform({
        transform: (chunk, _encoding, callback) => {
          clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => progressStream.destroy(new UpdateError("Luồng tải bộ cài đã hết thời gian chờ.", "download", "timeout")), this.timeoutMs);
          received += chunk.length;
          const progress = total ? Math.min(99, Math.floor(received * 100 / total)) : 0;
          if (progress !== lastProgress) {
            lastProgress = progress;
            this.publish({ status: "downloading", progress });
          }
          callback(null, chunk);
        },
      });
      inactivityTimer = setTimeout(() => progressStream.destroy(new UpdateError("Luồng tải bộ cài đã hết thời gian chờ.", "download", "timeout")), this.timeoutMs);
      try { await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(partialPath, { flags: "wx" })); }
      catch (error) { throw transportError(error, "download"); }
      if (total && received !== total) throw new UpdateError("Bộ cài tải về không đủ dữ liệu.", "download", "interrupted");
      const handle = fs.openSync(partialPath, "r");
      try {
        const signature = Buffer.alloc(2);
        fs.readSync(handle, signature, 0, 2, 0);
        if (signature.toString("ascii") !== "MZ") throw new UpdateError("Bộ cài tải về không phải file Windows hợp lệ.", "verify", "invalid-signature");
      } finally { fs.closeSync(handle); }
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(partialPath, finalPath);
      this.publish({ status: "downloaded", progress: 100, installerPath: finalPath });
    } catch (error) {
      fs.rmSync(partialPath, { force: true });
      throw transportError(error, error?.stage || "download");
    } finally {
      clearTimeout(inactivityTimer);
    }
  }

  installerPath() {
    return this.state.status === "downloaded" && fs.existsSync(this.state.installerPath) ? this.state.installerPath : "";
  }
}

module.exports = { CHECK_INTERVAL_MS, RELEASE_API, REQUEST_TIMEOUT_MS, UpdateError, UpdateManager, compareVersions, parseVersion, selectInstaller, transportError, updateResponseError };
