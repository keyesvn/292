"""Refresh a Proton VPN web session from one JSON object on stdin."""

import json
import os
import shutil
import signal
import sys
import tempfile
import time

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait
from selenium.common.exceptions import TimeoutException

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36"
)


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)


def terminate(_signum, _frame):
    raise SystemExit(143)


def main():
    signal.signal(signal.SIGTERM, terminate)
    try:
        account = json.load(sys.stdin)
    except (json.JSONDecodeError, TypeError):
        fail("Input JSON không hợp lệ.")

    if not isinstance(account, dict):
        fail("Input phải là JSON object.")

    if not all(isinstance(account.get(key), str) for key in ("email", "password")):
        fail("Email và mật khẩu phải là chuỗi.")
    if account.get("appVersion") is not None and not isinstance(account.get("appVersion"), str):
        fail("App version phải là chuỗi.")
    email = account.get("email", "").strip()
    password = account.get("password", "")
    app_version = account.get("appVersion") or "web-vpn-settings@5.0.347.1"
    if not email or not password:
        fail("Thiếu email hoặc mật khẩu Proton.")

    last_error = "Không rõ lỗi."
    for _attempt in range(2):
        profile_dir = tempfile.mkdtemp(prefix="proton-refresh-", dir="/tmp")
        driver = None
        stage = "start_browser"
        try:
            os.environ["HOME"] = profile_dir
            os.environ["XDG_CONFIG_HOME"] = profile_dir
            os.environ["XDG_CACHE_HOME"] = profile_dir
            options = Options()
            options.binary_location = "/usr/bin/chromium"
            for argument in (
                "--headless=new",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--disable-crash-reporter",
                "--disable-breakpad",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1280,800",
                "--disk-cache-dir=/tmp/chromium-cache",
                f"--user-data-dir={profile_dir}",
                f"--user-agent={USER_AGENT}",
            ):
                options.add_argument(argument)
            options.add_experimental_option("excludeSwitches", ["enable-automation"])
            options.add_experimental_option("useAutomationExtension", False)

            # Keep chromedriver diagnostics off stdout: stdout is the machine
            # readable JSON contract consumed by the Node worker.
            driver = webdriver.Chrome(service=Service("/usr/bin/chromedriver", log_output="/tmp/chromedriver.log"), options=options)
            driver.execute_cdp_cmd("Network.setUserAgentOverride", {"userAgent": USER_AGENT})
            driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
                "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            })
            stage = "open_login"
            driver.get("https://account.protonvpn.com/login")
            stage = "enter_username"
            WebDriverWait(driver, 25).until(EC.presence_of_element_located((By.ID, "username"))).send_keys(email)
            stage = "submit_username"
            WebDriverWait(driver, 20).until(EC.element_to_be_clickable((By.XPATH, "//button[@type='submit']"))).click()
            stage = "enter_password"
            WebDriverWait(driver, 20).until(EC.presence_of_element_located((By.ID, "password"))).send_keys(password)
            stage = "submit_password"
            WebDriverWait(driver, 20).until(EC.element_to_be_clickable((By.XPATH, "//button[@type='submit']"))).click()
            stage = "wait_login_result"
            WebDriverWait(driver, 45).until(
                lambda current: any(part in current.current_url for part in ("dashboard", "2fa", "code", "sessions"))
            )
            if "2fa" in driver.current_url or "code" in driver.current_url:
                fail("Tài khoản Proton yêu cầu xác thực 2FA.")

            stage = "extract_cookie"
            driver.get("https://account.protonvpn.com/api/auth/v4/sessions")
            try:
                WebDriverWait(driver, 15).until(
                    lambda current: any(item.get("name", "").startswith("AUTH-") for item in current.get_cookies())
                )
            except TimeoutException:
                pass
            time.sleep(1)
            cookies = driver.get_cookies()
            auth_cookie = next((item for item in cookies if item.get("name", "").startswith("AUTH-")), None)
            if auth_cookie:
                uid = auth_cookie["name"].removeprefix("AUTH-")
                cookie = "; ".join(f"{item['name']}={item['value']}" for item in cookies)
                json.dump({"cookie": cookie, "uid": uid, "appVersion": app_version}, sys.stdout)
                return

            stage = "extract_local_storage"
            driver.get("https://account.protonvpn.com/dashboard")
            time.sleep(2)
            local_storage = driver.execute_script("return JSON.stringify(window.localStorage);")
            for key, value in json.loads(local_storage or "{}").items():
                if not key.startswith("ps-"):
                    continue
                try:
                    session = json.loads(value)
                except (json.JSONDecodeError, TypeError):
                    continue
                uid = str(session.get("UID") or "").strip()
                access_token = str(session.get("AccessToken") or "").strip()
                if uid and access_token:
                    cookie_parts = [f"AUTH-{uid}={access_token}"] + [f"{item['name']}={item['value']}" for item in cookies]
                    json.dump({"cookie": "; ".join(cookie_parts), "uid": uid, "appVersion": app_version}, sys.stdout)
                    return
            last_error = "Không thể trích xuất AUTH cookie hoặc UID từ phiên đăng nhập."
        except SystemExit:
            raise
        except Exception as error:
            detail = " ".join(str(error).split())[:200]
            last_error = f"{stage}:{type(error).__name__}:{detail}"
        finally:
            if driver:
                try:
                    driver.quit()
                except Exception:
                    pass
            shutil.rmtree(profile_dir, ignore_errors=True)

    fail(f"Đăng nhập Proton thất bại sau 2 lần thử: {last_error}")


if __name__ == "__main__":
    main()
