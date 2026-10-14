# SimpleDrive

Trạm trung chuyển file từ Internet vào máy nội bộ, dùng một domain HTTPS của công ty.

## Chức năng bản đầu

- Tài khoản riêng cho nhân viên; admin tạo, khóa và đặt lại mật khẩu.
- Upload tiếp tục bằng tus/Uppy, mỗi phần 16 MiB; tối đa **2 GB = 2.000.000.000 byte/file**.
- Nhập link tải trực tiếp HTTP/HTTPS và Google Drive công khai; hai tác vụ nhập link đồng thời.
- Kiểm tra dung lượng, hoàn tất truyền và SHA-256; đối chiếu MD5 của nguồn Google Drive khi có.
- Download có phân quyền, HTTP Range, tên tiếng Việt và cùng domain với ứng dụng.
- Lưu tạm 72 giờ; dọn phiên upload sau 24 giờ không hoạt động.
- Hạn mức mặc định 20 GB/người, 100 GB tổng cộng; giữ tối thiểu 20 GB trống trên ổ lưu trữ.
- Nhật ký 90 ngày; file đã xóa/hết hạn/lỗi được giữ thông tin 30 ngày.
- Giao diện tiếng Việt, responsive; không tải font hoặc thư viện từ CDN ngoài công ty.

File riêng theo người sở hữu. Admin có quyền quản lý toàn bộ, nhưng không được ghi tiếp upload của người khác. Bản này **chưa quét antivirus**, chưa đồng bộ thư mục, nhập Drive riêng tư, chia sẻ file giữa nhân viên hay xuất Google Docs/Sheets. SHA-256 là mã kiểm tra của dữ liệu thực nhận; khi nguồn không cung cấp checksum, nó không tự chứng minh file giống bản gốc tại nguồn.

## Công nghệ

React + TypeScript + Vite; Fastify/Node.js 24; PostgreSQL 17; Nginx; Docker Compose. File nằm trên ổ đĩa, không nằm trong PostgreSQL. Worker nằm cùng tiến trình ứng dụng; triển khai **một instance app**, không tăng replica khi chưa thay cơ chế khóa tus bằng khóa dùng chung.

## Cài lên máy Linux

Xem [hướng dẫn triển khai](docs/DEPLOYMENT.md). Bộ production gồm `db`, `app`, `web`; chỉ Nginx mở cổng 80/443. PostgreSQL và backend không mở cổng ra Internet. Chứng chỉ HTTPS và dữ liệu được giữ trong Docker volumes.

Máy Linux RAM 16 GB phù hợp để chạy thử mục tiêu năm người truyền đồng thời. Cần xác nhận dung lượng ổ đĩa thực tế, băng thông và khả năng truy cập domain từ máy nội bộ. Chưa có kết quả benchmark trên máy vật lý của công ty.

## Chạy phát triển

Yêu cầu Node.js 24 và PostgreSQL 17 (hoặc Docker để chạy database):

```sh
cp .env.example .env
# Sửa SESSION_SECRET, ADMIN_PASSWORD, POSTGRES_PASSWORD và DATABASE_URL.
npm ci
docker compose -f compose.yml -f compose.dev.yml up -d db
npm run dev
```

Mở `http://localhost:5173`. `DATABASE_URL` cho phát triển phải dùng `localhost:5432`, khớp mật khẩu database. Tài khoản admin chỉ được tạo khi database chưa có người dùng; biến bootstrap không ghi đè mật khẩu đã có.

## Xem thử nhanh không cần PostgreSQL

```sh
npm ci
npm run build
npm run preview:local
```

Mở `http://127.0.0.1:4173`. Tài khoản admin được tạo bằng mật khẩu ngẫu nhiên, lưu ở `data/local-preview/access.json`. Chế độ này dùng PGlite và dữ liệu riêng để kiểm tra giao diện trên máy phát triển; **không dùng để triển khai production**. Google Drive chưa bật trong chế độ xem thử.

## Kiểm tra

```sh
npm run build
npm test
npx playwright test
# Optional: smoke test with one small public Internet file.
npm run test:network
```

`npm test` chạy integration với database PostgreSQL nhúng PGlite và máy chủ HTTP thật trên localhost. Bao gồm upload hai phần/offset, checksum, Range, phân quyền, CSRF, khóa tài khoản, giới hạn 2 GB qua khai báo, hạn mức và dọn dữ liệu; kiểm tra nhập link dùng nguồn giả lập để tạo các tình huống lỗi. Không truyền một file 2 GB thật trong bộ test mặc định. Playwright mặc định dùng Microsoft Edge đã cài; máy Linux có thể đổi `channel` trong cấu hình hoặc cài browser bằng `npx playwright install chromium` và bỏ `channel`.

Các bước bắt buộc trên máy triển khai: test file gần 2 GB thật, năm người truyền cùng lúc, restart container khi đang truyền, HTTPS/Nginx Range và một file Drive công khai với API key thật. Chúng chưa được xác nhận chỉ bằng test cục bộ.

Kết quả kiểm tra bản bàn giao được ghi tại [VERIFICATION.md](docs/VERIFICATION.md).

## API chính

| Nhóm | API |
|---|---|
| Phiên đăng nhập | `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/password` |
| File | `GET /api/files`, `GET /api/files/:id`, `POST /api/files/uploads`, `POST /api/files/imports`, `DELETE /api/files/:id` |
| Nội dung | tus tại `/api/uploads`, `GET /api/files/:id/download` |
| Quản trị | `GET/POST /api/admin/users`, `PATCH /api/admin/users/:id`, `GET /api/admin/audit`, `GET /api/admin/storage` |
| Sức khỏe | `GET /api/health` |

Thao tác ghi dùng cookie HttpOnly và header `X-CSRF-Token` lấy từ `/api/auth/me`. Nguồn yêu cầu phải khớp `BASE_URL` khi có header Origin. Nhập file chưa biết kích thước giữ chỗ bằng giới hạn tối đa, rồi giảm về kích thước thực sau khi hoàn tất. API danh sách trả tối đa 300 file gần nhất; nhật ký trả 200 sự kiện gần nhất.

## Tài liệu tham khảo

- [tus server](https://github.com/tus/tus-node-server)
- [Uppy Tus](https://uppy.io/docs/tus/)
- [Google Drive downloads](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Google Drive resource keys](https://developers.google.com/workspace/drive/api/guides/resource-keys)
- [Nginx internal locations](https://nginx.org/en/docs/http/ngx_http_core_module.html#internal)
