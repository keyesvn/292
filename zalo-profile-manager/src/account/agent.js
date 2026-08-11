"use strict";

const SENSITIVE_OPERATIONS = new Set(["open", "save", "delete", "restart", "test-proxy"]);
const COMMAND_TYPES = new Set(["lock", "force_logout"]);

class AccountAgent {
  constructor(options) {
    this.store = options.store;
    this.api = options.api;
    this.clock = options.clock || Date.now;
    this.monotonic = options.monotonic || (() => Number(process.hrtime.bigint() / 1000000n));
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    this.onState = options.onState || (() => {});
    this.onEnforce = options.onEnforce || (async () => {});
    this.uid = "";
    this.token = "";
    this.sequence = 0;
    this.generation = 0;
    this.account = null;
    this.status = "unconfigured";
    this.leaseUntil = 0;
    this.graceUntil = 0;
    this.graceMonotonicUntil = 0;
    this.lastWallClock = 0;
    this.pendingCommand = null;
    this.timer = null;
    this.enforcedReason = "";
    this.stopped = false;
    this.operation = Promise.resolve();
  }

  projection() {
    return {
      status: this.status,
      uid: this.uid,
      keyHint: this.account?.keyHint || "",
      plan: this.account?.plan || "",
      activatedAt: this.account?.activatedAt || null,
      expiresAt: this.account?.expiresAt || null,
      lastSeenAt: this.account?.lastSeenAt || null,
      graceUntil: this.graceUntil ? new Date(this.graceUntil).toISOString() : null,
      canOperate: this.isAllowed("open"),
    };
  }

  emit() { this.onState(this.projection()); }

  persist() {
    if (!this.token) return this.store.clearSession();
    this.lastWallClock = Math.max(this.lastWallClock, this.clock());
    this.store.saveSession({
      token: this.token,
      sequence: this.sequence,
      generation: this.generation,
      account: this.account,
      graceUntil: this.graceUntil,
      lastWallClock: this.lastWallClock,
      pendingCommand: this.pendingCommand,
    });
  }

  enqueue(action) {
    const result = this.operation.then(action, action);
    this.operation = result.catch(() => {});
    return result;
  }

  initialize() { return this.enqueue(() => this.initializeNow()); }

  async initializeNow() {
    try {
      this.uid = this.store.getOrCreateUid();
      const saved = this.store.loadSession();
      if (!this.api) {
        this.status = saved?.token ? "blocked" : "unconfigured";
        if (saved?.token) {
          this.token = saved.token;
          this.account = saved.account || null;
          this.pendingCommand = saved.pendingCommand || null;
          this.persist();
          await this.enforce("unconfigured").catch(() => this.scheduleEnforcement("unconfigured"));
        }
        this.emit();
        return;
      }
      if (!saved?.token) {
        this.status = "inactive";
        this.emit();
        return;
      }
      this.token = saved.token;
      this.sequence = Number(saved.sequence) || 0;
      this.generation = Number(saved.generation) || 0;
      this.account = saved.account || null;
      this.graceUntil = Number(saved.graceUntil) || 0;
      this.lastWallClock = Number(saved.lastWallClock) || 0;
      this.pendingCommand = saved.pendingCommand || null;
      this.status = this.pendingCommand ? (this.pendingCommand.type === "force_logout" ? "revoked" : (this.account?.status || "blocked")) : "checking";
      this.emit();
      await this.heartbeatNow();
    } catch (error) {
      this.status = "credential-error";
      this.token = "";
      this.leaseUntil = 0;
      this.emit();
      await this.enforce("credential-error").catch(() => this.scheduleEnforcement("credential-error"));
    }
  }

  activate(key) { return this.enqueue(() => this.activateNow(key)); }

  async activateNow(key) {
    if (!this.api) throw new Error("Chưa cấu hình ACCOUNT_API_URL.");
    if (!this.uid) this.uid = this.store.getOrCreateUid();
    const normalized = String(key || "").trim();
    if (normalized.length < 20 || normalized.length > 100) throw new Error("Key không hợp lệ.");
    const result = await this.api.activate(normalized, this.uid);
    if (!result.token || !result.account || !Number.isInteger(Number(result.generation))) throw new Error("Phản hồi kích hoạt không hợp lệ.");
    this.token = result.token;
    this.sequence = 0;
    this.generation = Number(result.generation);
    this.account = result.account;
    this.status = "active";
    this.leaseUntil = this.clock() + Math.min(Number(result.leaseSeconds) || 30, 30) * 1000;
    this.graceUntil = 0;
    this.graceMonotonicUntil = 0;
    this.pendingCommand = null;
    this.enforcedReason = "";
    this.persist();
    this.emit();
    this.schedule();
    return this.projection();
  }

  isAllowed(operation) {
    if (!SENSITIVE_OPERATIONS.has(operation)) return true;
    return this.status === "active" && this.clock() <= this.leaseUntil;
  }

  assertAllowed(operation) {
    if (!this.isAllowed(operation)) throw new Error("Tài khoản chưa được xác thực hoặc đang bị chặn.");
  }

  schedule(delay = 25000) {
    this.clearTimer(this.timer);
    if (this.stopped) return;
    this.timer = this.setTimer(() => void this.heartbeat(), Math.max(0, delay));
  }

