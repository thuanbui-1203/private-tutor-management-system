# 03. Hướng dẫn cài đặt và chạy

> Tài liệu này mô tả cách thiết lập **dự kiến** của dự án (NestJS + Docker Compose). Các lệnh và file nhắc đến (`docker-compose.yml`, `.env.example`, `infra/`...) sẽ có sau khi dựng khung code theo [02-cac-service.md](02-cac-service.md#11-cấu-trúc-thư-mục-đề-xuất).

## 1. Yêu cầu môi trường

| Công cụ | Phiên bản | Ghi chú |
|---|---|---|
| Docker Desktop | ≥ 4.30 | Trên Windows bật WSL 2 backend; cấp ≥ 6 GB RAM cho Docker |
| Node.js | 20 LTS | Chỉ cần khi chạy service ngoài Docker |
| pnpm | ≥ 9 | `npm i -g pnpm` (monorepo dùng pnpm workspace) |
| Git | bất kỳ | |
| (Tùy chọn) Java 17+ và extension PlantUML | | Để xem / render sơ đồ trong `docs/diagrams` |

Kiểm tra nhanh:

```bash
docker --version && docker compose version
node -v && pnpm -v
```

## 2. Chạy toàn bộ hệ thống bằng Docker (khuyến nghị)

```bash
# 1. Lấy mã nguồn
git clone <repo-url> microservices_final
cd microservices_final

# 2. Tạo file biến môi trường
cp .env.example .env

# 3. Sinh cặp khóa RS256 cho JWT (chỉ làm một lần)
mkdir -p infra/keys
openssl genrsa -out infra/keys/jwt-private.pem 2048
openssl rsa -in infra/keys/jwt-private.pem -pubout -out infra/keys/jwt-public.pem

# 4. Build và khởi động
docker compose up -d --build

# 5. Theo dõi trạng thái (chờ tất cả "healthy")
docker compose ps

# 6. Chạy migration và tạo dữ liệu mẫu
docker compose exec identity-service pnpm migrate:deploy
docker compose exec student-service  pnpm migrate:deploy
# ... lặp lại cho các service còn lại, hoặc dùng:
pnpm run migrate:all
pnpm run seed
```

Sau khi chạy xong:

| Địa chỉ | Nội dung |
|---|---|
| http://localhost:5173 | Frontend |
| http://localhost:8080/api | API Gateway |
| http://localhost:8080/api/docs | Swagger tổng hợp |
| http://localhost:3001/docs … 3007/docs | Swagger của từng service |
| http://localhost:15672 | RabbitMQ Management (`guest` / `guest`) |
| http://localhost:8025 | Mailpit – xem các email hệ thống đã gửi |
| http://localhost:3000 | Grafana (nếu bật profile `observability`) |

**Tài khoản mẫu sau khi seed:**

| Vai trò | Email | Mật khẩu |
|---|---|---|
| ADMIN | admin@tms.local | `Admin@123` |
| TUTOR | tutor@tms.local | `Tutor@123` |
| PARENT | parent@tms.local | `Parent@123` |
| STUDENT | student@tms.local | `Student@123` |

## 3. Biến môi trường

File `.env` ở thư mục gốc dùng chung cho docker compose. Mỗi service có thêm `.env.example` riêng để chạy độc lập.

```dotenv
# ---------- Chung ----------
NODE_ENV=development
LOG_LEVEL=debug
TZ=Asia/Ho_Chi_Minh

# ---------- Hạ tầng ----------
POSTGRES_USER=tms
POSTGRES_PASSWORD=tms_secret
MONGO_URL=mongodb://mongo:27017/academic_db
RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672
REDIS_URL=redis://redis:6379

# ---------- Database từng service ----------
IDENTITY_DB_URL=postgresql://identity:identity@postgres:5432/identity_db
STUDENT_DB_URL=postgresql://student:student@postgres:5432/student_db
CLASS_DB_URL=postgresql://class:class@postgres:5432/class_db
SCHEDULE_DB_URL=postgresql://schedule:schedule@postgres:5432/schedule_db
BILLING_DB_URL=postgresql://billing:billing@postgres:5432/billing_db
NOTIFICATION_DB_URL=postgresql://notification:notification@postgres:5432/notification_db

# ---------- JWT ----------
JWT_PRIVATE_KEY_PATH=/run/keys/jwt-private.pem
JWT_PUBLIC_KEY_PATH=/run/keys/jwt-public.pem
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# ---------- Nghiệp vụ ----------
BILLING_INVOICE_DUE_DAY=10
BILLING_CHARGE_ABSENT=true
ATTENDANCE_EDIT_WINDOW_HOURS=48
REMINDER_BEFORE_MINUTES=60

# ---------- Tích hợp bên ngoài (để trống = tắt) ----------
SMTP_HOST=mailpit
SMTP_PORT=1025
SMTP_FROM="TMS <no-reply@tms.local>"
SENDGRID_API_KEY=
SMS_PROVIDER=            # esms | speedsms | twilio
SMS_API_KEY=
ZALO_OA_ACCESS_TOKEN=
FCM_SERVICE_ACCOUNT_PATH=
PAYOS_CLIENT_ID=
PAYOS_API_KEY=
PAYOS_CHECKSUM_KEY=
BANK_ACCOUNT_NO=
BANK_BIN=
S3_ENDPOINT=http://minio:9000
S3_ACCESS_KEY=minio
S3_SECRET_KEY=minio123
SENTRY_DSN=
```

> Không commit `.env` và thư mục `infra/keys/`. Hai mục này đã có trong `.gitignore`.

## 4. Khung `docker-compose.yml`

```yaml
name: tms

x-service: &service
  restart: on-failure
  env_file: .env
  networks: [tms-net]
  volumes:
    - ./infra/keys:/run/keys:ro
  depends_on:
    postgres: { condition: service_healthy }
    rabbitmq: { condition: service_healthy }

services:
  # ---------- Hạ tầng ----------
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pg-data:/var/lib/postgresql/data
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports: ["5432:5432"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER}"]
      interval: 5s
      retries: 10
    networks: [tms-net]

  mongo:
    image: mongo:7
    volumes: [mongo-data:/data/db]
    ports: ["27017:27017"]
    networks: [tms-net]

  rabbitmq:
    image: rabbitmq:3.13-management-alpine
    ports: ["5672:5672", "15672:15672"]
    volumes:
      - ./infra/rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro
    healthcheck:
      test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
      interval: 10s
      retries: 10
    networks: [tms-net]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]
    networks: [tms-net]

  mailpit:
    image: axllent/mailpit:latest
    ports: ["1025:1025", "8025:8025"]
    networks: [tms-net]

  # ---------- Ứng dụng ----------
  api-gateway:
    <<: *service
    build: ./api-gateway
    ports: ["8080:8080"]
    depends_on: [identity-service, redis]

  identity-service:
    <<: *service
    build: ./services/identity-service
    ports: ["3001:3001"]

  student-service:
    <<: *service
    build: ./services/student-service
    ports: ["3002:3002"]

  class-service:
    <<: *service
    build: ./services/class-service
    ports: ["3003:3003"]

  schedule-service:
    <<: *service
    build: ./services/schedule-service
    ports: ["3004:3004"]

  academic-service:
    <<: *service
    build: ./services/academic-service
    ports: ["3005:3005"]
    depends_on: [mongo, rabbitmq]

  billing-service:
    <<: *service
    build: ./services/billing-service
    ports: ["3006:3006"]

  notification-service:
    <<: *service
    build: ./services/notification-service
    ports: ["3007:3007"]
    depends_on: [rabbitmq, redis, mailpit]

  frontend:
    build: ./frontend
    ports: ["5173:80"]
    depends_on: [api-gateway]
    networks: [tms-net]

networks:
  tms-net:

volumes:
  pg-data:
  mongo-data:
```

`infra/postgres/init.sql` tạo database và user riêng cho từng service:

```sql
CREATE USER identity WITH PASSWORD 'identity';
CREATE DATABASE identity_db OWNER identity;
CREATE USER student WITH PASSWORD 'student';
CREATE DATABASE student_db OWNER student;
-- ... class, schedule, billing, notification
```

## 5. Chạy một service ngoài Docker (để phát triển / debug)

Hạ tầng vẫn chạy trong Docker, chỉ service đang sửa chạy trên máy với hot reload:

```bash
# Chỉ bật hạ tầng
docker compose up -d postgres mongo rabbitmq redis mailpit

# Chạy service cần sửa
cd services/billing-service
cp .env.example .env          # đổi host thành localhost
pnpm install
pnpm migrate:dev
pnpm start:dev                # http://localhost:3006/docs
```

Nếu muốn các service khác (vẫn chạy trong Docker) gọi được service đang chạy trên máy, đặt URL nội bộ thành `http://host.docker.internal:3006`.

## 6. Kiểm thử

| Loại | Lệnh | Phạm vi |
|---|---|---|
| Unit test | `pnpm test` (trong từng service) | Logic nghiệp vụ: tính phí, kiểm tra trùng lịch, chuyển trạng thái |
| Integration | `pnpm test:int` | Chạy với PostgreSQL / RabbitMQ thật qua Testcontainers |
| Contract test | `pnpm test:contract` | Kiểm tra schema event trong `packages/contracts` |
| End-to-end | `pnpm test:e2e` (thư mục gốc) | Kịch bản: tạo học sinh → ghi danh → điểm danh → hóa đơn |
| Toàn bộ | `pnpm -r test` | Mọi service |

**Kịch bản kiểm tra thủ công nhanh:**
1. Đăng nhập `tutor@tms.local`, tạo học sinh, ghi danh vào lớp học phí `PER_SESSION`.
2. Tạo lịch có một buổi hôm nay rồi điểm danh `PRESENT`.
3. Mở RabbitMQ UI và kiểm tra queue `billing.attendance-recorded` đã có message được ack.
4. `GET /api/billing/invoices?period=<tháng hiện tại>`: hóa đơn `DRAFT` có 1 dòng phí.
5. Gửi lại cùng event (nút *Publish* trong RabbitMQ UI): tổng tiền **không đổi** (idempotent).
6. Tắt `notification-service` (`docker compose stop notification-service`), điểm danh tiếp: vẫn thành công. Bật lại thì email bị dồn sẽ được gửi (xem ở Mailpit).

## 7. Các lệnh hữu ích

```bash
docker compose logs -f billing-service           # xem log một service
docker compose logs -f --since 5m | grep <corrId> # lần theo một request
docker compose restart schedule-service
docker compose up -d --build class-service        # build lại một service
docker compose --profile observability up -d      # bật Prometheus / Grafana / Loki
docker compose down                               # dừng (giữ dữ liệu)
docker compose down -v                            # dừng và XÓA toàn bộ dữ liệu
```

## 8. Xử lý sự cố thường gặp

| Hiện tượng | Nguyên nhân | Cách xử lý |
|---|---|---|
| `port is already allocated` | Port 5432 / 6379 / 8080 đang bị chiếm (PostgreSQL cài sẵn trên Windows...) | Tắt dịch vụ đang chiếm port hoặc đổi port bên trái trong `ports:` |
| Service restart liên tục | DB hoặc RabbitMQ chưa sẵn sàng, sai `*_DB_URL` | `docker compose logs <service>`; kiểm tra healthcheck của hạ tầng |
| `401 invalid signature` | Gateway và Identity dùng cặp khóa khác nhau | Sinh lại khóa ở bước 2.3, restart cả hai service |
| Không nhận được email | Đang dùng Mailpit ở môi trường dev | Mở http://localhost:8025 |
| Hóa đơn không cập nhật sau khi điểm danh | Billing chưa nhận event | Xem queue trong RabbitMQ UI; kiểm tra DLQ `billing.dlq` |
| `exec format error` / `\r` trong script | File `.sh` bị đổi line ending thành CRLF trên Windows | `git config core.autocrlf input`, chuyển file về LF |
| Docker chạy chậm, hết RAM | Quá nhiều container | Tăng RAM trong Docker Desktop, hoặc chỉ bật các service cần thiết |
