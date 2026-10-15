# Kết quả kiểm tra bản 0.1.0

## Cập nhật ngày 15/10/2026 — màu thương hiệu và responsive

- Màu chủ đạo `#ae1c3f` áp dụng cho logo, điều hướng, nút, focus, thanh dung lượng, màn đăng nhập và Uppy. Dùng font hệ thống, không tải tài nguyên font bên ngoài.
- Desktop 1600 × 900: sidebar cố định, vùng upload/nhập link bố trí ngang, danh sách file có cột thao tác. Mobile: điều hướng đáy màn hình, vùng chạm tối thiểu 44px cho điều hướng và thao tác chính, biểu mẫu một cột, danh sách file dạng thẻ, hỗ trợ safe area và reduced motion.
- Build/TypeScript đạt. Playwright đạt toàn bộ luồng đăng nhập, upload, download đúng nội dung, xóa, tạo/đổi mã tài khoản và modal mật khẩu; không có lỗi JavaScript trong luồng kiểm tra.
- Không tràn ngang ở các chiều rộng 360, 375, 390, 768, 1024 và 1600px trên trang file. Kiểm tra thêm màn tài khoản, đăng nhập và nhập link ở 375px; xác nhận thanh điều hướng nằm sát đáy viewport mobile.
- Đã xem ảnh chụp desktop 1600 × 900 và mobile 375 × 812. Ảnh được ghi trong `test-results` khi chạy `npm run test:ui`.

## Cập nhật ngày 15/10/2026 — mật khẩu tối thiểu 8 ký tự

- Áp dụng cho tạo tài khoản, admin đặt lại mật khẩu, người dùng đổi mật khẩu và `ADMIN_PASSWORD` lúc bootstrap; biểu mẫu và thông báo đều dùng giới hạn 8 ký tự.
- **21/21 kiểm thử backend đạt**: mật khẩu đúng 8 ký tự hoạt động qua các luồng trên; 7 ký tự bị từ chối. Giới hạn `SESSION_SECRET` vẫn là 32 ký tự.
- Build thành công; Playwright tạo tài khoản với mật khẩu 8 ký tự và kiểm tra ràng buộc biểu mẫu đổi mật khẩu.
- Không triển khai tích hợp AD theo yêu cầu mới; mật khẩu hiện có không bị đổi.

## Cập nhật ngày 15/10/2026 — mã nhân viên

- Đăng nhập, tạo/đổi tài khoản, phản hồi API và nhật ký dùng `employeeCode` thay email; mã được chuẩn hóa chữ hoa và giữ số 0 đầu.
- **19/19 bài kiểm thử backend đạt**, gồm migration dữ liệu cũ, trùng mã, sửa mã giữ phiên và phân biệt origin dev/production; build thành công.
- **Playwright 1/1 đạt**, có thêm tạo tài khoản bằng mã và đổi mã trên giao diện, kiểm tra bố cục tài khoản mobile.
- Đã chuyển tài khoản admin trong PostgreSQL thật sang `ADMIN`, đối chiếu UUID, hash mật khẩu, role, trạng thái khóa và hạn mức trước/sau: không đổi.
- Đăng nhập bằng mật khẩu admin hiện có qua cả `localhost:5173` và `127.0.0.1:5173` trong dev trả HTTP 200; đăng xuất có CSRF trả HTTP 200. Production vẫn chỉ nhận đúng origin đã cấu hình.

## Cập nhật ngày 15/10/2026 — thông báo lỗi khởi động

- Build frontend/backend thành công; **16/16 bài kiểm thử backend đạt**.
- Lỗi khởi động hiển thị bước thất bại, biến cấu hình cần sửa, mã lỗi/stack và gợi ý cho PostgreSQL, quyền thư mục hoặc cổng HTTP.
- Kiểm tra nạp `.env` khi chạy trực tiếp, ưu tiên environment có sẵn, báo đồng thời hai giá trị mẫu, xử lý AggregateError và che mật khẩu/API key trong log.
- Xác nhận cấu hình hiện tại bị chặn bởi `SESSION_SECRET` và `ADMIN_PASSWORD` còn là giá trị mẫu; không sửa `.env` của người dùng.

### Sửa dev proxy ECONNREFUSED

- Đổi backend dev từ `tsx watch` sang `node --watch --env-file=.env --import tsx server/main.ts` sau khi tái hiện backend không mở cổng khi chạy chung với Vite.
- Khởi động lại `npm run dev` và xác nhận PostgreSQL thật tại cổng đã cấu hình `5433` kết nối được trên máy phát triển Windows.
- `/api/health` qua Vite trả HTTP 200; API phiên đăng nhập trả HTTP 401 đúng khi chưa đăng nhập.
- Thay đổi thời gian cập nhật file entry mà không đổi nội dung: backend tự đổi tiến trình và health qua Vite tiếp tục trả HTTP 200. TypeScript kiểm tra đạt.

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
