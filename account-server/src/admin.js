"use strict";

const root = document.documentElement;
const body = document.body;
const newAccountDialog = document.querySelector("#newAccountDialog");
const editAccountDialog = document.querySelector("#editAccountDialog");
const infoDialog = document.querySelector("#infoDialog");
const confirmDialog = document.querySelector("#confirmDialog");
const newVlessDialog = document.querySelector("#newVlessDialog");
const protonAccountDialog = document.querySelector("#protonAccountDialog");
const protonRentalDialog = document.querySelector("#protonRentalDialog");
const protonPortabilityDialog = document.querySelector("#protonPortabilityDialog");
const gpmLicenseDialog = document.querySelector("#gpmLicenseDialog");
const gpmScheduleDialog = document.querySelector("#gpmScheduleDialog");
let pendingForm = null;
let vlessLoaded = false;
let vlessInbounds = [];
let vlessRequestId = 0;
let vlessStatusTimer = null;
let protonLoaded = false;
let protonOverview = null;
let protonAccounts = [];
let protonSessions = [];
let protonAllSessions = [];
let protonSessionRequestId = 0;
let protonEditingAccountId = null;
let protonRentalSessionUid = "";
let protonSelectedAccountId = "";
let gpmLoaded = false;
let gpmAccount = null;
let gpmLicenses = [];
let gpmSelectedLicense = null;
let gpmScheduleLicenseUuid = "";
let gpmScheduleSubUuid = "";
let gpmLoadPromise = null;
let gpmDetailRequestId = 0;

function closeSidebar() {
  body.classList.remove("sidebar-open");
  document.querySelector(".menu-toggle")?.setAttribute("aria-expanded", "false");
}

function closeDialog(dialog) {
  if (!dialog?.open) return;
  dialog.close();
  if (dialog === gpmScheduleDialog) {
    gpmScheduleLicenseUuid = "";
    gpmScheduleSubUuid = "";
  }
  if (dialog === protonAccountDialog) {
    const form = document.querySelector("#protonAccountForm");
    if (form) {
      form.elements.namedItem("cookie").value = "";
      form.elements.namedItem("password").value = "";
    }
  }
  if (dialog === protonRentalDialog) protonRentalSessionUid = "";
}

function getCsrfToken() {
  return document.querySelector('input[name="csrf"]')?.value || "";
}

function setTheme(theme) {
  root.dataset.theme = theme;
  localStorage.setItem("zpm-admin-theme", theme);
}

function setView(view) {
  const target = document.querySelector(`[data-view="${view}"]`);
  if (!target) return;
  document.querySelectorAll("[data-view]").forEach((panel) => {
    panel.hidden = panel !== target;
    panel.classList.toggle("active", panel === target);
  });
  document.querySelectorAll("[data-view-target]").forEach((button) => { const active = button.dataset.viewTarget === view; button.classList.toggle("active", active); if (active) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current"); });
  const labels = { accounts: "Danh sách khách hàng", archived: "Key đã lưu trữ", audit: "Lịch sử hệ thống", vless: "Quản lý VLESS keys", proton: "Proton VPN Operations", gpm: "GPM Login" };
  const label = document.querySelector("#currentViewLabel");
  if (label) label.textContent = labels[view] || labels.accounts;
  [newAccountDialog, editAccountDialog, confirmDialog, newVlessDialog, protonAccountDialog, protonRentalDialog, protonPortabilityDialog, gpmLicenseDialog, gpmScheduleDialog].forEach((dialog) => { if (dialog?.open) dialog.close(); });
  // Khi ở menu VLESS, ẩn dải thống kê khách hàng của Zpool; VLESS có dải riêng.
  const zpoolStats = document.querySelector(".stats-summary-bar:not(.vless-stats-bar)");
  if (zpoolStats) zpoolStats.hidden = view === "vless" || view === "proton" || view === "gpm";
  closeSidebar();
  if (view === "vless" && !vlessLoaded) loadVless();
  if (view === "proton" && !protonLoaded) loadProton();
  if (view === "gpm" && !gpmLoaded) loadGpm();
}

function setVlessStatus(message, type = "") {
  const element = document.querySelector("#vlessStatus");
  if (!element) return;
  if (vlessStatusTimer) { clearTimeout(vlessStatusTimer); vlessStatusTimer = null; }
  element.textContent = message;
  element.className = `vless-status${type ? ` ${type}` : ""}`;
  // Thông báo thành công tự ẩn sau vài giây; lỗi giữ nguyên để người dùng kịp đọc.
  if (type === "success") {
    vlessStatusTimer = setTimeout(() => {
      element.textContent = "";
      element.className = "vless-status";
      vlessStatusTimer = null;
    }, 4000);
  }
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
}

function formatVlessExpiry(value) {
  const timestamp = Number(value) || 0;
  if (!timestamp) return "Không giới hạn";
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Không rõ" : date.toLocaleDateString("vi-VN");
}

function makeCell(content, className = "") {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  if (content instanceof Node) cell.append(content); else cell.textContent = content;
  return cell;
}

function vlessStatusPill(client) {
  const pill = document.createElement("span");
  if (!client.enabled) {
    pill.className = "status-pill offline vless-disabled";
    pill.textContent = "⚪ Tắt";
  } else if (client.online) {
    pill.className = "status-pill online";
    pill.textContent = "🟢 Online";
  } else {
    pill.className = "status-pill offline";
    pill.textContent = "⚪ Offline";
  }
  return pill;
}

function renderVlessStats() {
  const clients = vlessInbounds.flatMap((inbound) => inbound.clients);
  const online = clients.filter((client) => client.enabled && client.online).length;
  const offline = clients.filter((client) => client.enabled && !client.online).length;
  const disabled = clients.filter((client) => !client.enabled).length;
  const traffic = clients.reduce((sum, client) => sum + (Number(client.up) || 0) + (Number(client.down) || 0), 0);
  const setText = (id, value) => { const element = document.querySelector(`#${id}`); if (element) element.textContent = value; };
  setText("vlessStatTotal", String(clients.length));
  setText("vlessStatOnline", String(online));
  setText("vlessStatOffline", String(offline));
  setText("vlessStatDisabled", String(disabled));
  setText("vlessStatInbounds", String(vlessInbounds.length));
  setText("vlessStatTraffic", formatBytes(traffic));
}

function renderVlessClients() {
  const rows = document.querySelector("#vlessClientRows");
  const summary = document.querySelector("#vlessClientSummary");
  const count = document.querySelector("#vlessCount");
  if (!rows) return;
  const query = document.querySelector("#vlessSearch")?.value.trim().toLocaleLowerCase("vi") || "";
  const inboundFilter = document.querySelector("#vlessInboundFilter")?.value || "all";
  const clients = vlessInbounds.flatMap((inbound) => inbound.clients.map((client) => ({ ...client, inbound })));
  const visible = clients.filter(({ email, inbound }) => (!query || email.toLocaleLowerCase("vi").includes(query)) && (inboundFilter === "all" || String(inbound.id) === inboundFilter));
  rows.replaceChildren();
  if (!visible.length) {
    const row = document.createElement("tr"); row.className = "empty-row";
    const cell = makeCell(clients.length ? "Không có client phù hợp bộ lọc." : "Chưa có VLESS client trên panel."); cell.colSpan = 8;
    row.append(cell); rows.append(row);
  }
  visible.forEach(({ inbound, ...client }) => {
    const row = document.createElement("tr");
    const actions = document.createElement("div"); actions.className = "action-buttons";
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "btn-action-icon"; copy.title = "Sao chép VLESS key"; copy.dataset.vlessAction = "copy"; copy.dataset.email = client.email; copy.textContent = "📋";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "btn-action-icon danger"; remove.title = "Xóa client"; remove.dataset.vlessAction = "delete"; remove.dataset.email = client.email; remove.textContent = "🗑️";
    actions.append(copy, remove);
    const identity = document.createElement("div"); identity.className = "vless-client-name";
    const name = document.createElement("strong"); name.textContent = client.email;
    const source = document.createElement("small"); source.textContent = `X-UI client · inbound ${inbound.id}`; identity.append(name, source);
    row.append(
      makeCell(actions), makeCell(vlessStatusPill(client)), makeCell(identity), makeCell(`${inbound.remark} · :${inbound.port}`),
      makeCell(client.limitIp ? String(client.limitIp) : "Không giới hạn", "vless-metric"),
      makeCell(client.totalBytes ? formatBytes(client.totalBytes) : "Không giới hạn", "vless-metric"),
      makeCell(formatBytes(client.up + client.down), "vless-metric"), makeCell(formatVlessExpiry(client.expiryTime), "vless-metric")
    );
    rows.append(row);
  });
  if (summary) summary.textContent = `${clients.length} VLESS client`;
  if (count) count.textContent = String(clients.length);
  renderVlessStats();
}

function populateVlessInbounds() {
  const createSelect = document.querySelector("#vlessInbound");
  const filterSelect = document.querySelector("#vlessInboundFilter");
  if (createSelect) createSelect.replaceChildren();
  if (filterSelect) {
    filterSelect.replaceChildren();
    const all = document.createElement("option"); all.value = "all"; all.textContent = "⚙ Inbound: Tất cả"; filterSelect.append(all);
  }
  vlessInbounds.forEach((inbound) => {
    const label = `${inbound.remark} (Port ${inbound.port}, ID ${inbound.id})${inbound.enabled ? "" : " - Đã tắt"}`;
    if (createSelect) { const option = document.createElement("option"); option.value = String(inbound.id); option.textContent = label; option.disabled = !inbound.enabled; createSelect.append(option); }
    if (filterSelect) { const option = document.createElement("option"); option.value = String(inbound.id); option.textContent = label; filterSelect.append(option); }
  });
  const hasInbounds = vlessInbounds.length > 0;
  const canCreate = vlessInbounds.some((inbound) => inbound.enabled);
  if (createSelect) createSelect.disabled = !canCreate;
  if (filterSelect) filterSelect.disabled = !hasInbounds;
  const trigger = document.querySelector(".new-vless-trigger"); if (trigger) trigger.disabled = !canCreate;
  const submit = document.querySelector("#createVlessButton"); if (submit) submit.disabled = !canCreate;
}

function setVlessConnection(state, message) {
  const pill = document.querySelector("#vlessConnectionPill");
  if (!pill) return;
  pill.className = `vless-live-pill ${state}`;
  pill.textContent = `● ${message}`;
}

async function loadVless() {
  const requestId = ++vlessRequestId;
  setVlessStatus("Đang tải danh sách VLESS từ X-UI Panel...");
  setVlessConnection("", "Đang kết nối panel...");
  try {
    const response = await fetch("/admin/vless");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Không tải được dữ liệu VLESS.");
    if (requestId !== vlessRequestId) return;
    vlessLoaded = true;
    vlessInbounds = Array.isArray(data.inbounds) ? data.inbounds : [];
    populateVlessInbounds(); renderVlessClients();
    if (!data.configured) { setVlessConnection("offline", "Chưa cấu hình panel"); setVlessStatus(data.reason || "X-UI Panel chưa được cấu hình.", "error"); }
    else if (!vlessInbounds.length) { setVlessConnection("online", "Đã kết nối panel"); setVlessStatus("Kết nối panel thành công nhưng không tìm thấy inbound VLESS.", "error"); }
    else { setVlessConnection("online", "Kết nối panel OK"); setVlessStatus(`Đã đồng bộ ${vlessInbounds.length} inbound VLESS.`, "success"); }
  } catch (error) {
    if (requestId !== vlessRequestId) return;
    vlessLoaded = false;
    vlessInbounds = [];
    populateVlessInbounds(); renderVlessClients();
    setVlessConnection("offline", "Lỗi kết nối panel");
    setVlessStatus(error.message || "Không thể kết nối máy chủ.", "error");
  }
}

function setProtonStatus(message, type = "") {
  const element = document.querySelector("#protonStatus");
  if (!element) return;
  element.textContent = message;
  element.className = `proton-status${type ? ` ${type}` : ""}`;
}

async function protonRequest(path, options = {}) {
  const mutation = options.method && options.method !== "GET";
  const csrf = getCsrfToken();
  const headers = { accept: "application/json", ...(options.headers || {}) };
  let body = options.body;
  if (mutation) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ ...(body || {}), csrf });
    headers["X-CSRF-Token"] = csrf;
  }
  const response = await fetch(path, { ...options, headers, body });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Thao tác Proton VPN thất bại.");
  return data;
}

