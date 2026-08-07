"use strict";

const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const RELEASE_API = "https://api.github.com/repos/keyesvn/292/releases/latest";
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

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
  const pattern = new RegExp(`^ZPool Setup ${escapedVersion}\\.exe$`, "i");
  const asset = Array.isArray(release.assets)
    ? release.assets.find((item) => pattern.test(path.basename(String(item?.name || ""))) && /^https:\/\//i.test(item?.browser_download_url || ""))
    : null;
  return asset ? { asset, version } : null;
}

function updateResponseError(response) {
  if (response?.status === 404) {
    return new Error("Không tìm thấy repository hoặc release cập nhật trên GitHub.");
  }
  if (response?.status === 403 || response?.status === 429) {
    return new Error("GitHub đang giới hạn yêu cầu cập nhật. Hãy thử lại sau.");
  }
  if (response?.status >= 500) {
    return new Error("Máy chủ GitHub đang tạm thời gặp lỗi.");
  }
  return new Error(`Máy chủ cập nhật trả về HTTP ${response?.status || "không xác định"}.`);
}

class UpdateManager extends EventEmitter {
  constructor({ currentVersion, downloadDirectory, fetchImpl, intervalMs = CHECK_INTERVAL_MS }) {
    super();
    this.currentVersion = currentVersion;
    this.downloadDirectory = downloadDirectory;
    this.fetch = fetchImpl;
    this.intervalMs = intervalMs;
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
    };
  }

  projection() {
    return { ...this.state, installerPath: undefined };
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
    this.publish({ status: "checking", error: "" });
    try {
      const response = await this.fetch(RELEASE_API, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": `ZPool/${this.currentVersion}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
      if (!response.ok) throw updateResponseError(response);
      const release = await response.json();
      const selected = selectInstaller(release);
      if (!selected) throw new Error("Release mới nhất không có đúng bộ cài ZPool.");
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
      this.publish({ status: "error", checkedAt: new Date().toISOString(), error: error.message || "Không thể kiểm tra cập nhật." });
      throw error;
    }
  }

  async download(asset, finalPath) {
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    const partialPath = `${finalPath}.part`;
    fs.rmSync(partialPath, { force: true });
    this.publish({ status: "downloading", progress: 0, error: "" });
    try {
      const response = await this.fetch(asset.browser_download_url, { headers: { Accept: "application/octet-stream", "User-Agent": `ZPool/${this.currentVersion}` } });
      if (!response.ok || !response.body) {
        throw response.ok ? new Error("Máy chủ cập nhật không trả về dữ liệu bộ cài.") : updateResponseError(response);
      }
      const total = Number(response.headers.get("content-length")) || Number(asset.size) || 0;
      let received = 0;
      let lastProgress = -1;
      const progressStream = new Transform({
        transform: (chunk, _encoding, callback) => {
          received += chunk.length;
          const progress = total ? Math.min(99, Math.floor(received * 100 / total)) : 0;
          if (progress !== lastProgress) {
            lastProgress = progress;
            this.publish({ status: "downloading", progress });
          }
          callback(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(partialPath, { flags: "wx" }));
      if (total && received !== total) throw new Error("Bộ cài tải về không đủ dữ liệu.");
      const handle = fs.openSync(partialPath, "r");
      try {
        const signature = Buffer.alloc(2);
        fs.readSync(handle, signature, 0, 2, 0);
        if (signature.toString("ascii") !== "MZ") throw new Error("Bộ cài tải về không phải file Windows hợp lệ.");
      } finally { fs.closeSync(handle); }
      fs.rmSync(finalPath, { force: true });
      fs.renameSync(partialPath, finalPath);
      this.publish({ status: "downloaded", progress: 100, installerPath: finalPath });
    } catch (error) {
      fs.rmSync(partialPath, { force: true });
      throw error;
    }
  }

  installerPath() {
    return this.state.status === "downloaded" && fs.existsSync(this.state.installerPath) ? this.state.installerPath : "";
  }
}

module.exports = { CHECK_INTERVAL_MS, RELEASE_API, UpdateManager, compareVersions, parseVersion, selectInstaller, updateResponseError };
