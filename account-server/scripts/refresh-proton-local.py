"""Đăng nhập Proton local từ .env gốc và ghi kết quả tạm thời đã bảo vệ."""

import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROTON_ROOT = ROOT.parent / "TeleBot" / "ProtonBot"
ENV_PATH = ROOT / ".env"
RESULT_PATH = Path(os.environ.get("PROTON_REFRESH_RESULT", ""))
if not RESULT_PATH:
    raise SystemExit("Thiếu PROTON_REFRESH_RESULT.")

sys.path.insert(0, str(PROTON_ROOT))
import cookie_refresher  # noqa: E402


def unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
quoted = [unquote(line) for line in lines if re.fullmatch(r'\s*"[^"]+"\s*', line)]
accounts = list(zip(quoted[0::2], quoted[1::2]))
if not accounts:
    raise SystemExit("Không tìm thấy cặp email/password Proton trong .env.")

app_version = "web-vpn-settings@5.0.347.1"
results = []
for index, (email, password) in enumerate(accounts, 1):
    try:
        cookie, uid, version = cookie_refresher.login_and_get_cookies(email, password, app_version, headless=True)
        results.append({"index": index, "name": email, "cookie": cookie, "uid": uid, "appVersion": version, "ok": True})
        print(f"account_{index}=ok", flush=True)
    except Exception as error:
        results.append({"index": index, "name": email, "ok": False, "error": str(error)[:200]})
        print(f"account_{index}=failed:{type(error).__name__}", flush=True)

RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
RESULT_PATH.write_text(json.dumps(results), encoding="utf-8")
os.chmod(RESULT_PATH, 0o600)
