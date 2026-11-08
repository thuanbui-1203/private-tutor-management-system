# 02. Danh mục service

> Sơ đồ liên quan: [architecture](diagrams/02-architecture.puml), [ERD](diagrams/03-erd.puml), [sequence](diagrams/08-sequence-attendance-billing.puml).

## 1. Tổng quan

| # | Service | Port | DB | Vai trò | Bắt buộc cho MVP |
|---|---|---|---|---|:-:|
| 0 | `api-gateway` | 8080 | Redis | Cổng vào duy nhất, định tuyến, xác thực JWT, rate limit | ✔ |
| 1 | `identity-service` | 3001 | PostgreSQL `identity_db` | Tài khoản, đăng nhập, cấp token | ✔ |
| 2 | `student-service` | 3002 | PostgreSQL `student_db` | Hồ sơ học sinh, phụ huynh | ✔ |
| 3 | `class-service` | 3003 | PostgreSQL `class_db` | Lớp học, học phí, ghi danh | ✔ |
| 4 | `schedule-service` | 3004 | PostgreSQL `schedule_db` | Lịch, buổi học, điểm danh | ✔ |
| 5 | `academic-service` | 3005 | MongoDB `academic_db` | Bài tập, điểm, nhận xét | Giai đoạn 4 |
| 6 | `billing-service` | 3006 | PostgreSQL `billing_db` | Hóa đơn, thanh toán, công nợ | Giai đoạn 3 |
| 7 | `notification-service` | 3007 | PostgreSQL `notification_db` + Redis | Gửi email, SMS, Zalo, push | Giai đoạn 2 |

**Hạ tầng dùng chung:**

| Thành phần | Port | Mục đích |
|---|---|---|
| PostgreSQL 16 | 5432 | Một instance, mỗi service một database và một user riêng (môi trường dev) |
| MongoDB 7 | 27017 | Cho academic-service |
| RabbitMQ 3.13 | 5672 / 15672 (UI) | Message broker, exchange `tms.events` loại topic |
| Redis 7 | 6379 | Rate limit, cache, delayed job (BullMQ) |
| Mailpit | 1025 (SMTP) / 8025 (UI) | Hộp thư giả để test email ở môi trường dev |
| Prometheus + Grafana (tùy chọn) | 9090 / 3000 | Metrics |
| Loki (tùy chọn) | 3100 | Log tập trung |

**Nguyên tắc chung:**
- Mỗi service sở hữu riêng DB của mình. **Không** service nào truy cập DB của service khác.
- Giao tiếp đồng bộ qua REST (chỉ khi cần câu trả lời ngay), có timeout 2s, retry 2 lần và circuit breaker.
- Giao tiếp bất đồng bộ qua RabbitMQ. Event được ghi vào **Outbox table** trong cùng transaction với dữ liệu nghiệp vụ, sau đó mới publish.
- Bên nhận event phải **idempotent**: lưu `eventId` đã xử lý vào `processed_events`.
- Gateway chuyển xuống các header `X-User-Id`, `X-User-Role`, `X-Correlation-Id`.
- Mọi service đều có `GET /health/live`, `GET /health/ready`, `GET /metrics` và tài liệu Swagger tại `/docs`.

---

## 2. API Gateway

**Trách nhiệm:** định tuyến, kiểm tra chữ ký JWT bằng public key (lấy từ JWKS của Identity và cache lại), rate limit theo IP và user (Redis), CORS, gán `X-Correlation-Id`.

| Đường dẫn | Chuyển tới | Cần xác thực |
|---|---|:-:|
| `/api/auth/**` | identity-service | Một phần (login, refresh không cần) |
| `/api/users/**` | identity-service | ✔ |
| `/api/students/**`, `/api/parents/**` | student-service | ✔ |
| `/api/classes/**` | class-service | ✔ |
| `/api/schedules/**`, `/api/sessions/**` | schedule-service | ✔ |
| `/api/academic/**` | academic-service | ✔ |
| `/api/billing/**` | billing-service | ✔ |
| `/api/notifications/**` | notification-service | ✔ |
| `/api/webhooks/**` | billing-service / notification-service | ✘ (xác thực bằng chữ ký webhook) |

---

## 3. Identity Service

**Dữ liệu:** `users`, `refresh_tokens`, `invitations`, `outbox_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/register` | Giáo viên tự đăng ký | Public |
| POST | `/auth/login` | Đăng nhập, trả access token và refresh token | Public |
| POST | `/auth/refresh` | Đổi refresh token lấy access token mới | Public (cookie) |
| POST | `/auth/logout` | Thu hồi refresh token | Đã đăng nhập |
| POST | `/auth/invitations` | Mời phụ huynh hoặc học sinh | TUTOR, ADMIN |
| POST | `/auth/invitations/{token}/accept` | Kích hoạt tài khoản từ lời mời | Public |
| POST | `/auth/forgot-password`, `/auth/reset-password` | Quên mật khẩu | Public |
| GET | `/users/me` | Thông tin người đang đăng nhập | Đã đăng nhập |
| GET/PATCH | `/users/{id}` | Quản lý người dùng | ADMIN |
| GET | `/.well-known/jwks.json` | Public key để kiểm tra JWT | Nội bộ |

