const colors = ["#61d49a", "#67a7ff", "#f1ba62", "#d889d8", "#ef8077", "#8e9df0"];

const state = {
  profiles: [],
  query: "",
  sort: "asc",
  deleteId: null,
  page: "profiles",
  account: { status: "checking", uid: "", canOperate: false },
  update: { status: "idle", currentVersion: "0.3.0", latestVersion: "0.3.0", progress: 0, checkedAt: null, error: "" },
};

const DESIGN_WIDTH = 1280;
const DESIGN_HEIGHT = 900;

function scaleUiToContent(size) {
  const width = Number(size?.[0]);
  const height = Number(size?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const scale = Math.max(0.5, Math.min(2, Math.min(width / DESIGN_WIDTH, height / DESIGN_HEIGHT)));
  const offsetX = Math.max(0, (width - DESIGN_WIDTH * scale) / 2);
  const offsetY = Math.max(0, (height - DESIGN_HEIGHT * scale) / 2);
  const root = document.documentElement;
  root.style.setProperty("--ui-scale", String(scale));
  root.style.setProperty("--ui-offset-x", `${offsetX}px`);
  root.style.setProperty("--ui-offset-y", `${offsetY}px`);
}

window.windowApi?.onContentSize(scaleUiToContent);

const accountStatusLabels = {
  active: "Đang hoạt động",
  inactive: "Chưa kích hoạt",
  unconfigured: "Chưa cấu hình máy chủ",
  checking: "Đang xác thực",
  "offline-grace": "Mất mạng · đang trong grace",
  "offline-blocked": "Mất mạng · đã chặn",
  locked: "Tài khoản bị khóa",
  expired: "Tài khoản hết hạn",
  revoked: "Phiên đã bị thu hồi",
  blocked: "Phản hồi máy chủ không hợp lệ · đã chặn",
  "credential-error": "Credential lỗi · cần đặt lại",
};

const elements = {
  list: document.querySelector("#profileList"),
  empty: document.querySelector("#emptyState"),
  search: document.querySelector("#searchInput"),
  sortButton: document.querySelector("#sortButton"),
  sortMenu: document.querySelector("#sortMenu"),
  dialog: document.querySelector("#profileDialog"),
  form: document.querySelector("#profileForm"),
  confirmDialog: document.querySelector("#confirmDialog"),
  proxyFields: document.querySelector("#proxyFields"),
  testResult: document.querySelector("#proxyTestResult"),
  formError: document.querySelector("#formError"),
  toast: document.querySelector("#toast"),
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function activityTime(value) {
  if (!value) return "Chưa từng mở";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Không xác định";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    minute: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.hour}:${parts.minute} - ${parts.day}/${parts.month}/${parts.year}`;
}

function accountDate(value) {
  if (!value) return "Chưa có";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Không xác định" : new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(date);
}

function renderAccount() {
  const account = state.account;
  const label = accountStatusLabels[account.status] || account.status;
  const active = account.status === "active";
  document.querySelector("#accountStatusBadge").textContent = label;
  document.querySelector("#accountStatusBadge").className = `account-badge ${active ? "active" : "blocked"}`;
  document.querySelector("#navAccountStatus").textContent = active ? "ON" : "OFF";
  document.querySelector("#accountPulse").className = `pulse ${active ? "" : "blocked"}`;
  document.querySelector("#sidebarAccountStatus").textContent = label;
  document.querySelector("#sidebarAccountPlan").textContent = account.plan || "Chưa có gói";
  document.querySelector("#sidebarAccountExpiry").textContent = account.expiresAt ? `Hết hạn ${accountDate(account.expiresAt)}` : "";
  document.querySelector("#accountDetailStatus").textContent = label;
  document.querySelector("#accountKeyHint").textContent = account.keyHint || "Chưa có";
  document.querySelector("#accountPlan").textContent = account.plan || "Chưa có";
  document.querySelector("#accountActivated").textContent = accountDate(account.activatedAt);
  document.querySelector("#accountExpires").textContent = accountDate(account.expiresAt);
  document.querySelector("#accountLogout").disabled = !account.uid || account.status === "inactive" || account.status === "unconfigured" || account.status === "credential-error";
  document.querySelector("#accountRecover").hidden = account.status !== "credential-error";
  document.querySelectorAll('[data-action="create"]').forEach((button) => { button.disabled = !account.canOperate; });
}

function renderUpdate() {
  const update = state.update;
  const copy = {
    idle: ["Sẵn sàng kiểm tra", "ZPool sẽ tự kiểm tra bản phát hành mới."],
    checking: ["Đang kiểm tra phiên bản", "Đang kết nối tới 292Server..."],
    available: [`Đã tìm thấy ZPool ${update.latestVersion}`, "Bản mới đang được tải tự động."],
    downloading: [`Đang tải ZPool ${update.latestVersion}`, `Đã tải ${update.progress || 0}% bộ cài.`],
    downloaded: [`ZPool ${update.latestVersion} đã sẵn sàng`, "Đóng các profile đang chạy và cài phiên bản mới."],
    "up-to-date": ["Bạn đang dùng bản mới nhất", "Không có bản cập nhật nào cần tải."],
    error: ["Chưa thể kiểm tra cập nhật", update.error || "Hãy kiểm tra kết nối mạng và thử lại."],
  }[update.status] || ["Trạng thái cập nhật", "Đang đồng bộ thông tin."];
  document.querySelector("#updateTitle").textContent = copy[0];
  document.querySelector("#updateMessage").textContent = copy[1];
  document.querySelector("#updateCurrentVersion").textContent = `v${update.currentVersion}`;
  document.querySelector("#updateLatestVersion").textContent = update.latestVersion ? `v${update.latestVersion}` : "Chưa xác định";
  document.querySelector("#sidebarVersion").textContent = `v${update.currentVersion}`;
  const checked = update.checkedAt ? new Date(update.checkedAt) : null;
  document.querySelector("#updateCheckedAt").textContent = checked && !Number.isNaN(checked.getTime())
    ? new Intl.DateTimeFormat("vi-VN", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit", year: "numeric" }).format(checked)
    : "Chưa kiểm tra";
  const busy = update.status === "checking" || update.status === "downloading" || update.status === "available";
  document.querySelector("#checkUpdateButton").disabled = busy;
  document.querySelector("#installUpdateButton").hidden = update.status !== "downloaded";
  document.querySelector("#updateProgressWrap").hidden = update.status !== "downloading";
  document.querySelector("#updateProgress").value = update.progress || 0;
  document.querySelector("#updateProgressText").textContent = `${update.progress || 0}%`;
  document.querySelector("#updateOrbit").classList.toggle("checking", busy);
  document.querySelector("#updateSignal").className = `update-signal ${update.status}`;
  document.querySelector("#navUpdateStatus").textContent = update.status === "downloaded" ? "NEW" : update.status === "downloading" ? `${update.progress || 0}%` : "AUTO";
  document.querySelector("#navUpdateStatus").classList.toggle("available", update.status === "downloaded");
}

function closeSortMenu(returnFocus = false) {
  elements.sortMenu.hidden = true;
  elements.sortButton.setAttribute("aria-expanded", "false");
  if (returnFocus) elements.sortButton.focus();
}

function selectSort(direction) {
  state.sort = direction === "desc" ? "desc" : "asc";
  elements.sortMenu.querySelectorAll("[data-sort]").forEach((button) => {
    const selected = button.dataset.sort === state.sort;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-checked", String(selected));
  });
  const label = state.sort === "desc" ? "Z-A" : "A-Z";
  elements.sortButton.title = `Sắp xếp profile: ${label}`;
  elements.sortButton.setAttribute("aria-label", `Sắp xếp profile: ${label}`);
}

function switchPage(page) {
  state.page = ["profiles", "account", "update"].includes(page) ? page : "profiles";
  document.querySelector("#profilesPage").hidden = state.page !== "profiles";
  document.querySelector("#accountPage").hidden = state.page !== "account";
  document.querySelector("#updatePage").hidden = state.page !== "update";
  document.querySelectorAll("[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === state.page));
}

function render() {
  const normalizedQuery = state.query.toLowerCase();
  const visible = state.profiles.filter((profile) => {
    const proxy = profile.proxy.enabled ? `${profile.proxy.host}:${profile.proxy.port}` : "";
    return `${profile.name} ${profile.note} ${proxy}`.toLowerCase().includes(normalizedQuery);
  }).sort((left, right) => {
    const comparison = left.name.localeCompare(right.name, "vi", { sensitivity: "base", numeric: true });
    return state.sort === "desc" ? -comparison : comparison;
  });

  document.querySelector("#navCount").textContent = state.profiles.length;
  document.querySelector("#metricTotal").textContent = String(state.profiles.length).padStart(2, "0");
  document.querySelector("#metricRunning").textContent = String(state.profiles.filter((profile) => profile.running).length).padStart(2, "0");
  document.querySelector("#metricProxy").textContent = String(state.profiles.filter((profile) => {
    const route = profile.running && profile.activeProxy ? profile.activeProxy : profile.proxy;
    return route.enabled;
  }).length).padStart(2, "0");

  elements.empty.hidden = state.profiles.length > 0 || Boolean(state.query);
  elements.list.hidden = visible.length === 0;
  elements.list.innerHTML = visible.map((profile) => {
    const displayedProxy = profile.restartRequired && profile.activeProxy ? profile.activeProxy : profile.proxy;
    const proxyLabel = displayedProxy.enabled
      ? `${displayedProxy.protocol.toUpperCase()} • ${displayedProxy.host}:${displayedProxy.port}`
      : "DIRECT";
    const pendingProxyLabel = profile.proxy.enabled
      ? `${profile.proxy.protocol.toUpperCase()} • ${profile.proxy.host}:${profile.proxy.port}`
      : "DIRECT";
    const routeDetail = profile.restartRequired
      ? `<small class="pending-tag">Pending · ${escapeHtml(pendingProxyLabel)}</small>`
      : "";
    const statuses = {
      idle: "IDLE •",
      starting: "STARTING •",
      running: "RUNNING •",
      stopping: "STOPPING •",
      "restart-required": "RESTART REQ •",
      error: "ERROR •",
    };
    const busy = profile.status === "starting" || profile.status === "stopping";
    const action = profile.restartRequired ? "restart" : profile.running ? "close" : "open";
    const rawActivity = activityTime(profile.lastOpenedAt);
    const [actTime, actDate] = rawActivity.includes(" - ") ? rawActivity.split(" - ") : ["--:--", rawActivity];

    return `
      <article class="profile-row" data-id="${escapeHtml(profile.id)}">
        <div class="profile-identity">
          <div class="avatar" style="background:${escapeHtml(profile.color || "#dcf1e7")}">${escapeHtml(initials(profile.name))}</div>
          <div class="profile-title-block">
            <strong>${escapeHtml(profile.name)}</strong>
            <small>ID: ${escapeHtml(profile.appDataId)}</small>
          </div>
        </div>

        <div class="proxy-info">
          <div class="proxy-route-line">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path></svg>
            <code class="${displayedProxy.enabled ? "proxy-code" : "off-code"}">${escapeHtml(proxyLabel)}</code>
          </div>
          ${displayedProxy.enabled ? '<span class="badge-proxy-enabled">Proxy enabled</span>' : ""}
          ${routeDetail}
        </div>

        <div class="last-opened">
          <div class="activity-time-line">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
            <b>${escapeHtml(actTime)}</b>
          </div>
          <small>${escapeHtml(actDate)}</small>
        </div>

        <div class="status-cell">
          <span class="status ${escapeHtml(profile.status)}" title="${escapeHtml(profile.error || "")}">
            ${escapeHtml(statuses[profile.status] || profile.status)}
          </span>
        </div>

        <div class="row-actions">
          <button class="circle-action play ${profile.running ? "close" : ""}" type="button" data-action="${action}" title="${action === "close" ? "Dừng profile" : action === "restart" ? "Khởi động lại" : "Mở profile"}" ${busy || action !== "close" && !state.account.canOperate ? "disabled" : ""}>
            ${action === "close"
              ? '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>'
              : '<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>'}
          </button>
          <button class="circle-action edit" type="button" data-action="edit" title="Sửa profile" ${busy || !state.account.canOperate ? "disabled" : ""}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
          </button>
          <button class="circle-action delete" type="button" data-action="delete" title="Xóa profile" ${busy || !state.account.canOperate ? "disabled" : ""}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
          <button class="circle-action more" type="button" data-action="edit" title="Thao tác khác" ${busy || !state.account.canOperate ? "disabled" : ""}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg>
          </button>
        </div>
      </article>`;
  }).join("");

  if (state.query && visible.length === 0) {
    elements.list.hidden = false;
    elements.list.innerHTML = `<div class="empty-state search-empty" style="display:grid"><h3>Không tìm thấy</h3><p>Không có profile hoặc proxy phù hợp.</p></div>`;
  }
}

function setProxyUi() {
  const enabled = document.querySelector("#proxyEnabled").checked;
  const auth = document.querySelector("#proxyAuth").checked;
  elements.proxyFields.classList.toggle("disabled", !enabled);
  elements.proxyFields.querySelectorAll("input, select").forEach((control) => {
    if (control.id !== "proxyEnabled") control.disabled = !enabled;
  });
  document.querySelectorAll(".auth-field").forEach((field) => field.classList.toggle("hidden", !auth));
  document.querySelector("#testProxyButton").disabled = !enabled;
}

function applyQuickProxy() {
  const value = document.querySelector("#quickProxy").value.trim();
  const parts = value.split(":").map((part) => part.trim());

  if (![2, 4].includes(parts.length) || parts.some((part) => !part)) {
    elements.formError.textContent = "Proxy phải có dạng IP:PORT hoặc IP:PORT:USERNAME:PASSWORD.";
    return false;
  }

  const [host, port, username = "", password = ""] = parts;
  const numericPort = Number(port);
  if (!host || !Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    elements.formError.textContent = "IP hoặc port proxy không hợp lệ.";
    return false;
  }

  document.querySelector("#proxyEnabled").checked = true;
  document.querySelector("#proxyHost").value = host;
  document.querySelector("#proxyPort").value = port;
  document.querySelector("#proxyAuth").checked = parts.length === 4;
  document.querySelector("#proxyUsername").value = username;
  document.querySelector("#proxyPassword").value = password;
  elements.formError.textContent = "";
  elements.testResult.textContent = "Đã tự điền proxy. Nhấn Test connection để kiểm tra.";
  elements.testResult.className = "";
  setProxyUi();
  return true;
}

function openEditor(profile = null) {
  elements.form.reset();
  elements.formError.textContent = "";
  elements.testResult.textContent = "";
  document.querySelector("#dialogTitle").textContent = profile ? "Edit profile" : "New profile";
  document.querySelector("#profileId").value = profile?.id || "";
  document.querySelector("#profileName").value = profile?.name || "";
  document.querySelector("#profileNote").value = profile?.note || "";
  document.querySelector("#quickProxy").value = "";
  document.querySelector("#proxyEnabled").checked = profile?.proxy.enabled || false;
  document.querySelector("#proxyProtocol").value = profile?.proxy.protocol || "http";
  document.querySelector("#proxyHost").value = profile?.proxy.host || "";
  document.querySelector("#proxyPort").value = profile?.proxy.port || "";
  document.querySelector("#proxyAuth").checked = profile?.proxy.useAuthentication || false;
  document.querySelector("#proxyUsername").value = profile?.proxy.username || "";
  document.querySelector("#proxyPassword").value = "";
  document.querySelector("#proxyPassword").placeholder = profile?.proxy.useAuthentication ? "Để trống để giữ password hiện tại" : "";
  document.querySelector("#permGeolocation").checked = Boolean(profile?.browserPolicy?.permissions?.geolocation);
  document.querySelector("#permCamera").checked = profile?.browserPolicy?.permissions?.camera || false;
  document.querySelector("#permMicrophone").checked = profile?.browserPolicy?.permissions?.microphone || false;
  document.querySelector("#permNotifications").checked = profile?.browserPolicy?.permissions?.notifications || false;
  const identity = profile?.automaticIdentity;
  document.querySelector("#identityStatus").textContent = identity ? "Đã khóa theo profile" : "Sẽ tạo ở lần mở đầu tiên";
  document.querySelector("#identityRegion").textContent = identity
    ? `${identity.sourceIp} · ${[identity.city, identity.region, identity.countryCode].filter(Boolean).join(", ") || "Không rõ vùng"}`
    : "Chưa có";
  document.querySelector("#identityCoordinate").textContent = identity
    ? `${identity.latitude.toFixed(6)}, ${identity.longitude.toFixed(6)} · ±${identity.accuracyMeters} m`
    : "Chưa có";
  // The stored value is legacy metadata and is no longer the UA sent on the wire:
  // web views derive their UA from the Chromium ZaloPC actually runs.
  document.querySelector("#identityUserAgent").textContent = "Theo Chromium của ZaloPC";
  const selectedColor = profile?.color || colors[0];
  document.querySelector(`input[name="profileColor"][value="${selectedColor}"]`)?.click();
  setProxyUi();
  elements.dialog.showModal();
  document.querySelector("#profileName").focus();
}

function formData() {
  return {
    id: document.querySelector("#profileId").value || undefined,
    name: document.querySelector("#profileName").value,
    note: document.querySelector("#profileNote").value,
    color: document.querySelector('input[name="profileColor"]:checked')?.value,
    proxy: {
      enabled: document.querySelector("#proxyEnabled").checked,
      protocol: document.querySelector("#proxyProtocol").value,
      host: document.querySelector("#proxyHost").value,
      port: document.querySelector("#proxyPort").value,
      useAuthentication: document.querySelector("#proxyAuth").checked,
      username: document.querySelector("#proxyUsername").value,
      password: document.querySelector("#proxyPassword").value,
    },
    browserPolicy: {
      permissions: {
        geolocation: document.querySelector("#permGeolocation").checked,
        camera: document.querySelector("#permCamera").checked,
        microphone: document.querySelector("#permMicrophone").checked,
        notifications: document.querySelector("#permNotifications").checked,
      },
    },
  };
}

let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", isError);
  elements.toast.classList.add("show");
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2800);
}

async function handleProfileAction(action, id, button) {
  const profile = state.profiles.find((item) => item.id === id);
  if (!profile) return;
  if (action === "edit") return openEditor(profile);
  if (action === "delete") {
    state.deleteId = id;
    elements.confirmDialog.showModal();
    return;
  }

  button.disabled = true;
  try {
    if (action === "open") await window.profilesApi.open(id);
    if (action === "close") await window.profilesApi.close(id);
    if (action === "restart") await window.profilesApi.restart(id);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.querySelector("#colorOptions").innerHTML = colors.map((color, index) =>
  `<input class="color-option" type="radio" name="profileColor" value="${color}" style="background:${color}" aria-label="Màu ${index + 1}" ${index === 0 ? "checked" : ""} />`
).join("");

document.addEventListener("click", (event) => {
  if (!event.target.closest(".sort-control")) {
    closeSortMenu();
  }
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) switchPage(pageButton.dataset.page);
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  if (action === "create") openEditor();
  if (action === "cancel") elements.dialog.close();
});

document.querySelector("#activationForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#activationKey");
  const error = document.querySelector("#activationError");
  const button = event.submitter;
  error.textContent = "";
  button.disabled = true;
  try {
    state.account = await window.accountApi.activate(input.value);
    input.value = "";
    renderAccount();
    render();
    toast("Kích hoạt thành công.");
  } catch (activationError) {
    error.textContent = activationError.message;
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#accountLogout").addEventListener("click", async () => {
  try {
    state.account = await window.accountApi.logout();
    renderAccount();
    render();
    toast("Đã đăng xuất và dừng profiles thuộc manager.");
  } catch (error) { toast(error.message, true); }
});

document.querySelector("#accountRecover").addEventListener("click", async () => {
  try {
    state.account = await window.accountApi.recover();
    renderAccount();
    render();
    toast("Đã đặt lại credential. Hãy kích hoạt lại tài khoản.");
  } catch (error) { toast(error.message, true); }
});

document.querySelector("#openTelegram").addEventListener("click", () => {
  window.externalApi.openTelegram().catch((error) => toast(error.message, true));
});

document.querySelector("#checkUpdateButton").addEventListener("click", () => {
  window.updateApi.check().catch((error) => toast(error.message, true));
});

document.querySelector("#installUpdateButton").addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await window.updateApi.install();
  } catch (error) {
    event.currentTarget.disabled = false;
    toast(error.message, true);
  }
});

