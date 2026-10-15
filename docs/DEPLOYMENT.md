# Triển khai SimpleDrive trên Linux RAM 16 GB

## 1. Chuẩn bị

- Docker Engine và Docker Compose plugin đã cài trên máy Linux.
- Domain hoặc subdomain riêng (ví dụ `drive.congty.vn`) trỏ A record tới IP public; chỉ tạo AAAA record nếu IPv6 thực sự hoạt động.
- Cổng 80 và 443 tới máy chủ. Nếu sau router, NAT hai cổng này; nếu máy nội bộ không hỗ trợ hairpin NAT, dùng DNS nội bộ trỏ cùng hostname tới IP LAN của máy chủ.
- Ổ chứa Docker volumes còn ít nhất **120 GB trống** để đáp ứng hạn mức tổng 100 GB cộng 20 GB dự phòng; nên có ổ dung lượng 200 GB hoặc lớn hơn. Thay `GLOBAL_QUOTA_BYTES` và `MIN_FREE_BYTES` cho phù hợp ổ thực tế.
- Nguồn URL được tải bằng kết nối Internet của máy chủ, không phải kết nối của máy nhân viên.

Chỉ mở 80/443 cho web và cổng SSH theo quy tắc của công ty. Database không cần mở ra Internet.

## 2. Chép dự án và cấu hình

Chép mã nguồn vào `/opt/simpledrive`, rồi:

```sh
cd /opt/simpledrive
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
openssl rand -hex 32
```

Dùng hai chuỗi ngẫu nhiên khác nhau cho `SESSION_SECRET` và `POSTGRES_PASSWORD`. Sửa `.env`:

```dotenv
DOMAIN=drive.congty.vn
BASE_URL=https://drive.congty.vn
POSTGRES_USER=simpledrive
POSTGRES_DB=simpledrive
POSTGRES_PASSWORD=<chuoi-hex-ngau-nhien>
SESSION_SECRET=<chuoi-hex-ngau-nhien-khac>
ADMIN_EMPLOYEE_CODE=ADMIN
ADMIN_PASSWORD=<mat-khau-manh-it-nhat-8-ky-tu>
USER_QUOTA_BYTES=20000000000
GLOBAL_QUOTA_BYTES=100000000000
MIN_FREE_BYTES=20000000000
```

Thay toàn bộ dấu `<...>` bằng giá trị thật. Dùng mật khẩu PostgreSQL dạng hex để không gặp vấn đề ký tự đặc biệt trong URL kết nối. Compose tự tạo `DATABASE_URL` và đường dẫn dữ liệu cho container; `DATABASE_URL`, `HOST`, `PORT`, `DATA_DIR` trong `.env.example` chỉ dùng cho phát triển.

Không đưa `.env`, mật khẩu hoặc API key vào kho mã nguồn. Domain phải là hostname riêng, không kèm scheme/path; `BASE_URL` phải đúng origin HTTPS mà nhân viên sẽ truy cập.

## 3. Cấp chứng chỉ HTTPS rồi khởi động

Trong lần đầu, cổng 80 cần đang rảnh và DNS đã trỏ đúng:

```sh
docker compose run --rm -p 80:80 certbot certonly --standalone \
  --email admin@congty.vn --agree-tos --no-eff-email -d drive.congty.vn
docker compose up -d --build
docker compose ps
curl --fail https://drive.congty.vn/api/health
```

Thay email và domain bằng giá trị thật. Nếu máy có web server khác chiếm cổng, cấu hình reverse proxy/chứng chỉ với hệ thống hiện có trước; bộ này mặc định Nginx của SimpleDrive quản lý trực tiếp 80/443.

Truy cập web, đăng nhập admin đã đặt ở `.env`, tạo tài khoản nhân viên ở mục **Tài khoản**. Sau khi bootstrap xong, xóa giá trị `ADMIN_PASSWORD` trong `.env` rồi chạy:

```sh
docker compose up -d app
```

Database giữ mật khẩu đã băm; bỏ biến bootstrap không xóa hoặc đổi tài khoản. Không thay `SESSION_SECRET` tùy tiện: URL nguồn đang chờ tải được mã hóa bằng secret này. Nếu cần thay, chờ/xóa các tác vụ nhập link đang chờ trước.

Đăng nhập bằng mã nhân viên `ADMIN` hoặc mã trong `ADMIN_EMPLOYEE_CODE`, cùng mật khẩu quản trị đã đặt. Không dùng email đăng nhập. Cấu hình cũ `ADMIN_EMAIL` không còn dùng. Khi nâng cấp database cũ, migration tự thêm mã nhân viên và giữ nguyên UUID, mật khẩu, quyền, file và phiên đăng nhập; admin có thể chỉnh lại mã ở trang **Tài khoản**. Thay `ADMIN_EMPLOYEE_CODE` sau khi đã có mã trong database không tự đổi mã hiện tại; hãy dùng nút **Đổi mã**.

## 4. Bật nhập Google Drive công khai

Trong Google Cloud project của công ty, bật **Google Drive API**, tạo API key, giới hạn key chỉ dùng Drive API và địa chỉ IP public mà máy chủ dùng khi truy cập Internet. Thêm vào `.env`:

```dotenv
GOOGLE_DRIVE_API_KEY=<api-key>
```