**Phát event:** `UserRegistered`, `InvitationCreated`
**Nhận event:** không có

---

## 4. Student Service

**Dữ liệu:** `students`, `parents`, `outbox_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/students?status=&q=&page=` | Danh sách học sinh của giáo viên | TUTOR, ADMIN |
| POST | `/students` | Tạo học sinh (kèm phụ huynh) | TUTOR, ADMIN |
| GET | `/students/{id}` | Chi tiết học sinh | TUTOR (chủ sở hữu), PARENT (con), STUDENT (bản thân) |
| PATCH | `/students/{id}` | Sửa thông tin | TUTOR, ADMIN |
| POST | `/students/{id}/status` | Đổi trạng thái (PAUSED, GRADUATED...) | TUTOR, ADMIN |
| DELETE | `/students/{id}` | Ẩn danh / xóa (kiểm tra công nợ) | ADMIN |
| GET | `/parents/me/children` | Danh sách con của phụ huynh | PARENT |
| POST | `/parents`, PATCH `/parents/{id}` | Quản lý phụ huynh | TUTOR, ADMIN |

**Phát event:** `StudentCreated`, `StudentUpdated`, `StudentStatusChanged`
**Nhận event:** `UserRegistered` (gắn `user_id` cho phụ huynh / học sinh khi kích hoạt tài khoản)
**Được gọi đồng bộ bởi:** class-service (`GET /internal/students/{id}`)

---

## 5. Class Service

**Dữ liệu:** `classes`, `enrollments`, `outbox_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/classes` | Danh sách lớp | TUTOR, ADMIN |
| POST | `/classes` | Tạo lớp (môn, loại, học phí) | TUTOR, ADMIN |
| PATCH | `/classes/{id}` | Sửa lớp, đổi học phí (áp dụng kỳ sau) | TUTOR, ADMIN |
| POST | `/classes/{id}/close` | Đóng lớp | TUTOR, ADMIN |
| GET | `/classes/{id}/students` | Danh sách học sinh đang học | TUTOR; nội bộ |
| POST | `/classes/{id}/enrollments` | Ghi danh học sinh | TUTOR, ADMIN |
| PATCH | `/classes/{id}/enrollments/{eid}` | Tạm dừng / rút khỏi lớp | TUTOR, ADMIN |
| GET | `/students/{studentId}/classes` | Các lớp của một học sinh | TUTOR, PARENT, STUDENT |

**Phát event:** `ClassCreated`, `ClassUpdated`, `ClassClosed`, `StudentEnrolled`, `StudentWithdrawn`
**Nhận event:** `StudentStatusChanged` (tạm dừng hoặc rút ghi danh), `EnrollmentSyncFailed` (giao dịch bù trừ)
**Gọi đồng bộ:** student-service

---

## 6. Schedule & Attendance Service

**Dữ liệu:** `schedules`, `sessions`, `attendances`, `class_roster_view`, `outbox_events`, `processed_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/schedules` | Tạo lịch lặp, sinh buổi học (có kiểm tra trùng) | TUTOR |
| POST | `/schedules/preview` | Xem trước các buổi sẽ sinh và các buổi bị trùng | TUTOR |
| DELETE | `/schedules/{id}` | Ngừng lịch lặp (hủy các buổi tương lai) | TUTOR |
| GET | `/sessions?from=&to=&classId=` | Lịch theo tuần / tháng | Mọi vai trò (lọc theo quyền) |
| POST | `/sessions` | Tạo buổi lẻ hoặc buổi bù (`makeupOf`) | TUTOR |
| POST | `/sessions/{id}/start` | Mở buổi học | TUTOR |
| POST | `/sessions/{id}/cancel` | Hủy buổi | TUTOR |
| POST | `/sessions/{id}/reschedule` | Dời buổi | TUTOR |
| PUT | `/sessions/{id}/attendance` | Lưu / sửa điểm danh (≤ 48h) | TUTOR |
| GET | `/students/{id}/attendance?month=` | Lịch sử chuyên cần | TUTOR, PARENT, STUDENT |
| GET | `/calendar/{token}.ics` | Lịch dạng iCal để đồng bộ Google / Apple Calendar | Token riêng |

**Phát event:** `SessionScheduled`, `SessionCancelled`, `AttendanceRecorded`, `AttendanceCorrected`
**Nhận event:** `StudentEnrolled`, `StudentWithdrawn`, `ClassClosed`
**Gọi đồng bộ:** class-service (khi chưa có roster trong `class_roster_view`)
**Tác vụ định kỳ:** mỗi giờ quét các buổi quá hạn và chuyển sang `MISSED`; mỗi tuần sinh thêm buổi cho lịch lặp

---

## 7. Academic Service