elements.list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const row = event.target.closest("[data-id]");
  if (button && row) handleProfileAction(button.dataset.action, row.dataset.id, button);
});

elements.list.addEventListener("dblclick", (event) => {
  const row = event.target.closest("[data-id]");
  if (!row) return;
  const id = row.dataset.id;
  const profile = state.profiles.find((p) => p.id === id);
  if (profile && state.account.canOperate) {
    const action = profile.restartRequired ? "restart" : profile.running ? "close" : "open";
    const button = row.querySelector(`[data-action="${action}"]`);
    if (button && !button.disabled) handleProfileAction(action, id, button);
  }
});

elements.search.addEventListener("input", (event) => {
  state.query = event.target.value.trim();
  render();
});

elements.sortButton.addEventListener("click", () => {
  elements.sortMenu.hidden = !elements.sortMenu.hidden;
  elements.sortButton.setAttribute("aria-expanded", String(!elements.sortMenu.hidden));
  if (!elements.sortMenu.hidden) elements.sortMenu.querySelector(`[data-sort="${state.sort}"]`).focus();
});

elements.sortMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-sort]");
  if (!option) return;
  selectSort(option.dataset.sort);
  closeSortMenu(true);
  render();
});

elements.sortMenu.addEventListener("keydown", (event) => {
  const options = [...elements.sortMenu.querySelectorAll("[data-sort]")];
  const index = options.indexOf(document.activeElement);
  if (event.key === "Escape") {
    event.preventDefault();
    closeSortMenu(true);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length].focus();
  }
});

