# Kết quả kiểm tra bản 0.1.0

Ngày kiểm tra: **14/10/2026**, môi trường Windows với Node.js 24 và Microsoft Edge headless.

| Kiểm tra | Kết quả |
|---|---|
| TypeScript và build frontend/backend | Đạt |
| Integration backend | **13/13 đạt** |
| Playwright: đăng nhập, upload, checksum-ready, download đúng nội dung, xóa, quản trị, mobile, modal và đăng xuất | **1/1 đạt** |
| Nhập file nhỏ công khai từ Internet qua API → worker → lưu trữ → download | Đạt, 1.393 byte, SHA-256 có giá trị |
| Kiểm tra dependency production bằng npm audit | Không có advisory được báo tại thời điểm kiểm tra |

Integration dùng PostgreSQL nhúng PGlite, HTTP thật trên localhost và nguồn tải giả lập cho các tình huống lỗi. Các trường hợp chính: CSRF/Origin, tài khoản khác không truy cập file, khóa tài khoản vô hiệu hóa phiên cũ, upload hai phần và offset, checksum, Range/suffix range, quota đồng thời, ổ đĩa thiếu dung lượng, hết hạn, dữ liệu thực nhận vượt giới hạn, phản hồi HTML, khởi động lại worker và Google Drive API/resource key/MD5 giả lập.

Ảnh giao diện desktop và mobile được tạo trong `test-results` khi chạy Playwright. Kiểm tra mobile ở 375 × 812 với reduced motion, không có tràn ngang hoặc lỗi JavaScript trong luồng đã chạy.

## Chưa được nghiệm thu ở môi trường công ty

- Build/chạy Docker Compose, quyền đọc file của Nginx, chứng chỉ và Range qua HTTPS trên máy Linux. Máy phát triển hiện không có Docker.
- Truyền một file gần 2 GB thật và tải đồng thời với năm người. Boundary 2.000.000.000 byte đã kiểm tra bằng khai báo; kiểm tra quá giới hạn dữ liệu thực dùng giới hạn thu nhỏ để tránh truyền hàng GB trong test.
- Khởi động lại container thật và khôi phục database từ backup trên Linux.
- Nhập Google Drive với API key của công ty và file công khai thật. Adapter được kiểm tra bằng metadata/media giả lập; chưa có credential thật để nghiệm thu.
- Khả năng truy cập domain qua firewall/proxy/DNS từ máy nội bộ của công ty.

Thực hiện checklist trong [DEPLOYMENT.md](DEPLOYMENT.md) trước khi cho nhân viên dùng chính thức. Bản hiện tại kiểm tra kỹ thuật, chưa có antivirus.
