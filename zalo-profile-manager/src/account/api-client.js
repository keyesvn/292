"use strict";

class AccountApiClient {
  constructor(baseUrl, fetchImpl = globalThis.fetch) {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("ACCOUNT_API_URL phải là HTTPS URL hợp lệ, không chứa credential/query/hash.");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.fetch = fetchImpl;
  }

  async request(path, body, token = "") {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.error || "Máy chủ tài khoản từ chối yêu cầu.");
        error.status = response.status;
        throw error;
      }
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  activate(key, uid) { return this.request("/api/v1/activate", { key, uid }); }
  heartbeat(token, sequence) { return this.request("/api/v1/heartbeat", { sequence }, token); }
  acknowledge(token, commandId, generation) { return this.request("/api/v1/commands/ack", { commandId, generation }, token); }
  logout(token) { return this.request("/api/v1/logout", {}, token); }
}

module.exports = { AccountApiClient };