document.querySelector("#proxyEnabled").addEventListener("change", setProxyUi);
document.querySelector("#proxyAuth").addEventListener("change", setProxyUi);
document.querySelector("#applyQuickProxy").addEventListener("click", applyQuickProxy);
document.querySelector("#quickProxy").addEventListener("paste", () => {
  setTimeout(applyQuickProxy, 0);
});
document.querySelector("#quickProxy").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    applyQuickProxy();
  }
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.formError.textContent = "";
  try {
    await window.profilesApi.save(formData());
    elements.dialog.close();
    toast("Profile đã được lưu.");
  } catch (error) {
    elements.formError.textContent = error.message;
  }
});

document.querySelector("#testProxyButton").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  elements.testResult.className = "";
  elements.testResult.textContent = "Đang kiểm tra...";
  button.disabled = true;
  try {
    const result = await window.profilesApi.testProxy(formData().proxy);
    elements.testResult.className = result.ok ? "success" : "error";
    elements.testResult.textContent = result.ok
      ? `Thành công · IP ${result.ip} · ${result.latency} ms · ${result.route || "PROXY"}`
      : `Không thể kết nối · ${result.message || `HTTP ${result.status}`}`;
  } catch (error) {
    elements.testResult.className = "error";
    elements.testResult.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

elements.confirmDialog.addEventListener("click", async (event) => {
  const action = event.target.dataset.confirm;
  if (!action) return;
  if (action === "cancel") return elements.confirmDialog.close();
  try {
    await window.profilesApi.remove(state.deleteId);
    elements.confirmDialog.close();
    toast("Profile và dữ liệu ZaloPC native đã được xóa.");
  } catch (error) {
    toast(error.message, true);
  }
});

window.profilesApi.onChanged((profiles) => {
  state.profiles = profiles;
  render();
});

window.profilesApi.onShutdownError((message) => {
  toast(`Không thể thoát an toàn: ${message}`, true);
});

window.accountApi.onChanged((account) => {
  state.account = account;
  renderAccount();
  render();
});

window.profilesApi.list().then((profiles) => {
  state.profiles = profiles;
  render();
}).catch((error) => toast(error.message, true));

window.accountApi.get().then((account) => {
  state.account = account;
  renderAccount();
  render();
}).catch((error) => toast(error.message, true));

window.updateApi.onChanged((update) => {
  state.update = update;
  renderUpdate();
});

window.updateApi.get().then((update) => {
  state.update = update;
  renderUpdate();
}).catch((error) => toast(error.message, true));

switchPage("profiles");
selectSort("asc");
renderAccount();
renderUpdate();