Sau đó `docker compose up -d app`. Key chỉ dùng phía backend, không đưa xuống trình duyệt. Dùng API key để truy cập file công khai thay cho kết nối Drive cá nhân; nhân viên không phải đăng nhập Google trong mạng nội bộ.

Chia sẻ file nguồn ở chế độ **Anyone with the link / Viewer**, cho phép download, rồi dán link vào SimpleDrive. Link có `resourcekey` được giữ và gửi tới API. Quy định Workspace, hạn mức Google hoặc chủ file tắt download vẫn có thể làm tác vụ thất bại. Trạm hiển thị lỗi để người dùng chuyển sang upload thủ công.

Chưa hỗ trợ link thư mục, Google Docs/Sheets/Slides hay file riêng tư. Kiểm thử một file nhỏ và một file gần 2 GB thật bằng key của công ty trước khi sử dụng rộng rãi.

## 5. Vận hành và sao lưu

```sh
docker compose logs --tail=100 app
docker compose ps
sh ops/backup.sh
sh ops/renew-cert.sh
```

Backup script tạo `backups/*.sql.gz` với quyền riêng tư. Chép backup database và bản cấu hình `.env` tới vị trí bảo mật khác; script không tự sao lưu nội dung file trung chuyển hoặc khóa cấu hình. File trung chuyển có thể bị mất nếu ổ hỏng và cần lấy lại từ nguồn.

Có thể cài lịch trên máy Linux bằng `crontab -e` (thay đường dẫn nếu khác):

```cron
15 2 * * * cd /opt/simpledrive && sh ops/backup.sh >> /var/log/simpledrive-backup.log 2>&1
20 3 * * * cd /opt/simpledrive && sh ops/renew-cert.sh >> /var/log/simpledrive-cert.log 2>&1
```

Quản lý thời hạn lưu backup và cảnh báo lỗi cron theo công cụ vận hành của công ty. Health endpoint kiểm tra kết nối database và thư mục lưu trữ; theo dõi thêm ổ đĩa, CPU/RAM và thời gian chờ của tác vụ.

Để cập nhật, sao lưu rồi chép bản mã nguồn mới và chạy `docker compose up -d --build`. Không dùng `docker compose down -v` khi muốn giữ dữ liệu: tùy chọn `-v` xóa volumes.

Phục hồi database vào một deployment mới, trước khi cho nhân viên dùng:

```sh
docker compose stop app
gzip -dc backups/<ten-backup>.sql.gz | docker compose exec -T db \
  sh -c 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
docker compose up -d app
```

Database đích cần trống trước khi phục hồi bằng bản `pg_dump` này. Nếu không phục hồi được nội dung file tương ứng, admin cần xóa các bản ghi file sẵn sàng cũ qua giao diện để giải phóng hạn mức và yêu cầu nhân viên nhập lại.

## 6. Kiểm tra trước khi dùng chính thức

1. Từ **máy nội bộ**, đăng nhập, upload và download qua domain HTTPS; không có yêu cầu tới CDN/Google từ trình duyệt.
2. Upload file nhỏ, file gần 2 GB; kiểm tra checksum của file tải về bằng `sha256sum`. File vượt 2.000.000.000 byte phải bị từ chối.
3. Ngắt mạng khi upload, kết nối lại và tiếp tục. Thử tải lại trang rồi chọn lại cùng file, cùng tài khoản/trình duyệt.
4. Kiểm tra HTTP Range qua Nginx với file đã sẵn sàng; tên file tiếng Việt giữ đúng khi download.
5. Năm nhân viên truyền đồng thời; kiểm tra tốc độ, CPU/RAM và dung lượng. Hai tác vụ nhập link chạy song song, tác vụ còn lại chờ.
6. Khởi động lại app khi upload/nhập link đang chạy. Worker phục hồi tác vụ bị gián đoạn sau khi lease cũ hết hạn khoảng hai phút; nhập link tải lại từ đầu. Tus tiếp tục theo offset đã ghi.
7. Đăng nhập bằng tài khoản khác, kiểm tra không truy cập được file; khóa tài khoản phải chặn phiên cũ.
8. Xóa file và kiểm tra dung lượng được giải phóng; xác nhận lịch hết hạn 72 giờ và upload bỏ dở 24 giờ.

## Giới hạn cần biết

- Một instance backend; file lưu trên ổ đĩa cục bộ. API danh sách giới hạn 300 file, chưa có phân trang.
- Link nhập chỉ nhận HTTP/HTTPS cổng 80/443, không chứa username/password. Mỗi redirect và DNS đều được kiểm tra; kết nối dùng IP đã kiểm tra để tránh DNS rebinding.
- Không nhận URL trỏ mạng nội bộ hoặc metadata server. Máy chủ cần truy cập được **IP public của nguồn**, kể cả khi DNS nội bộ có ánh xạ riêng.
- Tác vụ nhập có retry tối đa ba lần cho lỗi truyền không thuộc nhóm bị từ chối; URL hết hạn cần nhập lại. File lỗi giải phóng dữ liệu tạm.
- Bản này kiểm tra kỹ thuật, không quét antivirus và không có cam kết file sạch mã độc.
- Bộ Docker/HTTPS và tải Drive thật cần nghiệm thu trên máy Linux của bạn; môi trường phát triển hiện tại không có Docker.