function maskProtonUid(uid) {
  const value = String(uid || "");
  return value.length > 8 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value || "Không rõ";
}

function protonStatusPill(status) {
  const pill = document.createElement("span");
  pill.className = `proton-badge ${status || "invalid"}`;
  pill.textContent = ({ manager: "Manager", active: "Active", expired: "Expired", unassigned: "Unassigned", invalid: "Invalid" })[status] || status || "Không rõ";
  return pill;
}

function protonDate(value) {
  if (!value) return "Không có hạn";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Không rõ" : date.toLocaleString("vi-VN");
}

function renderProtonAccounts() {
  const list = document.querySelector("#protonAccountList");
  const select = document.querySelector("#protonSessionAccount");
  const rentalSelect = document.querySelector('#protonRentalForm select[name="accountId"]');
  if (!list) return;
  list.replaceChildren();
  [select, rentalSelect].forEach((element) => element?.replaceChildren());
  if (!protonAccounts.length) {
    const empty = document.createElement("p"); empty.className = "proton-inline-state"; empty.textContent = "Chưa có Proton account. Hãy thêm account để tải sessions."; list.append(empty);
  }
  protonAccounts.forEach((account, index) => {
    [select, rentalSelect].forEach((element) => {
      if (!element) return;
      const option = document.createElement("option"); option.value = String(account.id ?? account.uuid ?? ""); option.textContent = `${account.name || account.email || "Proton account"} · ${maskProtonUid(account.uid)}`; element.append(option);
    });
    const accountId = String(account.id ?? account.uuid ?? "");
    const selected = protonSelectedAccountId ? accountId === protonSelectedAccountId : index === 0;
    const item = document.createElement("article"); item.className = `proton-account-item${selected ? " selected" : ""}`; item.dataset.id = accountId; item.tabIndex = 0; item.setAttribute("role", "button"); item.setAttribute("aria-pressed", String(selected)); item.setAttribute("aria-label", `Chọn ${account.name || account.email || "Proton account"}`);
    const dot = document.createElement("i"); if (account.hasCookie !== false) dot.className = "ready";
    const identity = document.createElement("div"); identity.className = "proton-account-identity";
    const name = document.createElement("strong"); name.textContent = account.name || account.email || "Proton account";
    const uid = document.createElement("small"); uid.textContent = `UID ${maskProtonUid(account.uid)} · ${account.hasCookie === false ? "Thiếu cookie" : "Sẵn sàng"}`; identity.append(name, uid);
    const actions = document.createElement("div"); actions.className = "action-buttons";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "proton-row-button"; edit.title = "Sửa account"; edit.setAttribute("aria-label", `Sửa ${name.textContent}`); edit.dataset.protonAccountAction = "edit"; edit.dataset.id = accountId; edit.textContent = "Sửa";
    const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "proton-row-button"; refresh.title = "Renew cookie Proton"; refresh.setAttribute("aria-label", `Renew cookie ${name.textContent}`); refresh.dataset.protonRefreshCredentials = accountId; refresh.textContent = "Renew";
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "proton-row-button revoke"; remove.title = "Xóa account"; remove.setAttribute("aria-label", `Xóa ${name.textContent}`); remove.dataset.protonAccountAction = "delete"; remove.dataset.id = accountId; remove.textContent = "Xóa"; actions.append(edit, refresh, remove);
    item.append(dot, identity, actions); list.append(item);
  });
  if (!protonSelectedAccountId && protonAccounts.length) protonSelectedAccountId = String(protonAccounts[0].id ?? protonAccounts[0].uuid ?? "");
  if (select && protonAccounts.length && !select.value) select.value = String(protonAccounts[0].id);
  if (rentalSelect && protonAccounts.length && !rentalSelect.value) rentalSelect.value = String(protonAccounts[0].id);
  const count = document.querySelector("#protonCount"); if (count) count.textContent = String(protonAccounts.length);
  const summary = document.querySelector("#protonAccountSummary"); if (summary) summary.textContent = `${protonAccounts.length} account`;
}

function renderProtonOverview() {
  const stats = protonOverview?.stats || {};
  const sessionStats = { devices: protonAllSessions.length, active: protonAllSessions.filter((item) => item.status === "active").length, expired: protonAllSessions.filter((item) => item.status === "expired").length, available: protonAllSessions.filter((item) => item.status === "unassigned").length };
  const values = { protonStatDevices: stats.devices ?? stats.sessions ?? sessionStats.devices, protonStatActive: stats.active ?? stats.rented ?? sessionStats.active, protonStatExpired: stats.expired ?? stats.overdue ?? sessionStats.expired, protonStatAvailable: stats.available ?? stats.emptySlots ?? sessionStats.available };
  Object.entries(values).forEach(([id, value]) => { const element = document.querySelector(`#${id}`); if (element) element.textContent = String(value); });
  const worker = protonOverview?.worker;
  const pill = document.querySelector("#protonConnectionPill");
  if (pill) { pill.className = `proton-live-pill ${worker?.lastError ? "offline" : "online"}`; pill.textContent = worker?.lastError ? "● Worker lỗi" : worker?.enabled ? "● Worker đang bật" : "● Worker tắt"; }
  const detail = document.querySelector("#protonWorkerDetail");
  if (detail) detail.textContent = worker?.lastError ? `Lỗi gần nhất: ${worker.lastError}` : worker?.running ? "Worker đang chạy cleanup." : worker?.lastRunAt ? `Lần chạy gần nhất: ${protonDate(worker.lastRunAt)}` : worker?.enabled ? "Worker đang chờ chu kỳ cleanup đầu tiên." : "Worker auto-revoke hiện đang tắt.";
  const capacity = document.querySelector("#protonStatCapacity");
  if (capacity) capacity.textContent = stats.capacity ? `/ ${stats.capacity}` : "";
}

