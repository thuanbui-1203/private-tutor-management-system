# 03. Hướng dẫn cài đặt và chạy

> Tài liệu này mô tả cách thiết lập **dự kiến** của dự án (NestJS + Docker Compose). Các lệnh và file nhắc đến (`docker-compose.yml`, `.env.example`, `infra/`...) sẽ có sau khi dựng khung code theo [02-cac-service.md](02-cac-service.md#11-cấu-trúc-thư-mục-đề-xuất).

## 1. Yêu cầu môi trường

| Công cụ | Phiên bản | Ghi chú |
|---|---|---|
| Docker Desktop | ≥ 4.30 | Trên Windows bật WSL 2 backend; cấp ≥ 6 GB RAM cho Docker |
| Node.js | 22 LTS | Cần trên máy để chạy migration, test và service ngoài Docker |
| pnpm | 9.15.x | `npm i -g pnpm@9` (monorepo dùng pnpm workspace; phiên bản ghi trong `package.json` > `packageManager`) |
| Git | bất kỳ | |
| Firebase CLI | ≥ 15 | `npm i -g firebase-tools`; chạy Firebase Auth Emulator khi phát triển và test |
| Java | 21+ | Cần cho Firebase Emulator; cũng dùng để render sơ đồ PlantUML trong `docs/diagrams` |

Kiểm tra nhanh:

```bash
docker --version && docker compose version
node -v && pnpm -v
```

## 2. Chạy hệ thống bằng Docker Compose

Cấu hình nằm ở [`docker-compose.yml`](../docker-compose.yml) (bản giống production) và [`docker-compose.override.yml`](../docker-compose.override.yml) (tự áp dụng khi phát triển).

```bash
# 1. Lấy mã nguồn và cài workspace
git clone <repo-url> microservices_final
cd microservices_final
pnpm install

# 2. Firebase (chỉ làm một lần, không commit hai file này):
#    - service account key: Firebase console > Project settings > Service accounts
#      > Generate new private key, lưu thành infra/keys/firebase-service-account.json
#    - frontend/.env.local: cấu hình Web app (xem mục 3)

# 3. Tạo các file .env từ file mẫu (không ghi đè file đã có).
#    Lệnh này cũng chép NEXT_PUBLIC_* từ frontend/.env.local sang .env.
#    Lưu ý: dùng `pnpm setup:env`, KHÔNG dùng `pnpm setup` (lệnh có sẵn của pnpm, sẽ sửa PATH).
pnpm setup:env

# 4. Build và khởi động (chế độ phát triển: backend hot reload trong Docker)
docker compose up -d --build
docker compose ps          # chờ mọi container "healthy"

# 5. Frontend chạy trên máy host khi phát triển (Fast Refresh nhanh, xem bên dưới)
pnpm --filter @tms/frontend dev

# 6. Migration (chạy từ máy host, PostgreSQL trong Docker mở cổng 5432) và dữ liệu mẫu
pnpm migrate:all
pnpm seed                  # có khi Identity làm xong (#6)
```

**Hai chế độ chạy:**

| Lệnh | Backend | Frontend | Dùng khi |
|---|---|---|---|
| `docker compose up -d` | Chạy từ stage `build` của Dockerfile, `src/` gắn từ máy host, tự reload khi sửa code (khoảng 5–10 giây) | Không chạy trong Docker; chạy `pnpm --filter @tms/frontend dev` trên máy host | Phát triển hằng ngày |
| `docker compose -f docker-compose.yml up -d --build` | Image production | Image production (cổng 5173) | Kiểm tra bản build, demo, chấm bài |

Frontend chạy trên host khi phát triển vì Next.js khuyến nghị như vậy: trên Windows / macOS, Turbopack trong container không nhận được thay đổi file đi qua lớp chia sẻ file của Docker Desktop, còn cách polling thì chậm và tốn CPU. Backend dùng polling (`TSC_WATCHFILE`) nên reload được trong Docker.

Sau khi chạy xong:

| Địa chỉ | Nội dung |
|---|---|
| http://localhost:5173 | Frontend |
| http://localhost:8080/api | API Gateway |
| http://localhost:8080/docs, http://localhost:3001/docs … 3006/docs | Swagger của gateway và từng service |
| http://localhost:15672 | RabbitMQ Management (`tms` / `tms_dev`; không có user `guest`) |
| http://localhost:8025 | Mailpit – xem các email hệ thống đã gửi |
| `localhost:5432` | PostgreSQL: mỗi service một database và một login role (xem mục 4) |

**Tài khoản mẫu sau khi seed** (có khi Identity làm xong):

| Vai trò | Email | Mật khẩu |
|---|---|---|
| ADMIN | admin@tms.local | `Admin@123` |
| TUTOR | tutor@tms.local | `Tutor@123` |
| PARENT | parent@tms.local | `Parent@123` |
| STUDENT | student@tms.local | `Student@123` |

> Seed tạo các tài khoản này trên Firebase Authentication (kèm custom claim `userId` và `role`) và bản ghi `users` tương ứng trong `identity_db`. Khi phát triển nên trỏ seed và test vào Firebase Auth Emulator (`firebase emulators:start --only auth`) để không tạo tài khoản rác trên project thật.

## 3. Biến môi trường

| File | Dùng cho | Tạo từ |
|---|---|---|
| `.env` (thư mục gốc) | `docker compose`: hạ tầng, URL database từng service (host `postgres`), Firebase, build arg của frontend | [`.env.example`](../.env.example) |
| `backend/<service>/.env` | Chạy service hoặc migration trên máy host (`DATABASE_URL` trỏ `localhost:5432`) | `backend/<service>/.env.example` |
| `frontend/.env.local` | Frontend: `NEXT_PUBLIC_API_URL` và `NEXT_PUBLIC_FIREBASE_*` lấy từ cấu hình Web app trong Firebase console | Tự tạo |

`pnpm setup:env` tạo hai loại file đầu từ file mẫu, không bao giờ ghi đè. Các giá trị `NEXT_PUBLIC_*` là công khai theo thiết kế của Firebase; service account key thì tuyệt đối không commit và không dán vào chat.

> Không commit `.env`, `backend/*/.env`, `frontend/.env.local` và thư mục `infra/keys/`. Các mục này đã có trong `.gitignore`, và `.dockerignore` loại mọi file `.env*` khỏi Docker build.

## 4. Hạ tầng trong `docker-compose.yml`

| Thành phần | Image | Ghi chú |
|---|---|---|
| PostgreSQL | `postgres:18-alpine` | [`infra/postgres/init.sql`](../infra/postgres/init.sql) tạo database + login role cho từng service ở lần khởi động đầu tiên; mỗi role chỉ kết nối được database của mình (`REVOKE CONNECT ... FROM PUBLIC`), kể cả database `postgres` mặc định ([ADR-0003](adr/0003-postgresql-database-per-service.md)). Role có `CREATEDB` để `prisma migrate dev` tạo shadow database. Volume gắn vào `/var/lib/postgresql` (PostgreSQL 18 lưu dữ liệu ở `/var/lib/postgresql/18/docker`). |
| RabbitMQ | `rabbitmq:4.2-management-alpine` | [`infra/rabbitmq/definitions.json`](../infra/rabbitmq/definitions.json) tạo exchange `tms.events`, `tms.dlx` (topic, durable) và user `tms`. Khi nạp definitions lúc khởi động, RabbitMQ không tạo user `guest` (vốn cũng chỉ đăng nhập được từ localhost). |
| Redis | `redis:7.4-alpine` | Rate limit của gateway |
| Mailpit | `axllent/mailpit:v1.27` | Hộp thư giả: SMTP 1025, giao diện 8025 |

Ứng dụng:

- Mọi Dockerfile build từ **thư mục gốc repo** (`build: { context: ., dockerfile: backend/<service>/Dockerfile }`) vì cần pnpm workspace và lockfile.
- Chỉ `api-gateway` và `identity-service` được gắn `infra/keys/` (Firebase service account key, [ADR-0004](adr/0004-firebase-authentication.md)).
- Mỗi service nhận `DATABASE_URL` riêng từ `.env` (`IDENTITY_DB_URL`, `STUDENT_DB_URL`...).
- Health check gọi `/docs-json` cho tới khi issue #4 thêm `/health/ready`; service phụ thuộc chỉ khởi động khi phía kia đã healthy.
- `academic-service` và `notification-service` chưa có trong compose (BR-SYS-03).

## 5. Chạy một service ngoài Docker (để phát triển / debug)

Hạ tầng vẫn chạy trong Docker, chỉ service đang sửa chạy trên máy:

```bash
# Chỉ bật hạ tầng (và tắt container của service sắp chạy trên host, nếu đang chạy)
docker compose up -d postgres rabbitmq redis mailpit
firebase emulators:start --only auth    # nếu service cần Firebase Auth

# Chạy service cần sửa (đọc backend/billing-service/.env do `pnpm setup:env` tạo)
cd backend/billing-service
pnpm migrate:dev
pnpm dev                      # http://localhost:3006/docs
```

Nếu muốn các service khác (vẫn chạy trong Docker) gọi được service đang chạy trên máy, đặt URL nội bộ thành `http://host.docker.internal:3006`.

## 6. Kiểm thử

| Loại | Lệnh | Phạm vi | Trạng thái |
|---|---|---|---|
| Unit / smoke test | `pnpm test` (thư mục gốc chạy mọi package; hoặc trong từng service) | Logic nghiệp vụ: tính phí, kiểm tra trùng lịch, chuyển trạng thái | Đã có (hiện mới có test khởi động app) |
| Integration | dự kiến `pnpm test:int` | PostgreSQL và RabbitMQ thật trong `docker compose`, mỗi lần chạy một database riêng ([ADR-0003](adr/0003-postgresql-database-per-service.md)); đăng nhập qua Firebase Auth Emulator, không dùng project thật | Làm trong issue #4 |
| Contract test | dự kiến `pnpm test:contract` | Kiểm tra schema event trong `packages/contracts` | Làm trong issue #3 |
| End-to-end | dự kiến `pnpm test:e2e` (thư mục gốc) | Kịch bản: tạo học sinh → ghi danh → điểm danh → hóa đơn | Làm trong issue #21 |
| Kiểm tra mã | `pnpm lint`, `pnpm format:check`, `pnpm build` | ESLint (backend + frontend), Prettier, build toàn bộ | Đã có |

**Kịch bản kiểm tra thủ công nhanh:**
1. Đăng nhập `tutor@tms.local` trên frontend (http://localhost:5173, qua Firebase Auth), tạo học sinh, ghi danh vào lớp học phí `PER_SESSION`.
2. Tạo lịch có một buổi hôm nay rồi điểm danh `PRESENT`.
3. Mở RabbitMQ UI và kiểm tra queue `billing.attendance-recorded` đã có message được ack.
4. `GET /api/billing/invoices?period=<tháng hiện tại>`: hóa đơn `DRAFT` có 1 dòng phí.
5. Gửi lại cùng event (nút *Publish* trong RabbitMQ UI): tổng tiền **không đổi** (idempotent).
6. (Khi đã có `notification-service`, BR-SYS-03) Tắt nó (`docker compose stop notification-service`), điểm danh tiếp: vẫn thành công. Bật lại thì email bị dồn sẽ được gửi (xem ở Mailpit).

## 7. Các lệnh hữu ích

```bash
docker compose logs -f billing-service           # xem log một service
docker compose logs -f --since 5m | grep <corrId> # lần theo một request
docker compose restart schedule-service
docker compose up -d --build class-service        # build lại một service (khi đổi package.json)
docker compose --profile frontend-in-docker up -d # thêm frontend (image production, không hot reload)
docker compose down                               # dừng (giữ dữ liệu)
docker compose down -v                            # dừng và XÓA toàn bộ dữ liệu
```

## 8. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `port is already allocated` | Port 5432 / 6379 / 8080 đang bị chiếm (ví dụ PostgreSQL cài sẵn trên Windows) | Tắt dịch vụ đang chiếm port (Services > `postgresql-x64-*`) hoặc đổi port bên trái trong `ports:` |
| Service restart liên tục | DB hoặc RabbitMQ chưa sẵn sàng, sai `*_DB_URL` | `docker compose logs <service>`; kiểm tra healthcheck của hạ tầng |
| Gateway trả `401` cho mọi request | ID token hết hạn / đã bị thu hồi, hoặc gateway không đọc được Firebase service account key, hoặc frontend và gateway trỏ hai Firebase project khác nhau | Kiểm tra `infra/keys/firebase-service-account.json` và `FIREBASE_PROJECT_ID`; so với `NEXT_PUBLIC_FIREBASE_PROJECT_ID` của frontend; đăng nhập lại |
| Đăng nhập được nhưng API trả `403` | Tài khoản Firebase chưa có vai trò (custom claim) | Hoàn tất đăng ký giáo viên hoặc nhận lời mời; Admin kiểm tra người dùng trong Identity |
| Dữ liệu PostgreSQL mất sau `docker compose down` | Volume gắn sai đường dẫn (image PostgreSQL 18 lưu ở `/var/lib/postgresql/18/docker`) | Gắn volume vào `/var/lib/postgresql`, không phải `/var/lib/postgresql/data` |
| Không nhận được email | Đang dùng Mailpit ở môi trường dev | Mở http://localhost:8025 |
| Hóa đơn không cập nhật sau khi điểm danh | Billing chưa nhận event | Xem queue trong RabbitMQ UI; kiểm tra DLQ `billing.dlq` |
| `exec format error` / `\r` trong script | File `.sh` bị đổi line ending thành CRLF trên Windows | `git config core.autocrlf input`, chuyển file về LF |
| Docker chạy chậm, hết RAM | Quá nhiều container | Tăng RAM trong Docker Desktop, hoặc chỉ bật các service cần thiết |
