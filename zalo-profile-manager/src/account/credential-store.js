"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class CredentialStore {
  constructor(options) {
    this.safeStorage = options.safeStorage;
    this.filePath = options.filePath;
  }

  assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable()) throw new Error("Windows safeStorage chưa sẵn sàng.");
  }

  read() {
    this.assertAvailable();
    try {
      const encrypted = fs.readFileSync(this.filePath);
      const value = JSON.parse(this.safeStorage.decryptString(encrypted));
      return value && typeof value === "object" ? value : {};
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw new Error("Không thể đọc credential account đã mã hóa.");
    }
  }

  write(value) {
    this.assertAvailable();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify(value));
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  getOrCreateUid() {
    const value = this.read();
    if (!value.installationId) {
      value.installationId = crypto.randomBytes(32).toString("base64url");
      this.write(value);
    }
    return crypto.createHash("sha256").update(`zpm-installation:${value.installationId}`).digest("hex");
  }

  loadSession() {
    const value = this.read();
    return value.session || null;
  }

  saveSession(session) {
    const value = this.read();
    value.session = session;
    this.write(value);
  }

  clearSession() {
    const value = this.read();
    delete value.session;
    this.write(value);
  }

  recover() {
    this.assertAvailable();
    try { fs.rmSync(this.filePath, { force: true }); } catch (error) {
      throw new Error(`Không thể đặt lại credential account: ${error.message}`);
    }
  }
}

module.exports = { CredentialStore };