function renderProtonSessions() {
  const rows = document.querySelector("#protonSessionRows");
  if (!rows) return;
  const query = document.querySelector("#protonSessionSearch")?.value.trim().toLocaleLowerCase("vi") || "";
  const filter = document.querySelector("#protonSessionStatus")?.value || "all";
  const visible = protonSessions.filter((session) => {
    const rental = session.rental || {};
    const status = session.status || rental.status || (session.isCurrent ? "manager" : "unassigned");
    const haystack = [session.sessionUid, session.uid, session.device, session.customer, session.phone, session.note, rental.customer, rental.phone, rental.note].join(" ").toLocaleLowerCase("vi");
    return (!query || haystack.includes(query)) && (filter === "all" || status === filter);
  });
  rows.replaceChildren();
  if (!visible.length) { const row = document.createElement("tr"); const cell = makeCell(protonSessions.length ? "Không có session phù hợp bộ lọc." : "Account chưa có session VPN.", "proton-empty-cell"); cell.colSpan = 6; row.append(cell); rows.append(row); }
  visible.forEach((session) => {
    const sessionIndex = protonSessions.indexOf(session);
    const rental = session.rental || {};
    const sessionUid = session.sessionUid || session.uid || session.id || "";
    const customerValue = session.customer || rental.customer || "Chưa assign";
    const phoneValue = session.phone || rental.phone || "";
    const noteValue = session.note || rental.note || "";
    const expiresAt = session.expiresAt || rental.expiresAt || "";
    const timeLeft = session.timeLeft || rental.timeLeft || (expiresAt ? protonTimeLeft(expiresAt) : "Không có hạn");
    const status = session.status || rental.status || (session.isCurrent ? "manager" : "unassigned");
    const row = document.createElement("tr");
    const identity = document.createElement("div"); identity.className = "proton-device-cell"; const icon = document.createElement("span"); icon.className = "proton-device-icon"; icon.textContent = session.isCurrent ? "NOW" : "VPN"; const identityText = document.createElement("span"); const device = document.createElement("strong"); device.textContent = session.device || session.deviceName || "Thiết bị Proton"; const details = document.createElement("small"); details.textContent = maskProtonUid(sessionUid); identityText.append(device, details); identity.append(icon, identityText);
    const rentalInfo = document.createElement("div"); rentalInfo.className = "proton-customer-cell"; const customer = document.createElement("strong"); customer.textContent = customerValue; const note = document.createElement("small"); note.textContent = [phoneValue, noteValue].filter(Boolean).join(" · ") || "Không có thông tin thuê"; rentalInfo.append(customer, note);
    const actions = document.createElement("div"); actions.className = "proton-row-actions";
    const copy = document.createElement("button"); copy.type = "button"; copy.className = "proton-row-button"; copy.title = "Copy UID đã mask"; copy.dataset.protonCopyUid = maskProtonUid(sessionUid); copy.textContent = "Copy UID";
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "proton-row-button"; edit.title = "Assign / sửa rental"; edit.dataset.protonSessionAction = "edit"; edit.dataset.index = sessionIndex; edit.textContent = "Gán thuê";
    const unassign = document.createElement("button"); unassign.type = "button"; unassign.className = "proton-row-button"; unassign.title = "Bỏ gán rental"; unassign.dataset.protonSessionAction = "unassign"; unassign.dataset.index = sessionIndex; unassign.disabled = !(session.rental || session.customer); unassign.textContent = "Bỏ gán";
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "proton-row-button revoke"; revoke.title = "Revoke thiết bị"; revoke.dataset.protonSessionAction = "revoke"; revoke.dataset.index = sessionIndex; revoke.disabled = status === "manager" || session.isCurrent; revoke.textContent = "Thu hồi"; actions.append(copy, edit, unassign, revoke);
    const cells = [makeCell(identity), makeCell(rentalInfo), makeCell(protonDate(expiresAt), "proton-mono"), makeCell(String(timeLeft), "proton-mono"), makeCell(protonStatusPill(status)), makeCell(actions)];
    ["Thiết bị / Ứng dụng", "Người thuê", "Hạn thuê", "Thời gian còn lại", "Trạng thái", "Thao tác"].forEach((label, index) => { cells[index].dataset.label = label; });
    row.append(...cells); rows.append(row);
  });
  const summary = document.querySelector("#protonSessionSummary"); if (summary) summary.textContent = `${visible.length} thiết bị`;
}

function protonTimeLeft(value) {
  const difference = new Date(value).getTime() - Date.now();
  if (!Number.isFinite(difference)) return "Không rõ";
  if (difference <= 0) return "Đã quá hạn";
  const days = Math.floor(difference / 86400000);
  const hours = Math.floor(difference % 86400000 / 3600000);
  return days ? `${days} ngày ${hours} giờ` : `${hours} giờ`;
}

async function loadProtonSessions(accountId) {
  if (!accountId) return;
  const requestId = ++protonSessionRequestId; setProtonStatus("Đang tải sessions Proton VPN...");
  try { const data = await protonRequest(`/admin/proton/accounts/${encodeURIComponent(accountId)}/sessions`); if (requestId !== protonSessionRequestId) return; protonSessions = Array.isArray(data.sessions) ? data.sessions : []; renderProtonSessions(); const refreshed = document.querySelector("#protonLastRefresh"); if (refreshed) refreshed.textContent = `Đồng bộ lúc ${new Date().toLocaleTimeString("vi-VN")}`; setProtonStatus(`Đã tải ${protonSessions.length} session.`, "success"); }
  catch (error) { if (requestId !== protonSessionRequestId) return; protonSessions = []; renderProtonSessions(); setProtonStatus(error.message || "Không tải được sessions.", "error"); }
}

async function loadProton() {
  protonLoaded = false; setProtonStatus("Đang tải tổng quan Proton VPN...");
  try {
    const [overview, accounts] = await Promise.all([protonRequest("/admin/proton/overview"), protonRequest("/admin/proton/accounts")]);
    protonOverview = overview;
    protonAccounts = Array.isArray(accounts.accounts) ? accounts.accounts : [];
    if (!protonAccounts.some((account) => String(account.id) === String(protonSelectedAccountId))) protonSelectedAccountId = String(protonAccounts[0]?.id || "");
    const sessionResults = await Promise.all(protonAccounts.map(async (account) => {
      try { return { account, data: await protonRequest(`/admin/proton/accounts/${encodeURIComponent(account.id ?? account.uuid)}/sessions`) }; }
      catch (error) { return { account, error }; }
    }));
    protonAllSessions = sessionResults.flatMap((result) => result.data?.sessions || []);
    protonLoaded = true;
    renderProtonOverview(); renderProtonAccounts();
    const failed = sessionResults.find((result) => result.error);
    if (failed) setProtonStatus(`Không tải được session của account ${failed.account.name || failed.account.email || failed.account.id}: ${failed.error.message}`, "error");
    else await loadProtonSessions(protonSelectedAccountId || document.querySelector("#protonSessionAccount")?.value);
  }
  catch (error) { renderProtonOverview(); renderProtonAccounts(); setProtonStatus(error.message || "Không tải được Proton VPN.", "error"); }
}

function openProtonAccountDialog(account = null) {
  const form = document.querySelector("#protonAccountForm"); if (!form) return;
  const fields = form.elements;
  protonEditingAccountId = account?.id || null; form.reset(); fields.namedItem("name").value = account?.name || ""; fields.namedItem("email").value = account?.email || ""; fields.namedItem("uid").value = account?.uid || ""; fields.namedItem("appVersion").value = account?.appVersion || ""; fields.namedItem("uid").disabled = Boolean(account);
  fields.namedItem("cookie").required = !account; document.querySelector("#protonAccountDialogTitle").textContent = account ? "Sửa Proton account" : "Thêm Proton account"; protonAccountDialog?.showModal();
}

async function submitProtonAccount(event) {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const id = protonEditingAccountId; if (!values.cookie) delete values.cookie; if (!values.password) delete values.password;
  const button = form.querySelector("button[type=submit]"); if (button) button.disabled = true;
  try { await protonRequest(id ? `/admin/proton/accounts/${id}` : "/admin/proton/accounts", { method: id ? "PATCH" : "POST", body: values }); form.reset(); protonAccountDialog?.close(); await loadProton(); setProtonStatus(id ? "Đã cập nhật account." : "Đã thêm account.", "success"); }
  catch (error) { setProtonStatus(error.message || "Không lưu được account.", "error"); } finally { form.elements.namedItem("cookie").value = ""; form.elements.namedItem("password").value = ""; if (button) button.disabled = false; }
}

function openProtonRentalDialog(session) {
  const form = document.querySelector("#protonRentalForm"); const rental = session.rental || {}; if (!form) return; const fields = form.elements; protonRentalSessionUid = session.sessionUid; form.reset(); fields.namedItem("accountId").value = document.querySelector("#protonSessionAccount")?.value || protonAccounts[0]?.id || ""; fields.namedItem("customer").value = rental.customer || ""; fields.namedItem("phone").value = rental.phone || ""; fields.namedItem("note").value = rental.note || ""; if (rental.expiresAt) fields.namedItem("expiresAt").value = new Date(rental.expiresAt).toISOString().slice(0, 16); document.querySelector("#protonRentalUidHint").textContent = `UID ${maskProtonUid(session.sessionUid)} · ${session.status}`; protonRentalDialog?.showModal();
}

async function downloadProtonExport(path, filename) {
  const response = await fetch(path);
  if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || "Không export được dữ liệu Proton."); }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a"); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function setGpmStatus(message, type = "") {
  const element = document.querySelector("#gpmStatus");
  if (!element) return;
  element.textContent = message;
  element.className = `gpm-status${type ? ` ${type}` : ""}`;
}

async function gpmRequest(path, options = {}) {
  const mutation = options.method && options.method !== "GET";
  const csrf = getCsrfToken();
  const headers = { accept: "application/json", ...(options.headers || {}) };
  let requestBody = options.body;
  if (mutation) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = csrf;
    requestBody = JSON.stringify({ ...(requestBody || {}), csrf });
  }
  const response = await fetch(path, { ...options, headers, body: requestBody });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Thao tác GPM Login thất bại.");
  return data;
}

function gpmValue(value, fallback = "-") {
  return value === null || value === undefined || value === "" ? fallback : String(value);
}

function gpmBoolean(value, yes = "Có", no = "Không") {
  return value === true || value === 1 || value === "true" ? yes : no;
}

function gpmDate(value) {
  if (!value) return "Không giới hạn";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Không rõ" : date.toLocaleDateString("vi-VN");
}

function gpmDateTime(value) {
  if (!value) return "Không rõ";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Không rõ" : date.toLocaleString("vi-VN");
}