  scheduleEnforcement(reason, delay = 5000) {
    this.clearTimer(this.timer);
    if (this.stopped) return;
    this.timer = this.setTimer(() => void this.enqueue(async () => {
      try { await this.enforce(reason); }
      catch { this.scheduleEnforcement(reason); }
    }), Math.max(0, delay));
  }

  async enforce(reason) {
    if (this.enforcedReason === reason) return;
    await this.onEnforce(reason);
    this.enforcedReason = reason;
  }

  heartbeat() { return this.enqueue(() => this.heartbeatNow()); }

  async heartbeatNow() {
    if (!this.token || !this.api || this.stopped) return;
    this.sequence += 1;
    this.persist();
    try {
      const result = await this.api.heartbeat(this.token, this.sequence);
      if (!result || !Number.isInteger(Number(result.generation)) || Number(result.generation) !== this.generation) {
        throw Object.assign(new Error("Phản hồi heartbeat sai generation."), { malformed: true });
      }
      this.account = result.account || this.account;
      const command = result.command;
      if (command && (!Number.isInteger(Number(command.id)) || Number(command.generation) !== this.generation || !COMMAND_TYPES.has(command.type))) {
        throw Object.assign(new Error("Command không hợp lệ."), { malformed: true });
      }
      if (result.blocked || command) {
        this.pendingCommand = command || null;
        this.status = command?.type === "force_logout" ? "revoked" : (this.account?.status || "blocked");
        this.leaseUntil = 0;
        this.graceUntil = 0;
        this.graceMonotonicUntil = 0;
        this.persist();
        this.emit();
        await this.enforce(this.status);
        if (command) {
          await this.api.acknowledge(this.token, Number(command.id), this.generation);
          this.token = "";
          this.pendingCommand = null;
          this.store.clearSession();
        } else {
          this.token = "";
          this.store.clearSession();
        }
        return;
      }
      this.status = "active";
      this.leaseUntil = this.clock() + Math.min(Number(result.leaseSeconds) || 30, 30) * 1000;
      this.graceUntil = 0;
      this.graceMonotonicUntil = 0;
      this.pendingCommand = null;
      this.enforcedReason = "";
      this.persist();
      this.emit();
      this.schedule();
    } catch (error) {
      if (this.pendingCommand) {
        this.leaseUntil = 0;
        await this.enforce(this.status).catch(() => {});
        this.persist();
        this.emit();
        this.schedule(5000);
        return;
      }
      if (error.status === 409) {
        this.persist();
        this.schedule(1000);
        return;
      }
      if (error.status === 401 || error.status === 403) {
        this.status = "revoked";
        this.leaseUntil = 0;
        this.graceUntil = 0;
        this.emit();
        try {
          await this.enforce("revoked");
          this.token = "";
          this.store.clearSession();
        } catch {
          this.persist();
          this.scheduleEnforcement("revoked");
        }
        return;
      }
      if (error.malformed) {
        this.status = "blocked";
        this.leaseUntil = 0;
        this.persist();
        this.emit();
        try {
          await this.enforce("blocked");
          this.schedule();
        } catch {
          this.scheduleEnforcement("blocked");
        }
        return;
      }
      const now = this.clock();
      const mono = this.monotonic();
      const rollback = this.lastWallClock && now + 5000 < this.lastWallClock;
      if (!this.graceUntil) {
        this.graceUntil = now + 300000;
        this.graceMonotonicUntil = mono + 300000;
      } else if (!this.graceMonotonicUntil) {
        this.graceMonotonicUntil = mono + Math.max(0, this.graceUntil - now);
      }
      const expired = rollback || now >= this.graceUntil || mono >= this.graceMonotonicUntil;
      this.status = expired ? "offline-blocked" : "offline-grace";
      this.leaseUntil = 0;
      this.persist();
      this.emit();
      if (expired) {
        try {
          await this.enforce("offline-blocked");
          this.token = "";
          this.pendingCommand = null;
          this.store.clearSession();
        } catch {
          this.schedule(5000);
        }
      } else {
        this.schedule(Math.min(25000, this.graceUntil - now, this.graceMonotonicUntil - mono));
      }
    }
  }

  logout() { return this.enqueue(() => this.logoutNow()); }

  async logoutNow() {
    const token = this.token;
    this.status = "inactive";
    this.leaseUntil = 0;
    this.graceUntil = 0;
    this.graceMonotonicUntil = 0;
    this.pendingCommand = null;
    this.persist();
    this.emit();
    try {
      await this.enforce("logout");
    } catch (error) {
      this.scheduleEnforcement("logout");
      throw error;
    }
    this.token = "";
    this.store.clearSession();
    if (token && this.api) await this.api.logout(token).catch(() => {});
    return this.projection();
  }

  recover() {
    return this.enqueue(async () => {
      await this.enforce("credential-recovery");
      this.store.recover();
      try { this.uid = this.store.getOrCreateUid(); } catch { this.uid = ""; }
      this.token = "";
      this.account = null;
      this.status = "inactive";
      this.emit();
      return this.projection();
    });
  }

  stop() {
    this.stopped = true;
    this.clearTimer(this.timer);
  }
}

module.exports = { AccountAgent, SENSITIVE_OPERATIONS };
