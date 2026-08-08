# ZPool

Ứng dụng Electron quản lý nhiều profile ZaloPC native trên Windows. Mỗi profile có `appdata-id` số riêng, thư mục `%APPDATA%\\ZaloData_<id>` riêng và có thể dùng một proxy HTTP, HTTPS, SOCKS4 hoặc SOCKS5 riêng.

## Development

```powershell
npm install
$env:ACCOUNT_API_URL="https://accounts.example.com"
npm start
```

## Data isolation

- Metadata profile được lưu tại Electron `userData/profiles.json`.
- Manager không mở `chat.zalo.me` và không dùng Electron partition cho Zalo.
- Khi mở profile, manager kiểm tra ZaloPC, backup `resources/app.asar` theo SHA-256 rồi patch bootstrap/hook nếu cần.
- `meta.bin` dùng codec V2 AES-128-CBC với khóa codec legacy để tiếp tục đọc profile hiện có; password không trả về renderer/list/event.
- Hook Zpool không ghi đè User-Agent của Electron/ZaloPC, nên request ảnh, video và tệp dùng nhận dạng gốc của runtime.
- Xóa profile chỉ xóa thư mục trực tiếp `ZaloData_<id>` thuộc registry của manager.
- Đổi proxy khi ZaloPC đang chạy sẽ báo `Restart required`; manager không hot-reload proxy.
- Đóng manager không tự dừng các tiến trình ZaloPC.
- Khi tài khoản bị khóa/force logout hoặc offline quá 5 phút, manager chỉ dừng các `ZaloData_<id>` có trong registry `profiles.json`; không xóa dữ liệu profile.
- App kiểm tra GitHub Releases `keyesvn/292` khi khởi động và mỗi 60 phút. Bản mới được tự tải vào Electron `userData/updates`; người dùng xác nhận cài trong menu `Cập Nhật`.

## Security notes

- Manager renderer dùng `contextIsolation`, sandbox và preload API giới hạn.
- Profile windows không bật Node.js và không có preload bridge.
- Proxy password chỉ được giữ trong registry/meta native ở local; không expose qua renderer.
- Installation ID và bearer session được mã hóa bằng Electron `safeStorage` trong `userData/account.secure`. UID là SHA-256 dẫn xuất từ installation ID, không lấy serial phần cứng.
- `ACCOUNT_API_URL` bắt buộc là HTTPS. Không đặt key/token trong biến môi trường, JSON, renderer hoặc log.
- Mọi IPC save/delete/open/restart/test proxy được xác thực sender và guard lại tại main process. Close và logout luôn được phép.
- Updater chỉ chấp nhận release ổn định và asset HTTPS có tên chính xác `ZPool.Setup.<version>.exe` hoặc `ZPool Setup <version>.exe`; file tải xong phải đủ kích thước và có chữ ký PE `MZ`.

## Requirements

- Windows và ZaloPC `26.6.11` đã cài trong thư mục versioned `%LOCALAPPDATA%\\Programs\\Zalo\\Zalo-26.6.11`.
- Bản ZaloPC mới hơn phải được xác minh hook trước khi thêm vào danh sách tương thích; manager sẽ từ chối patch bản chưa xác minh.
- ZaloPC phải có cấu trúc `bootstrap.js`, `package.json` với `main: bootstrap.js`, và `dist-main` tương thích hook.
- Patch được thực hiện trên archive cài đặt, nên cần quyền ghi thư mục cài đặt.

## Verification

```powershell
npm test
npm run check
npm run pack
```

Build không nhúng `ACCOUNT_API_URL` hay secret; cấu hình URL tại runtime trên máy Windows (environment/service launcher). Menu `Tài Khoản` dùng để nhập key, xem key che/gói/thời hạn và liên hệ Telegram `@Trung292sv`.

Đóng cửa sổ chỉ ẩn app xuống system tray để heartbeat và enforcement tiếp tục chạy. Chọn `Thoát và dừng profiles` từ tray để quit thật; app sẽ dừng và xác minh toàn bộ profile thuộc registry trước khi thoát.

Không chạy Zalo thật trong unit test. Manual verification cần mở hai profile, đối chiếu `--appdata-id`, process tree, `%APPDATA%\\ZaloData_<id>`, proxy IP và title; sau đó đóng một profile để xác nhận profile kia không bị dừng.