function gpmDateInput(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function gpmTimeDistance(milliseconds) {
  const totalHours = Math.max(0, Math.ceil(milliseconds / 3600000));
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return days ? `${days} ngày${hours ? ` ${hours} giờ` : ""}` : `${hours} giờ`;
}

function gpmSubSchedule(subLicense) {
  const schedule = subLicense.schedule || {};
  const name = subLicense.name ?? schedule.name ?? "";
  const startsAt = subLicense.startsAt ?? subLicense.startAt ?? subLicense.scheduledStartsAt ?? schedule.startsAt ?? schedule.startAt;
  const expiresAt = subLicense.expiresAt ?? subLicense.expiry ?? subLicense.endAt ?? subLicense.scheduledExpiresAt ?? schedule.expiresAt ?? schedule.endAt;
  const termDays = Number(subLicense.termDays ?? subLicense.durationDays ?? schedule.termDays ?? schedule.days) || 0;
  const autoExchange = subLicense.autoExchange ?? schedule.autoExchange ?? false;
  const cooldownUntil = subLicense.exchangeCooldownUntil ?? subLicense.cooldownUntil ?? subLicense.nextExchangeAt ?? subLicense.exchangeAvailableAt;
  const startTime = startsAt ? new Date(startsAt).getTime() : NaN;
  const expiryTime = expiresAt ? new Date(expiresAt).getTime() : NaN;
  const now = Date.now();
  let status = "unscheduled";
  let label = "Chưa đặt lịch";
  let remaining = "Chưa có thời hạn";
  if (Number.isFinite(expiryTime) && expiryTime <= now) { status = "expired"; label = "Hết hạn"; remaining = "Đã hết hạn"; }
  else if (Number.isFinite(startTime) && startTime > now) { status = "scheduled"; label = "Đã lên lịch"; remaining = `Bắt đầu sau ${gpmTimeDistance(startTime - now)}`; }
  else if (Number.isFinite(expiryTime)) { const difference = expiryTime - now; status = difference <= 7 * 86400000 ? "expiring" : "scheduled"; label = status === "expiring" ? "Sắp hết hạn" : "Đang hiệu lực"; remaining = `Còn ${gpmTimeDistance(difference)}`; }
  const cooldownTime = cooldownUntil ? new Date(cooldownUntil).getTime() : NaN;
  return { name, startsAt, expiresAt, termDays, autoExchange: autoExchange === true || autoExchange === 1 || autoExchange === "true", cooldownUntil, cooldownActive: Number.isFinite(cooldownTime) && cooldownTime > now, status, label, remaining };
}

function gpmLicenseId(license) {
  return String(license.uuid ?? license.id ?? "");
}

function gpmLicenseStatus(license) {
  const raw = String(license.status || (license.active === false ? "disabled" : "active")).toLowerCase();
  if (raw.includes("expire")) return "expired";
  if (raw.includes("disable") || raw.includes("inactive") || raw.includes("block")) return "disabled";
  if (raw.includes("pending") || raw.includes("wait")) return "pending";
  return raw === "active" || raw === "valid" || raw === "enabled" ? "active" : raw;
}

function gpmStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `gpm-badge ${status}`;
  badge.textContent = ({ active: "Đang hoạt động", expired: "Hết hạn", disabled: "Đã tắt", pending: "Đang chờ" })[status] || status || "Không rõ";
  return badge;
}

function gpmMaskedKey(license) {
  return gpmValue(license.licenseMasked ?? license.maskedKey ?? license.keyMasked ?? license.licenseKeyMasked ?? license.keyHint, "•••• •••• ••••");
}

function renderGpmAccount() {
  const account = gpmAccount || {};
  const fullName = gpmValue(account.fullName ?? account.name, "Tài khoản GPM");
  const initials = fullName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "GP";
  const values = {
    gpmAccountInitials: initials,
    gpmAccountName: fullName,
    gpmAccountEmail: gpmValue(account.email),
    gpmAccountRole: gpmValue(account.role),
    gpmAccountState: gpmBoolean(account.isActive ?? account.active, "Hoạt động", "Đã tắt"),
    gpmAccountVerified: gpmBoolean(account.isEmailVerified ?? account.verified ?? account.isVerified, "Đã xác minh", "Chưa xác minh"),
    gpmAccountLicenses: Array.isArray(account.licenses) ? String(account.licenses.length) : gpmValue(account.ownedLicenses ?? account.licenses ?? account.licenseCount, String(gpmLicenses.length)),
  };
  Object.entries(values).forEach(([id, value]) => { const element = document.querySelector(`#${id}`); if (element) element.textContent = value; });
}

function renderGpmLicenses() {
  const rows = document.querySelector("#gpmLicenseRows");
  if (!rows) return;
  const query = document.querySelector("#gpmSearch")?.value.trim().toLocaleLowerCase("vi") || "";
  const filter = document.querySelector("#gpmStatusFilter")?.value || "all";
  const visible = gpmLicenses.filter((license) => {
    const status = gpmLicenseStatus(license);
    const haystack = [license.product, license.productName, license.package, license.packageName, license.type, gpmMaskedKey(license)].join(" ").toLocaleLowerCase("vi");
    return (!query || haystack.includes(query)) && (filter === "all" || status === filter);
  });
  rows.replaceChildren();
  if (!visible.length) {
    const row = document.createElement("tr"); const cell = makeCell(gpmLicenses.length ? "Không có license phù hợp bộ lọc." : "Tài khoản chưa có giấy phép.", "gpm-empty-cell"); cell.colSpan = 7; row.append(cell); rows.append(row);
  }
  visible.forEach((license) => {
    const uuid = gpmLicenseId(license);
    const row = document.createElement("tr");
    const identity = document.createElement("div"); identity.className = "gpm-product";
    const product = document.createElement("strong"); product.textContent = gpmValue(license.product ?? license.productName, "GPM Login");
    const packageName = document.createElement("small"); packageName.textContent = [license.package ?? license.packageName, license.type].filter(Boolean).join(" · ") || "Gói tiêu chuẩn"; identity.append(product, packageName);
    const keyCell = document.createElement("div"); keyCell.className = "gpm-key-cell"; const masked = document.createElement("code"); masked.textContent = gpmMaskedKey(license); const reveal = document.createElement("button"); reveal.type = "button"; reveal.className = "gpm-text-button"; reveal.dataset.gpmAction = "reveal"; reveal.dataset.uuid = uuid; reveal.textContent = "Hiện và sao chép"; keyCell.append(masked, reveal);
    const deviceUsed = Number(license.devicesUsed ?? license.deviceCount ?? license.usedDevices) || 0;
    const deviceLimit = license.deviceLimit ?? license.maxDevices ?? license.devicesLimit;
    const device = document.createElement("div"); device.className = "gpm-device-meter"; const deviceText = document.createElement("span"); deviceText.textContent = `${deviceUsed} / ${deviceLimit ?? "∞"}`; const meter = document.createElement("i"); const percentage = deviceLimit ? Math.min(100, deviceUsed / Number(deviceLimit) * 100) : 0; meter.style.setProperty("--gpm-meter", `${percentage}%`); device.append(deviceText, meter);
    const subCount = Number(license.subLicenseCount ?? license.subLicensesCount ?? (Array.isArray(license.subLicenses) ? license.subLicenses.length : 0)) || 0;
    const sub = document.createElement("span"); sub.className = `gpm-sub-indicator${subCount ? " has-items" : ""}`; sub.textContent = subCount ? `${subCount} sub-license` : "Không có";
    const detail = document.createElement("button"); detail.type = "button"; detail.className = "gpm-button secondary compact"; detail.dataset.gpmAction = "detail"; detail.dataset.uuid = uuid; detail.textContent = "Chi tiết";
    row.append(makeCell(identity), makeCell(keyCell), makeCell(gpmStatusBadge(gpmLicenseStatus(license))), makeCell(device), makeCell(gpmDate(license.expiresAt ?? license.expiry ?? license.expiredAt)), makeCell(sub), makeCell(detail)); rows.append(row);
  });
  const summary = document.querySelector("#gpmLicenseSummary"); if (summary) summary.textContent = `${visible.length} / ${gpmLicenses.length} giấy phép`;
  const count = document.querySelector("#gpmCount"); if (count) count.textContent = String(gpmLicenses.length);
}

function gpmDetailSection(title, items, renderItem, emptyMessage) {
  const section = document.createElement("section"); section.className = "gpm-detail-section";
  const heading = document.createElement("div"); heading.className = "gpm-detail-heading"; const label = document.createElement("h3"); label.textContent = title; const count = document.createElement("span"); count.textContent = String(items.length); heading.append(label, count); section.append(heading);
  const list = document.createElement("div"); list.className = "gpm-detail-list";
  if (!items.length) { const empty = document.createElement("p"); empty.className = "gpm-detail-empty"; empty.textContent = emptyMessage; list.append(empty); }
    else items.forEach((item) => list.append(renderItem(item)));
  section.append(list); return section;
}