**Dữ liệu (MongoDB):** `assignments`, `grades`, `feedbacks`, `processed_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/academic/assignments` | Giao bài tập | TUTOR |
| GET | `/academic/classes/{id}/assignments` | Danh sách bài tập | TUTOR, STUDENT, PARENT |
| POST | `/academic/grades` | Nhập điểm | TUTOR |
| GET | `/academic/students/{id}/grades` | Điểm của học sinh | TUTOR, PARENT, STUDENT |
| POST | `/academic/feedbacks` | Nhận xét buổi học | TUTOR |
| GET | `/academic/students/{id}/report?month=` | Báo cáo tiến độ tháng | TUTOR, PARENT |

**Phát event:** `GradeRecorded`, `MonthlyReportGenerated`
**Nhận event:** `AttendanceRecorded` (mở form nhận xét)

---

## 8. Billing Service

**Dữ liệu:** `fee_policies`, `invoices`, `invoice_items`, `payments`, `processed_events`, `outbox_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/billing/invoices?period=&status=` | Danh sách hóa đơn | TUTOR, ADMIN |
| GET | `/billing/invoices/{id}` | Chi tiết hóa đơn và các dòng phí | TUTOR, PARENT (con) |
| GET | `/billing/invoices/{id}/qr` | Mã VietQR chuyển khoản | TUTOR, PARENT |
| POST | `/billing/invoices/{id}/payments` | Ghi nhận thanh toán thủ công | TUTOR, ADMIN |
| POST | `/billing/invoices/{id}/void` | Hủy hóa đơn | TUTOR, ADMIN |
| GET | `/billing/students/{id}/balance` | Công nợ học sinh | TUTOR, PARENT |
| GET | `/billing/reports/revenue?from=&to=` | Báo cáo doanh thu | TUTOR, ADMIN |
| POST | `/webhooks/payments/{provider}` | Nhận webhook từ cổng thanh toán / ngân hàng | Chữ ký webhook |

**Phát event:** `InvoiceIssued`, `PaymentReceived`, `InvoiceOverdue`
**Nhận event:** `StudentCreated`, `StudentUpdated`, `StudentStatusChanged`, `ClassCreated`, `ClassUpdated`, `StudentEnrolled`, `AttendanceRecorded`, `AttendanceCorrected`, `SessionCancelled`
**Tác vụ định kỳ:** 00:00 ngày 1 chốt hóa đơn; 08:00 hằng ngày đánh dấu hóa đơn quá hạn và gửi nhắc

---

## 9. Notification Service

**Dữ liệu:** `notifications`, `templates`, `user_preferences`, `processed_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/notifications/me` | Thông báo trong app của người dùng | Đã đăng nhập |
| PATCH | `/notifications/{id}/read` | Đánh dấu đã đọc | Đã đăng nhập |
| GET/PUT | `/notifications/preferences` | Chọn kênh, bật / tắt từng loại thông báo | Đã đăng nhập |
| POST | `/notifications/devices` | Đăng ký push token (FCM) | Đã đăng nhập |

**Nhận event:** `UserRegistered`, `InvitationCreated`, `StudentEnrolled`, `SessionScheduled`, `SessionCancelled`, `AttendanceRecorded` (khi vắng), `GradeRecorded`, `InvoiceIssued`, `InvoiceOverdue`, `PaymentReceived`, `MonthlyReportGenerated`
**Cách thiết kế:** mỗi kênh gửi là một *adapter* (`EmailChannel`, `SmsChannel`, `ZaloChannel`, `PushChannel`) cài đặt chung một interface `NotificationChannel`. Nhờ vậy có thể đổi nhà cung cấp mà không sửa logic nghiệp vụ.

---

## 10. Quy ước RabbitMQ

| Thành phần | Giá trị |
|---|---|
| Exchange | `tms.events` (topic, durable) |
| Routing key | `<aggregate>.<action>`, ví dụ `attendance.recorded`, `invoice.issued` |
| Queue | `<service>.<event>`, ví dụ `billing.attendance-recorded` |
| Dead letter | Exchange `tms.dlx` → queue `<service>.dlq` |
| Retry | Tối đa 3 lần, delay 5s → 30s → 2 phút |
| Ack | Ack thủ công, chỉ sau khi đã commit DB |

## 11. Cấu trúc thư mục đề xuất

```
microservices_final/
├── api-gateway/
├── services/
│   ├── identity-service/
│   │   ├── src/
│   │   │   ├── modules/         # auth, users, invitations
│   │   │   ├── outbox/          # outbox table + relay
│   │   │   ├── messaging/       # publisher / consumer RabbitMQ
│   │   │   └── main.ts
│   │   ├── prisma/ (hoặc migrations/)
│   │   ├── test/
│   │   ├── Dockerfile
│   │   └── .env.example
│   ├── student-service/
│   ├── class-service/
│   ├── schedule-service/
│   ├── academic-service/
│   ├── billing-service/
│   └── notification-service/
├── packages/
│   ├── contracts/               # kiểu dữ liệu event và DTO dùng chung (versioned)
│   └── common/                  # logger, auth guard, health check, outbox helper
├── frontend/
├── infra/
│   ├── postgres/init.sql        # tạo database + user cho từng service
│   ├── rabbitmq/definitions.json
│   └── grafana/
├── docs/
├── docker-compose.yml
├── docker-compose.override.yml  # cấu hình riêng cho dev (hot reload)
└── .env.example
```
