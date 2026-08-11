"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

class CredentialStore {
  constructor(options) {
    this.safeStorage = options.safeStorage;
    this.filePath = options.filePath;
    this.identityPath = options.identityPath || `${options.filePath}.identity`;
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

  readIdentity() {
    try {
      const encrypted = fs.readFileSync(this.identityPath);
      const value = JSON.parse(this.safeStorage.decryptString(encrypted));
      return typeof value?.installationId === "string" && value.installationId ? value.installationId : "";
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw new Error("Không thể đọc định danh cài đặt đã mã hóa.");
    }
  }

  writeIdentity(installationId) {
    fs.mkdirSync(path.dirname(this.identityPath), { recursive: true });
    const encrypted = this.safeStorage.encryptString(JSON.stringify({ installationId }));
    const temporary = `${this.identityPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, encrypted, { mode: 0o600 });
    fs.renameSync(temporary, this.identityPath);
  }

  getOrCreateUid() {
    this.assertAvailable();
    let value;
    try { value = this.read(); }
    catch (error) {
      const installationId = this.readIdentity();
      if (!installationId) throw error;
      value = { installationId };
      this.write(value);
    }
    const installationId = value.installationId || this.readIdentity() || crypto.randomBytes(32).toString("base64url");
    if (value.installationId !== installationId) {
      value.installationId = installationId;
      this.write(value);
    }
    try {
      if (!this.readIdentity()) this.writeIdentity(installationId);
    } catch {
      this.writeIdentity(installationId);
    }
    return crypto.createHash("sha256").update(`zpm-installation:${installationId}`).digest("hex");
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
    try {
      const installationId = this.readIdentity() || this.read().installationId;
      if (!installationId) throw new Error("Không còn bản sao định danh cài đặt.");
      this.write({ installationId });
    } catch (error) {
      throw new Error(`Không thể đặt lại credential account: ${error.message}`);
    }
  }
}

module.exports = { CredentialStore };