function gpmSubLicenseCard(licenseUuid, subLicense) {
  const subUuid = String(subLicense.uuid ?? subLicense.id ?? "");
  const schedule = gpmSubSchedule(subLicense);
  const item = document.createElement("article"); item.className = `gpm-sub-card ${schedule.status}`;
  const main = document.createElement("div"); main.className = "gpm-sub-main";
  const keyRow = document.createElement("div"); keyRow.className = "gpm-sub-key-row";
    const name = document.createElement("strong"); name.className = "gpm-sub-name"; name.textContent = schedule.name || "Chưa đặt tên";
   const key = document.createElement("code"); key.textContent = gpmValue(subLicense.subLicenseMasked ?? subLicense.maskedKey ?? subLicense.keyMasked ?? subLicense.keyHint, "•••• •••• ••••");
   const badge = document.createElement("span"); badge.className = `gpm-sub-status ${schedule.status}`; badge.textContent = schedule.label; keyRow.append(name, key, badge);
  const dates = document.createElement("button"); dates.type = "button"; dates.className = "gpm-schedule-link"; dates.dataset.gpmAction = "schedule"; dates.dataset.uuid = licenseUuid; dates.dataset.subUuid = subUuid; dates.title = "Chỉnh lịch sub-license"; dates.setAttribute("aria-label", `Chỉnh lịch cho ${key.textContent}`);
  const dateText = document.createElement("span"); dateText.textContent = `Bắt đầu ${schedule.startsAt ? gpmDate(schedule.startsAt) : "chưa đặt"} · Hết hạn ${schedule.expiresAt ? gpmDate(schedule.expiresAt) : "chưa đặt"}`;
  const remaining = document.createElement("strong"); remaining.textContent = schedule.remaining; dates.append(dateText, remaining);
  const notes = document.createElement("div"); notes.className = "gpm-sub-notes";
  const auto = document.createElement("span"); auto.textContent = schedule.autoExchange ? "Tự động làm mới: Bật" : "Tự động làm mới: Tắt"; notes.append(auto);
  if (schedule.cooldownUntil) { const cooldown = document.createElement("span"); cooldown.className = schedule.cooldownActive ? "warning" : ""; cooldown.textContent = schedule.cooldownActive ? `Cooldown exchange đến ${gpmDateTime(schedule.cooldownUntil)}` : "Có thể exchange"; notes.append(cooldown); }
  main.append(keyRow, dates, notes);
  const actions = document.createElement("div"); actions.className = "gpm-sub-actions";
  const exchange = document.createElement("button"); exchange.type = "button"; exchange.className = "gpm-sub-icon"; exchange.dataset.gpmAction = "exchange-sub"; exchange.dataset.uuid = licenseUuid; exchange.dataset.subUuid = subUuid; exchange.title = schedule.cooldownActive ? `Chưa thể làm mới đến ${gpmDateTime(schedule.cooldownUntil)}` : "Exchange / làm mới key"; exchange.setAttribute("aria-label", exchange.title); exchange.disabled = !subUuid || schedule.cooldownActive; exchange.textContent = "↻";
  const copy = document.createElement("button"); copy.type = "button"; copy.className = "gpm-sub-icon"; copy.dataset.gpmAction = "reveal-sub"; copy.dataset.uuid = licenseUuid; copy.dataset.subUuid = subUuid; copy.title = "Sao chép key"; copy.setAttribute("aria-label", "Sao chép key sub-license"); copy.disabled = !subUuid; copy.textContent = "▣";
  actions.append(exchange, copy); item.append(main, actions); return item;
}

function renderGpmDetail(license) {
  gpmSelectedLicense = license;
  const bodyElement = document.querySelector("#gpmDialogBody"); if (!bodyElement) return;
  const uuid = gpmLicenseId(license);
  const title = document.querySelector("#gpmDialogTitle"); if (title) title.textContent = `${gpmValue(license.product ?? license.productName, "GPM Login")} · ${gpmValue(license.package ?? license.packageName, "License")}`;
  bodyElement.replaceChildren();
  const overview = document.createElement("dl"); overview.className = "gpm-detail-overview";
  [["License", gpmMaskedKey(license)], ["Loại", gpmValue(license.type)], ["Trạng thái", gpmStatusBadge(gpmLicenseStatus(license))], ["Hết hạn", gpmDate(license.expiresAt ?? license.expiry ?? license.expiredAt)]].forEach(([term, value]) => { const group = document.createElement("div"); const dt = document.createElement("dt"); dt.textContent = term; const dd = document.createElement("dd"); if (value instanceof Node) dd.append(value); else dd.textContent = value; group.append(dt, dd); overview.append(group); });
  const actions = document.createElement("div"); actions.className = "gpm-license-actions";
  const reveal = document.createElement("button"); reveal.type = "button"; reveal.className = "gpm-button primary"; reveal.dataset.gpmAction = "reveal"; reveal.dataset.uuid = uuid; reveal.textContent = "Hiện và sao chép license";
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "gpm-button secondary"; reset.dataset.gpmAction = "reset-devices"; reset.dataset.uuid = uuid; reset.textContent = "Reset thiết bị";
  const create = document.createElement("button"); create.type = "button"; create.className = "gpm-button secondary"; create.dataset.gpmAction = "create-sub"; create.dataset.uuid = uuid; create.textContent = "Tạo sub-license";
  const deleteAll = document.createElement("button"); deleteAll.type = "button"; deleteAll.className = "gpm-button danger"; deleteAll.dataset.gpmAction = "delete-subs"; deleteAll.dataset.uuid = uuid; deleteAll.textContent = "Xóa toàn bộ sub-license"; actions.append(reveal, reset, create, deleteAll);
  const subLicenses = Array.isArray(license.subLicenses) ? license.subLicenses : [];
  const subSection = gpmDetailSection("Sub-license", subLicenses, (subLicense) => gpmSubLicenseCard(uuid, subLicense), "License chưa có sub-license.");
  subSection.classList.add("gpm-sub-section");
  bodyElement.append(overview, actions, subSection);
}

