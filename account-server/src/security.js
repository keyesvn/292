"use strict";

const crypto = require("node:crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function createKey() {
  return `292sv-ZP-${randomToken(24).toUpperCase()}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("base64url")) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("Mật khẩu admin phải dài từ 12 đến 256 ký tự.");
  }
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt}$${derived.toString("base64url")}`;
}

async function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = String(encoded).split("$");
    if (algorithm !== "scrypt" || !salt || !expected) return false;
    const actual = await new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, { N: Number(n), r: Number(r), p: Number(p) }, (error, value) => error ? reject(error) : resolve(value)));
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
  } catch {
    return false;
  }
}

// Khóa AES lấy từ KEY_ENCRYPTION_SECRET (env). Không có secret thì không mã hóa
// được -- full key sẽ không được lưu, thay vì lưu bằng một secret hardcode.
function encryptionKey(secret) {
  if (typeof secret !== "string" || secret.length < 16) return null;
  return crypto.createHash("sha256").update(`zpm-key-encryption:${secret}`).digest();
}

function encryptText(text, secret = process.env.KEY_ENCRYPTION_SECRET) {
  if (!text) return "";
  const key = encryptionKey(secret);
  if (!key) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  return `gcm:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
}

function decryptText(encryptedText, secret = process.env.KEY_ENCRYPTION_SECRET) {
  if (!encryptedText || !String(encryptedText).startsWith("gcm:")) return "";
  const key = encryptionKey(secret);
  if (!key) return "";
  try {
    const [, iv, tag, payload] = String(encryptedText).split(":");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(payload, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

// CHỈ dùng cho migration một lần từ scheme XOR cũ (secret bị hardcode và đã lộ
// trong JS phía client). Không dùng để mã hóa dữ liệu mới.
function decryptLegacyXor(encryptedText, secret = "zpool-key-protection") {
  if (!encryptedText || !String(encryptedText).startsWith("enc:")) return "";
  try {
    const hex = String(encryptedText).slice(4);
    const buf = [];
    for (let i = 0; i < hex.length; i += 2) {
      const byte = parseInt(hex.substring(i, i + 2), 16);
      buf.push(String.fromCharCode(byte ^ secret.charCodeAt((i / 2) % secret.length)));
    }
    return buf.join("");
  } catch {
    return "";
  }
}

module.exports = { createKey, decryptLegacyXor, decryptText, encryptText, hashPassword, randomToken, sha256, verifyPassword };