async function loadGpmDetail(uuid, openDialog = true) {
  if (!uuid) return;
  const requestId = ++gpmDetailRequestId;
  if (openDialog) { const bodyElement = document.querySelector("#gpmDialogBody"); if (bodyElement) { bodyElement.replaceChildren(); const loading = document.createElement("p"); loading.className = "gpm-detail-empty"; loading.textContent = "Đang tải chi tiết giấy phép..."; bodyElement.append(loading); } gpmLicenseDialog?.showModal(); }
  try { const data = await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(uuid)}`); if (requestId !== gpmDetailRequestId) return; const license = data.license || data.data || data; renderGpmDetail(license); }
  catch (error) {
    if (requestId !== gpmDetailRequestId) return;
    const message = error.message || "Không tải được chi tiết license.";
    const bodyElement = document.querySelector("#gpmDialogBody");
    if (bodyElement) { const state = document.createElement("p"); state.className = "gpm-detail-empty error"; state.textContent = message; bodyElement.replaceChildren(state); }
    setGpmStatus(message, "error");
  }
}

function loadGpm({ silent = false } = {}) {
  if (gpmLoadPromise) return gpmLoadPromise;
  gpmLoaded = false; if (!silent) setGpmStatus("Đang tải tài khoản và giấy phép GPM...");
  gpmLoadPromise = (async () => { try {
    const [accountData, licensesData] = await Promise.all([gpmRequest("/admin/gpm/account"), gpmRequest("/admin/gpm/licenses")]);
    gpmAccount = accountData.account || accountData.data || accountData;
    gpmLicenses = Array.isArray(licensesData.licenses) ? licensesData.licenses : Array.isArray(licensesData.data) ? licensesData.data : Array.isArray(licensesData) ? licensesData : [];
    gpmLoaded = true; renderGpmAccount(); renderGpmLicenses(); if (!silent) setGpmStatus(`Đã đồng bộ ${gpmLicenses.length} giấy phép.`, "success");
  } catch (error) { if (!silent) { gpmAccount = null; gpmLicenses = []; renderGpmAccount(); renderGpmLicenses(); setGpmStatus(error.message || "Không tải được dữ liệu GPM Login.", "error"); } }
  finally { gpmLoadPromise = null; } })();
  return gpmLoadPromise;
}

async function copyRevealedGpmKey(path, button) {
  const originalText = button.textContent;
  button.disabled = true;
  try {
    const data = await gpmRequest(path, { method: "POST", body: {} });
    const rawKey = data.key ?? data.licenseKey ?? data.subLicenseKey;
    if (!rawKey) throw new Error("Máy chủ không trả về key.");
    await navigator.clipboard.writeText(String(rawKey));
    setGpmStatus("Đã sao chép key. Giá trị đầy đủ không được giữ trên trang.", "success");
    button.textContent = "✓";
    setTimeout(() => { button.textContent = originalText; }, 1600);
  } catch (error) { setGpmStatus(error.message || "Không thể sao chép key.", "error"); }
  finally { button.disabled = false; }
}

function openGpmSchedule(subLicense, licenseUuid) {
  const form = document.querySelector("#gpmScheduleForm"); if (!form) return;
  const schedule = gpmSubSchedule(subLicense);
  gpmScheduleLicenseUuid = licenseUuid;
  gpmScheduleSubUuid = String(subLicense.uuid ?? subLicense.id ?? "");
   form.elements.namedItem("startsAt").value = gpmDateInput(schedule.startsAt);
   form.elements.namedItem("name").value = schedule.name || "";
  form.elements.namedItem("termDays").value = String(schedule.termDays || 30);
  form.elements.namedItem("autoExchange").checked = schedule.autoExchange;
  const hint = document.querySelector("#gpmScheduleKeyHint"); if (hint) hint.textContent = gpmValue(subLicense.subLicenseMasked ?? subLicense.maskedKey ?? subLicense.keyMasked ?? subLicense.keyHint, "Sub-license");
  const status = document.querySelector("#gpmScheduleStatus"); if (status) { status.textContent = schedule.expiresAt ? `Hiện tại: ${schedule.label}, hết hạn ${gpmDate(schedule.expiresAt)}.` : "Sub-license chưa có lịch sử dụng."; status.className = "gpm-schedule-status"; }
  gpmScheduleDialog?.showModal();
}

async function refreshGpmAfterMutation(licenseUuid) {
  if (gpmLoadPromise) await gpmLoadPromise;
  await loadGpm({ silent: true });
  if (gpmLicenseDialog?.open && licenseUuid) await loadGpmDetail(licenseUuid, false);
}

// Key đầy đủ không bao giờ được nhúng vào HTML, chỉ có SHA-256 của nó. Khi người
// dùng dán trọn một key, băm phía client rồi so với data-key-hash để tìm đúng
// hàng; các truy vấn ngắn hơn vẫn khớp theo key_hint trong data-search.
const keyHashCache = new Map();
async function sha256Hex(value) {
  if (keyHashCache.has(value)) return keyHashCache.get(value);
  if (!crypto?.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  keyHashCache.set(value, hex);
  return hex;
}

function sortAccountRows() {
  const table = document.querySelector('[data-table="accounts"]');
  const tbody = table?.querySelector("tbody");
  const mode = document.querySelector("[data-sort-select]")?.value || "oldest";
  if (!tbody) return;
  const rows = Array.from(tbody.querySelectorAll("tr[data-search]"));
  if (!rows.length) return;
  const time = (row, field) => {
    const parsed = Date.parse(row.dataset[field] || "");
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  const sorted = rows.slice().sort((a, b) => {
    if (mode === "expiring") return time(a, "expires") - time(b, "expires");
    if (mode === "newest") return time(b, "created") - time(a, "created");
    return time(a, "created") - time(b, "created");
  });
  tbody.append(...sorted);
}

async function filterTable(name) {
  const table = document.querySelector(`[data-table="${name}"]`);
  const search = document.querySelector(`[data-table-search="${name}"]`);
  if (!table || !search) return;
  const raw = search.value.trim();
  const query = raw.toLocaleLowerCase("vi");
  const statusFilter = name === "accounts" ? document.querySelector("[data-status-filter]")?.value || "all" : "all";
  const keyHash = name === "accounts" && raw.length >= 20 ? await sha256Hex(raw) : "";

  const rows = Array.from(table.querySelectorAll("tbody tr[data-search]"));
  rows.forEach((row) => {
    const matchesQuery = !query || row.dataset.search.includes(query) || Boolean(keyHash) && row.dataset.keyHash === keyHash;
    let matchesStatus = true;
    if (statusFilter === "active") matchesStatus = row.dataset.status === "active";
    else if (statusFilter === "online") matchesStatus = row.dataset.online === "true";
    else if (statusFilter === "offline") matchesStatus = row.dataset.online === "false";
    else if (statusFilter === "locked") matchesStatus = row.dataset.status === "locked";

    row.style.display = (matchesQuery && matchesStatus) ? "" : "none";
  });
}

// Realtime Status Polling
async function updateRealtimeStatus() {
  try {
    const response = await fetch("/admin/realtime-status");
    if (!response.ok) return;
    const data = await response.json();
    if (!data || !Array.isArray(data.accounts)) return;
    data.accounts.forEach((item) => {
      const checkbox = document.querySelector(`.toggle-switch-input[data-id="${item.id}"]`);
      if (!checkbox) return;
      const row = checkbox.closest("tr");
      if (!row) return;
      
      row.dataset.online = item.isOnline ? "true" : "false";
      row.dataset.status = item.status;

      const pill = row.querySelector(".status-pill");
      if (pill) {
        pill.className = `status-pill ${item.isOnline ? "online" : "offline"}`;
        pill.textContent = item.isOnline ? "🟢 Trực tuyến" : "⚪ Ngoại tuyến";
      }

      const lastSeenEl = row.querySelector(".last-seen-text");
      if (lastSeenEl && item.lastSeenFormatted) {
        lastSeenEl.textContent = item.lastSeenFormatted;
      }

      if (!document.activeElement || document.activeElement !== checkbox) {
        const isEnabled = item.status === "active" && item.enabled !== 0;
        checkbox.checked = isEnabled;
      }
    });
  } catch {}
}
setInterval(updateRealtimeStatus, 5000);

// Initial Theme - default to LIGHT
const savedTheme = localStorage.getItem("zpm-admin-theme");
setTheme(savedTheme === "dark" ? "dark" : "light");

document.addEventListener("input", (event) => {
  const name = event.target.dataset.tableSearch;
  if (name) filterTable(name);
  if (event.target.id === "vlessSearch") renderVlessClients();
  if (event.target.id === "protonSessionSearch") renderProtonSessions();
  if (event.target.id === "gpmSearch") renderGpmLicenses();
});

function updateBulkActionUI() {
  const checkedBoxes = Array.from(document.querySelectorAll('.data-table[data-table="accounts"] .row-checkbox:checked'));
  const count = checkedBoxes.length;
  const selectEl = document.querySelector("#bulkActionSelect");
  const applyBtn = document.querySelector("#applyBulkActionBtn");
  
  if (selectEl && selectEl.options[0]) {
    selectEl.options[0].textContent = `⚡ Thao tác hàng loạt (${count} đã chọn)`;
  }
  
  if (applyBtn) {
    applyBtn.disabled = count === 0 || !selectEl || !selectEl.value;
  }
}

document.addEventListener("change", async (event) => {
  if (event.target.matches("[data-status-filter]")) {
    filterTable("accounts");
  }

  if (event.target.matches("[data-sort-select]")) {
    sortAccountRows();
  }

  if (event.target.id === "bulkActionSelect") {
    updateBulkActionUI();
  }
  if (event.target.id === "vlessInboundFilter") renderVlessClients();
  if (event.target.id === "protonSessionStatus") renderProtonSessions();
  if (event.target.id === "protonSessionAccount") loadProtonSessions(event.target.value);
  if (event.target.id === "gpmStatusFilter") renderGpmLicenses();

  // Select All Checkbox Handler
  if (event.target.id === "selectAllCheckbox") {
    const isChecked = event.target.checked;
    const visibleRows = Array.from(document.querySelectorAll('.data-table[data-table="accounts"] tbody tr')).filter(r => r.style.display !== "none");
    visibleRows.forEach((row) => {
      const cb = row.querySelector(".row-checkbox");
      if (cb) cb.checked = isChecked;
    });
    updateBulkActionUI();
  } else if (event.target.classList.contains("row-checkbox")) {
    const visibleRows = Array.from(document.querySelectorAll('.data-table[data-table="accounts"] tbody tr')).filter(r => r.style.display !== "none");
    const visibleCbs = visibleRows.map(r => r.querySelector(".row-checkbox")).filter(Boolean);
    const selectAll = document.querySelector("#selectAllCheckbox");
    if (selectAll && visibleCbs.length > 0) {
      selectAll.checked = visibleCbs.every(cb => cb.checked);
    }
    updateBulkActionUI();
  }

  // Fast AJAX Toggle Switch handler
  if (event.target.classList.contains("toggle-switch-input")) {
    const checkbox = event.target;
    const accountId = checkbox.dataset.id;
    const csrf = getCsrfToken();
    try {
      const response = await fetch(`/admin/accounts/${accountId}/toggle`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf
        },
        body: JSON.stringify({ csrf })
      });
      const data = await response.json();
      if (!response.ok) {
        checkbox.checked = !checkbox.checked;
        alert(data.error || "Thao tác thất bại.");
      } else {
        const row = checkbox.closest("tr");
        if (row) row.dataset.status = data.status;
      }
    } catch (err) {
      checkbox.checked = !checkbox.checked;
      alert("Lỗi kết nối máy chủ.");
    }
  }
});

document.addEventListener("click", async (event) => {
  const target = event.target;

  const backdropDialog = target.closest("dialog");
  if (backdropDialog && target === backdropDialog) {
    const bounds = backdropDialog.getBoundingClientRect();
    const outside = event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    if (outside) closeDialog(backdropDialog);
    return;
  }

  const gpmAction = target.closest("[data-gpm-action]");
  if (gpmAction) {
    const action = gpmAction.dataset.gpmAction;
    const uuid = gpmAction.dataset.uuid;
    if (action === "detail") { await loadGpmDetail(uuid); return; }
    if (action === "reveal") { await copyRevealedGpmKey(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/reveal`, gpmAction); return; }
    if (action === "reset-devices") {
      if (!confirm("Reset toàn bộ thiết bị của license này? Thao tác này có thể đăng xuất các thiết bị đang dùng.")) return;
      gpmAction.disabled = true;
      try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/reset-devices`, { method: "POST", body: {} }); setGpmStatus("Đã reset thiết bị của license.", "success"); await refreshGpmAfterMutation(uuid); }
      catch (error) { setGpmStatus(error.message || "Không reset được thiết bị.", "error"); }
      finally { gpmAction.disabled = false; }
      return;
    }
    if (action === "reveal-sub") { await copyRevealedGpmKey(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/sub-licenses/${encodeURIComponent(gpmAction.dataset.subUuid)}/reveal`, gpmAction); return; }
    if (action === "schedule") {
      const subLicense = gpmSelectedLicense?.subLicenses?.find((item) => String(item.uuid ?? item.id ?? "") === gpmAction.dataset.subUuid);
      if (subLicense) openGpmSchedule(subLicense, uuid);
      return;
    }
    if (action === "exchange-sub") {
      if (!confirm("Exchange sẽ làm key cũ mất hiệu lực ngay lập tức. Người dùng đang dùng key cũ sẽ phải nhận key mới. Tiếp tục?")) return;
      gpmAction.disabled = true;
      try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/sub-licenses/${encodeURIComponent(gpmAction.dataset.subUuid)}/exchange`, { method: "POST", body: {} }); setGpmStatus("Đã exchange sub-license. Key cũ không còn hiệu lực.", "success"); await refreshGpmAfterMutation(uuid); }
      catch (error) { setGpmStatus(error.message || "Không exchange được sub-license.", "error"); }
      finally { gpmAction.disabled = false; }
      return;
    }
    if (action === "create-sub") {
      const rawQuantity = prompt("Số lượng sub-license cần tạo (1-100):", "1");
      if (rawQuantity === null) return;
      const quantity = Number(rawQuantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) { setGpmStatus("Số lượng sub-license phải là số nguyên từ 1 đến 100.", "error"); return; }
      gpmAction.disabled = true;
      try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/sub-licenses`, { method: "POST", body: { quantity } }); setGpmStatus(`Đã tạo ${quantity} sub-license.`, "success"); await Promise.all([loadGpm(), loadGpmDetail(uuid, false)]); }
      catch (error) { setGpmStatus(error.message || "Không tạo được sub-license.", "error"); }
      finally { gpmAction.disabled = false; }
      return;
    }
    if (action === "delete-subs") {
      if (!confirm("Xóa toàn bộ sub-license của license này? Tất cả sub-license đã phát hành sẽ ngừng hoạt động và không thể khôi phục.")) return;
      gpmAction.disabled = true;
      try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(uuid)}/sub-licenses/all`, { method: "DELETE", body: {} }); setGpmStatus("Đã xóa toàn bộ sub-license.", "success"); await Promise.all([loadGpm(), loadGpmDetail(uuid, false)]); }
      catch (error) { setGpmStatus(error.message || "Không xóa được sub-license.", "error"); }
      finally { gpmAction.disabled = false; }
      return;
    }
  }
  const extendButton = target.closest("[data-gpm-extend-days]");
  if (extendButton) {
    if (!gpmScheduleLicenseUuid || !gpmScheduleSubUuid) return;
    const days = Number(extendButton.dataset.gpmExtendDays);
    extendButton.disabled = true;
    try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(gpmScheduleLicenseUuid)}/sub-licenses/${encodeURIComponent(gpmScheduleSubUuid)}/extend`, { method: "POST", body: { days } }); const licenseUuid = gpmScheduleLicenseUuid; gpmScheduleDialog?.close(); gpmScheduleLicenseUuid = ""; gpmScheduleSubUuid = ""; setGpmStatus(`Đã gia hạn sub-license thêm ${days} ngày.`, "success"); await refreshGpmAfterMutation(licenseUuid); }
    catch (error) { const status = document.querySelector("#gpmScheduleStatus"); if (status) { status.textContent = error.message || "Không gia hạn được sub-license."; status.className = "gpm-schedule-status error"; } }
    finally { extendButton.disabled = false; }
    return;
  }
  if (target.closest("#gpmRefreshButton")) { await loadGpm(); return; }

  const protonAccountItem = target.closest(".proton-account-item");
  if (protonAccountItem && !target.closest("[data-proton-account-action], [data-proton-refresh-credentials]")) {
    protonSelectedAccountId = protonAccountItem.dataset.id;
    const select = document.querySelector("#protonSessionAccount"); if (select) select.value = protonSelectedAccountId;
    document.querySelectorAll(".proton-account-item").forEach((item) => { const selected = item === protonAccountItem; item.classList.toggle("selected", selected); item.setAttribute("aria-pressed", String(selected)); });
    const account = protonAccounts.find((item) => String(item.id ?? item.uuid) === protonSelectedAccountId); const breadcrumb = document.querySelector("#protonBreadcrumbName"); if (breadcrumb) breadcrumb.textContent = account?.name || account?.email || "Tài khoản";
    await loadProtonSessions(protonSelectedAccountId); return;
  }

  const protonAccountAction = target.closest("[data-proton-account-action]");
  if (protonAccountAction) {
    const account = protonAccounts.find((item) => String(item.id ?? item.uuid) === protonAccountAction.dataset.id);
    if (protonAccountAction.dataset.protonAccountAction === "edit") { openProtonAccountDialog(account); return; }
    if (protonAccountAction.dataset.protonAccountAction === "delete") {
      if (!account || !confirm(`Xóa Proton account '${account.name}'? Account còn rental sẽ không thể xóa.`)) return;
      protonAccountAction.disabled = true;
      try { await protonRequest(`/admin/proton/accounts/${account.id}`, { method: "DELETE", body: {} }); await loadProton(); setProtonStatus("Đã xóa Proton account.", "success"); }
      catch (error) { setProtonStatus(error.message || "Không xóa được account.", "error"); } finally { protonAccountAction.disabled = false; }
      return;
    }
  }

  const protonSessionAction = target.closest("[data-proton-session-action]");
  if (protonSessionAction) {
    const session = protonSessions[Number(protonSessionAction.dataset.index)];
    if (!session) return;
    const action = protonSessionAction.dataset.protonSessionAction;
    if (action === "edit") { openProtonRentalDialog(session); return; }
    if (action === "unassign") {
      if (!confirm("Bỏ gán rental khỏi thiết bị này?")) return;
      try { await protonRequest(`/admin/proton/rentals/${encodeURIComponent(session.sessionUid)}`, { method: "DELETE", body: {} }); await loadProton(); setProtonStatus("Đã bỏ gán rental.", "success"); }
      catch (error) { setProtonStatus(error.message || "Không bỏ gán được rental.", "error"); }
      return;
    }
    if (action === "revoke") {
      if (!confirm("Revoke thiết bị này khỏi Proton VPN? Đây là thao tác destructive.")) return;
      try { const accountId = document.querySelector("#protonSessionAccount")?.value; await protonRequest(`/admin/proton/accounts/${encodeURIComponent(accountId)}/sessions/${encodeURIComponent(session.sessionUid)}/revoke`, { method: "POST", body: {} }); await loadProtonSessions(accountId); setProtonStatus("Đã revoke thiết bị.", "success"); }
      catch (error) { setProtonStatus(error.message || "Không revoke được thiết bị.", "error"); }
      return;
    }
  }

  const protonCopy = target.closest("[data-proton-copy-uid]");
  if (protonCopy) { try { await navigator.clipboard.writeText(protonCopy.dataset.protonCopyUid); protonCopy.textContent = "✓"; setTimeout(() => { protonCopy.textContent = "📋"; }, 1400); } catch { setProtonStatus("Không thể copy UID mask.", "error"); } return; }
  if (target.closest("#newProtonAccountButton")) { openProtonAccountDialog(); return; }
  if (target.closest("#protonRefreshButton")) { await loadProton(); return; }
  const protonRefreshCredentials = target.closest("[data-proton-refresh-credentials]");
  if (protonRefreshCredentials) {
    const accountId = protonRefreshCredentials.dataset.protonRefreshCredentials;
    protonRefreshCredentials.disabled = true;
    try { await protonRequest(`/admin/proton/accounts/${encodeURIComponent(accountId)}/refresh-credentials`, { method: "POST", body: {} }); await loadProton(); setProtonStatus("Đã renew cookie Proton.", "success"); }
    catch (error) { setProtonStatus(error.message || "Không renew được cookie Proton.", "error"); }
    finally { protonRefreshCredentials.disabled = false; }
    return;
  }
  if (target.closest("#protonPortabilityButton")) { protonPortabilityDialog?.showModal(); return; }
  if (target.closest("#protonDryRunButton") || target.closest("#protonCleanupButton")) {
    const dryRun = Boolean(target.closest("#protonDryRunButton")); const accountId = document.querySelector("#protonSessionAccount")?.value;
    if (!accountId || (!dryRun && !confirm("Cleanup sẽ revoke các thiết bị rental đã hết hạn. Tiếp tục?"))) return;
    const button = target.closest("button"); button.disabled = true;
    try { const result = await protonRequest(`/admin/proton/accounts/${encodeURIComponent(accountId)}/cleanup`, { method: "POST", body: { dryRun } }); setProtonStatus(`${dryRun ? "Dry-run" : "Cleanup"}: quét ${result.scanned || 0}, đủ điều kiện ${result.eligible || 0}, revoke ${result.revoked || 0}.`, "success"); if (!dryRun) await loadProton(); else await loadProtonSessions(accountId); }
    catch (error) { setProtonStatus(error.message || "Cleanup Proton thất bại.", "error"); } finally { button.disabled = false; }
    return;
  }
  if (target.closest("#exportProtonJson")) { try { await downloadProtonExport("/admin/proton/export.json", "proton-rentals.json"); } catch (error) { setProtonStatus(error.message, "error"); } return; }
  if (target.closest("#exportProtonCsv")) { try { await downloadProtonExport("/admin/proton/export.csv", "proton-rentals.csv"); } catch (error) { setProtonStatus(error.message, "error"); } return; }

  if (target.closest("#refreshVlessButton")) { vlessLoaded = false; await loadVless(); return; }
  if (target.closest(".new-vless-trigger")) { newVlessDialog?.showModal(); return; }
  const vlessAction = target.closest("[data-vless-action]");
  if (vlessAction) {
    if (vlessAction.disabled) return;
    const email = vlessAction.dataset.email;
    const action = vlessAction.dataset.vlessAction;
    if (action === "delete" && !confirm(`Xóa VLESS client '${email}' khỏi panel?`)) return;
    vlessAction.disabled = true;
    try {
      const response = await fetch(`/admin/vless/clients/${encodeURIComponent(email)}${action === "copy" ? "/reveal" : ""}`, {
        method: action === "copy" ? "POST" : "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
        body: JSON.stringify({ csrf: getCsrfToken() }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Thao tác VLESS thất bại.");
      if (action === "copy") {
        try { await navigator.clipboard.writeText(data.key); setVlessStatus(`Đã sao chép VLESS key của ${email}.`, "success"); }
        catch { setVlessStatus(`Đã lấy key của ${email} nhưng trình duyệt chặn clipboard. Hãy cấp quyền clipboard rồi thử lại.`, "error"); }
      }
      else { setVlessStatus(`Đã xóa VLESS client ${email}.`, "success"); await loadVless(); }
    } catch (error) { setVlessStatus(error.message || "Thao tác VLESS thất bại.", "error"); }
    finally { vlessAction.disabled = false; }
    return;
  }

  // Apply Bulk Action Button
  if (target.id === "applyBulkActionBtn") {
    const selectEl = document.querySelector("#bulkActionSelect");
    const action = selectEl?.value;
    const checkedBoxes = Array.from(document.querySelectorAll('.data-table[data-table="accounts"] .row-checkbox:checked'));
    const ids = checkedBoxes.map(cb => Number(cb.value)).filter(Boolean);
    
    if (!action || ids.length === 0) {
      alert("Vui lòng chọn ít nhất 1 khách hàng và 1 thao tác.");
      return;
    }
    
    if (!confirm(`Xác nhận thực hiện thao tác hàng loạt trên ${ids.length} khách hàng đã chọn?`)) {
      return;
    }
    
    const csrf = getCsrfToken();
    try {
      const response = await fetch("/admin/accounts/bulk-action", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf
        },
        body: JSON.stringify({ csrf, action, ids })
      });
      const data = await response.json();
      if (!response.ok) {
        alert(data.error || "Thao tác hàng loạt thất bại.");
      } else {
        location.reload();
      }
    } catch (err) {
      alert("Lỗi kết nối máy chủ khi thực hiện thao tác hàng loạt.");
    }
    return;
  }

  // Copy key button
  const copyButton = target.closest("[data-copy-key]");
  if (copyButton) {
    try {
      await navigator.clipboard.writeText(copyButton.dataset.copyKey);
      const origText = copyButton.textContent;
      copyButton.textContent = "Đã copy!";
      setTimeout(() => { copyButton.textContent = origText; }, 1600);
    } catch {
      copyButton.textContent = "Copy lỗi";
    }
    return;
  }

  // Copy full key row button
  const rowCopyBtn = target.closest('[data-action="copy"]');
  if (rowCopyBtn) {
    const origText = rowCopyBtn.textContent;
    try {
      const response = await fetch(`/admin/accounts/${rowCopyBtn.dataset.id}/reveal-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
        body: JSON.stringify({ csrf: getCsrfToken() }),
      });
      const data = await response.json();
      if (!response.ok || !data.key) {
        alert(data.error || "Không lấy được key đầy đủ.");
        return;
      }
      await navigator.clipboard.writeText(data.key);
      rowCopyBtn.textContent = "✓";
      setTimeout(() => { rowCopyBtn.textContent = origText; }, 1600);
    } catch {
      alert("Copy không thành công.");
    }
    return;
  }

  // Action: Open Edit Account modal
  const editBtn = target.closest('[data-action="edit"]');
  if (editBtn) {
    const id = editBtn.dataset.id;
    document.querySelector("#editAccountForm").action = `/admin/accounts/${id}/action`;
    document.querySelector("#editName").value = editBtn.dataset.name || "";
    document.querySelector("#editPlan").value = editBtn.dataset.plan || "";
    document.querySelector("#editNote").value = editBtn.dataset.note || "";
    document.querySelector("#editExpiry").value = editBtn.dataset.expiry || "";
    editAccountDialog?.showModal();
    return;
  }

  // Sidebar navigation
  const viewButton = target.closest("[data-view-target]");
  if (viewButton) return setView(viewButton.dataset.viewTarget);

  // Theme toggle
  if (target.closest(".theme-toggle")) return setTheme(root.dataset.theme === "light" ? "dark" : "light");

  // Mobile menu toggle
  if (target.closest(".menu-toggle")) {
    const open = body.classList.toggle("sidebar-open");
    document.querySelector(".menu-toggle").setAttribute("aria-expanded", String(open));
    return;
  }

  if (target.closest(".sidebar-backdrop")) return closeSidebar();

  // New Account Dialog trigger (+ Thêm khách hàng)
  if (target.closest(".new-account-trigger")) {
    const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
    const startDateInput = document.querySelector("#newAccountStartDate");
    if (startDateInput && !startDateInput.value) startDateInput.value = today;
    return newAccountDialog?.showModal();
  }

  // Close dialog buttons
  if (target.closest(".dialog-close") || target.closest(".dialog-cancel")) {
    closeDialog(target.closest("dialog"));
    return;
  }

  // Close toast
  if (target.closest(".toast-close")) return target.closest(".message-toast")?.classList.remove("show");
});

document.addEventListener("keydown", (event) => {
  const item = event.target.closest?.(".proton-account-item");
  if (item && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); item.click(); }
});

document.querySelector("#vlessCreateForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = document.querySelector("#createVlessButton");
  if (button) button.disabled = true;
  try {
    const values = Object.fromEntries(new FormData(form));
    const response = await fetch("/admin/vless/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": getCsrfToken() },
      body: JSON.stringify(values),
    });
    const data = await response.json();
    if (!response.ok && !data.created) throw new Error(data.error || "Không tạo được VLESS client.");
    newVlessDialog?.close();
    form.reset();
    await loadVless();
    if (data.key) {
      try { await navigator.clipboard.writeText(data.key); setVlessStatus(`Đã tạo và sao chép VLESS key của ${data.email}.`, "success"); }
      catch { setVlessStatus(`Đã tạo ${data.email}, nhưng trình duyệt chặn clipboard. Hãy cấp quyền rồi dùng nút sao chép trong danh sách.`, "error"); }
    }
    else setVlessStatus(data.error || "Client đã được tạo nhưng chưa lấy được key.", "error");
  } catch (error) { setVlessStatus(error.message || "Không tạo được VLESS client.", "error"); }
  finally { if (button) button.disabled = vlessInbounds.length === 0; }
});

document.querySelector("#protonAccountForm")?.addEventListener("submit", submitProtonAccount);
document.querySelector("#gpmScheduleForm")?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const startsAt = form.elements.namedItem("startsAt").value;
  const termDays = Number(form.elements.namedItem("termDays").value);
   const autoExchange = form.elements.namedItem("autoExchange").checked;
   const name = String(form.elements.namedItem("name").value || "").trim();
   if (!gpmScheduleLicenseUuid || !gpmScheduleSubUuid || !startsAt || name.length > 120 || !Number.isInteger(termDays) || termDays < 1) return;
  if (submit) submit.disabled = true;
   try { await gpmRequest(`/admin/gpm/licenses/${encodeURIComponent(gpmScheduleLicenseUuid)}/sub-licenses/${encodeURIComponent(gpmScheduleSubUuid)}/schedule`, { method: "PUT", body: { name, startsAt, termDays, autoExchange } }); const licenseUuid = gpmScheduleLicenseUuid; gpmScheduleDialog?.close(); gpmScheduleLicenseUuid = ""; gpmScheduleSubUuid = ""; setGpmStatus("Đã cập nhật lịch sub-license.", "success"); await refreshGpmAfterMutation(licenseUuid); }
  catch (error) { const status = document.querySelector("#gpmScheduleStatus"); if (status) { status.textContent = error.message || "Không lưu được lịch sub-license."; status.className = "gpm-schedule-status error"; } }
  finally { if (submit) submit.disabled = false; }
});
document.querySelector("#protonRentalForm")?.addEventListener("submit", async (event) => {
  event.preventDefault(); const form = event.currentTarget; const values = Object.fromEntries(new FormData(form)); const expiresAt = values.expiresAt ? new Date(values.expiresAt).toISOString() : "";
  const body = { accountId: Number(values.accountId), customer: values.customer, phone: values.phone, note: values.note, ...(expiresAt ? { expiresAt } : { duration: Number(values.duration), unit: "days" }) };
  const button = form.querySelector("button[type=submit]"); if (button) button.disabled = true;
  try { await protonRequest(`/admin/proton/rentals/${encodeURIComponent(protonRentalSessionUid)}`, { method: "PUT", body }); protonRentalDialog?.close(); protonRentalSessionUid = ""; await loadProton(); setProtonStatus("Đã lưu rental.", "success"); }
  catch (error) { setProtonStatus(error.message || "Không lưu được rental.", "error"); } finally { if (button) button.disabled = false; }
});

document.querySelector("#protonImportFile")?.addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  const overwrite = document.querySelector("#protonImportOverwrite")?.checked;
  if (overwrite && !confirm("Import với ghi đè có thể thay đổi rental hiện tại. Tiếp tục?")) { event.target.value = ""; return; }
  try { const parsed = JSON.parse(await file.text()); const payload = Array.isArray(parsed) ? { rentals: parsed, overwrite } : { ...parsed, overwrite }; await protonRequest("/admin/proton/import", { method: "POST", body: payload }); event.target.value = ""; protonPortabilityDialog?.close(); await loadProton(); setProtonStatus("Đã import rental metadata.", "success"); }
  catch (error) { event.target.value = ""; setProtonStatus(error.message || "Import JSON thất bại.", "error"); }
});

document.addEventListener("submit", (event) => {
  const form = event.target;
  const action = form.querySelector('select[name="action"]')?.value;
  const dangerous = ["lock", "force_logout", "reset_binding", "archive"].includes(action);
  if (!dangerous || form.dataset.confirmed === "true") return;
  event.preventDefault();
  pendingForm = null;
  confirmDialog.returnValue = "";
  pendingForm = form;
  const messages = {
    lock: "Khóa account sẽ chặn quyền sử dụng và gửi lệnh tới thiết bị đang chạy.",
    force_logout: "Agent sẽ nhận lệnh đăng xuất và phiên hiện tại bị thu hồi sau khi ACK.",
    reset_binding: "Thiết bị hiện tại sẽ bị gỡ liên kết và account phải kích hoạt lại.",
    archive: "Account sẽ bị khóa, thu hồi phiên và chuyển sang vùng lưu trữ.",
  };
  document.querySelector("#confirmMessage").textContent = messages[action];
  confirmDialog?.showModal();
});

confirmDialog?.addEventListener("close", () => {
  const confirmedForm = confirmDialog.returnValue === "confirm" ? pendingForm : null;
  pendingForm = null;
  confirmDialog.returnValue = "";
  if (confirmedForm) {
    confirmedForm.dataset.confirmed = "true";
    confirmedForm.requestSubmit();
  }
});

const toast = document.querySelector(".message-toast");
if (toast?.dataset.message?.trim()) toast.classList.add("show");

// Server trả hàng theo id giảm dần; áp thứ tự của bộ lọc ngay khi tải trang để
// lựa chọn mặc định "Cũ nhất trước" khớp với những gì hiển thị.
sortAccountRows();

setInterval(async () => {
  const gpmView = document.querySelector('[data-view="gpm"]');
  if (document.hidden || !gpmView || gpmView.hidden || gpmLoadPromise) return;
  await loadGpm({ silent: true });
  if (gpmLicenseDialog?.open && gpmSelectedLicense) await loadGpmDetail(gpmLicenseId(gpmSelectedLicense), false);
}, 30000);
