# 02. Danh mục service

> Sơ đồ liên quan: [architecture](diagrams/02-architecture.puml), [ERD](diagrams/03-erd.puml), [sequence](diagrams/08-sequence-attendance-billing.puml).

## 1. Tổng quan

| # | Service | Port | DB | Vai trò | Bắt buộc cho MVP |
|---|---|---|---|---|:-:|
| 0 | `api-gateway` | 8080 | Redis | Cổng vào duy nhất, định tuyến, xác thực Firebase ID token, rate limit | ✔ |
| 1 | `identity-service` | 3001 | PostgreSQL `identity_db` + Firebase Auth | Vai trò, lời mời, quản lý giáo viên (đăng nhập do Firebase Auth) | ✔ |
| 2 | `student-service` | 3002 | PostgreSQL `student_db` | Hồ sơ học sinh, phụ huynh | ✔ |
| 3 | `class-service` | 3003 | PostgreSQL `class_db` | Lớp học, học phí, ghi danh | ✔ |
| 4 | `schedule-service` | 3004 | PostgreSQL `schedule_db` | Lịch, buổi học, điểm danh | ✔ |
| 5 | `academic-service` | 3005 | MongoDB `academic_db` | Bài tập, điểm, nhận xét | Tùy chọn (BR-SYS-03) |
| 6 | `billing-service` | 3006 | PostgreSQL `billing_db` | Hóa đơn, thanh toán, công nợ | ✔ |
| 7 | `notification-service` | 3007 | PostgreSQL `notification_db` + Redis | Gửi email, SMS, Zalo, push | Tùy chọn (BR-SYS-03) |

**Hạ tầng dùng chung:**

| Thành phần | Port | Mục đích |
|---|---|---|
| PostgreSQL 18 (container) | 5432 | Một container, mỗi service một database và một login role riêng ([ADR-0003](adr/0003-postgresql-database-per-service.md)) |
| Firebase Authentication (dịch vụ ngoài) | – | Lưu mật khẩu, đăng nhập, cấp ID token ([ADR-0004](adr/0004-firebase-authentication.md)); gói Spark miễn phí |
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

**Trách nhiệm:** định tuyến, xác thực Firebase ID token bằng Firebase Admin SDK (kiểm tra cả token đã bị thu hồi) rồi lấy hai custom claim `userId` (là `users.id` của Identity, UUID) và `role`, chuyển xuống thành `X-User-Id` và `X-User-Role`, rate limit theo IP và user (Redis), CORS, gán `X-Correlation-Id`.

| Đường dẫn | Chuyển tới | Cần xác thực |
|---|---|:-:|
| `/api/auth/**` | identity-service | Một phần (nhận lời mời không cần; đăng ký giáo viên cần ID token nhưng chưa cần vai trò) |
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

**Dữ liệu:** `users` (`id` UUID dùng làm id người dùng trong toàn hệ thống, `firebase_uid`, email, vai trò, trạng thái), `invitations`, `outbox_events`. Mật khẩu và phiên đăng nhập nằm ở Firebase Authentication, không lưu trong `identity_db` ([ADR-0004](adr/0004-firebase-authentication.md)).

Đăng nhập, làm mới token, đăng xuất và quên mật khẩu do **Firebase client SDK** ở frontend gọi thẳng tới Firebase, không qua Identity Service.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/register` | Giáo viên tự đăng ký: tạo tài khoản Firebase ở frontend, rồi gọi endpoint này để tạo bản ghi `users` và gán vai trò `TUTOR` | ID token hợp lệ, chưa có vai trò |
| POST | `/auth/invitations` | Mời phụ huynh hoặc học sinh: tạo tài khoản Firebase chưa có mật khẩu + lời mời riêng (1 lần, 7 ngày, BR-AU-02) | TUTOR, ADMIN |
| POST | `/auth/invitations/{token}/accept` | Kích hoạt tài khoản từ lời mời: đặt mật khẩu qua Firebase Admin SDK, gán vai trò | Public |
| GET | `/users/me` | Thông tin người đang đăng nhập | Đã đăng nhập |
| GET/PATCH | `/users/{id}` | Quản lý người dùng; đổi vai trò hoặc vô hiệu hóa giáo viên (`DISABLED`, chỉ khi không còn lớp mở, BR-CL-08) sẽ cập nhật custom claim và thu hồi phiên Firebase | ADMIN |

**Phát event:** `UserRegistered`, `InvitationCreated`
**Nhận event:** không có

---

## 4. Student Service

**Dữ liệu:** `students`, `parents`, `student_parents` (nhiều phụ huynh, đúng 1 phụ huynh chính), `outbox_events`

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
| POST | `/classes/{id}/enrollments` | Ghi danh học sinh. Trả `201` với `status = ACTIVE` (lớp `PER_SESSION`) hoặc `AWAITING_PAYMENT` (lớp `MONTHLY`); trả `202` với `PENDING` khi Student Service không phản hồi | TUTOR, ADMIN |
| PATCH | `/classes/{id}/enrollments/{eid}` | Tạm dừng / rút khỏi lớp | TUTOR, ADMIN |
| GET | `/students/{studentId}/classes` | Các lớp của một học sinh | TUTOR, PARENT, STUDENT |

**Ghi danh lớp `MONTHLY`** ([sơ đồ Saga](diagrams/07-sequence-enrollment-saga.puml)):
- Ghi danh tạo ở trạng thái `AWAITING_PAYMENT` với `payment_deadline = now + 7 ngày` (BR-CL-07). Học sinh vẫn được vào roster và đi học trong thời gian này.
- `PENDING`, `AWAITING_PAYMENT` và `ACTIVE` đều tính vào sĩ số khi kiểm tra `max_students` (BR-CL-06).
- Khi nhận `PaymentReceived` với `invoiceKind = ENROLLMENT` và `invoiceStatus = PAID`, ghi danh chuyển `ACTIVE`.
- Hết hạn mà chưa thanh toán thì chuyển `WITHDRAWN` với `withdraw_reason = UNPAID` và phát `StudentWithdrawn`.

**Phát event:** `ClassCreated`, `ClassUpdated`, `ClassClosed`, `StudentEnrolled`, `StudentWithdrawn`
**Nhận event:** `StudentStatusChanged` (tạm dừng hoặc rút ghi danh), `EnrollmentConfirmed` (ghi `roster_confirmed_at`), `EnrollmentSyncFailed` (giao dịch bù trừ), `PaymentReceived` (kích hoạt ghi danh `AWAITING_PAYMENT`)
**Gọi đồng bộ:** student-service
**Tác vụ định kỳ:** hằng ngày chuyển các ghi danh `AWAITING_PAYMENT` quá `payment_deadline` sang `WITHDRAWN`; đối soát các ghi danh `PENDING`

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

**Phát event:** `SessionScheduled`, `SessionCancelled`, `SessionRescheduled` (dời buổi: thay cho cặp hủy + tạo mới), `AttendanceRecorded`, `AttendanceCorrected`, `EnrollmentConfirmed`
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

**Dữ liệu:** `fee_policies`, `session_calendar`, `invoices`, `invoice_items`, `payments`, `processed_events`, `outbox_events`

`session_calendar` là bản sao cục bộ các buổi học (từ `SessionScheduled` / `SessionCancelled` / `SessionRescheduled`). Billing dùng nó để tính phí `MONTHLY` theo tỉ lệ số buổi khi vào / rời lớp giữa tháng (BR-BI-05, BR-BI-06), không gọi đồng bộ sang Schedule.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/billing/invoices?period=&status=&kind=` | Danh sách hóa đơn (`kind` = `MONTHLY` / `ENROLLMENT`) | TUTOR, ADMIN |
| GET | `/billing/invoices/{id}` | Chi tiết hóa đơn và các dòng phí (FEE, ADJUSTMENT) | TUTOR, ADMIN, Payer |
| GET | `/billing/enrollments/{enrollmentId}/invoice` | Hóa đơn ghi danh của một ghi danh `MONTHLY` | TUTOR, ADMIN, Payer |
| GET | `/billing/invoices/{id}/qr` | Mã VietQR chuyển khoản | TUTOR, Payer |
| POST | `/billing/invoices/{id}/payments` | Ghi nhận thanh toán thủ công (không vượt số còn nợ) | TUTOR, ADMIN |
| POST | `/billing/payments/{id}/reversal` | Tạo bút toán đảo cho khoản ghi sai | TUTOR, ADMIN |
| POST | `/billing/invoices/{id}/void` | Hủy hóa đơn và phát hành hóa đơn thay thế | TUTOR, ADMIN |
| GET | `/billing/students/{id}/balance` | Công nợ học sinh | TUTOR, PARENT |
| GET | `/billing/reports/revenue?from=&to=` | Báo cáo doanh thu | TUTOR, ADMIN |
| POST | `/webhooks/payments/{provider}` | Nhận webhook từ cổng thanh toán / ngân hàng | Chữ ký webhook |

**Hai loại hóa đơn:**
- **Hóa đơn tháng** (`MONTHLY`): `DRAFT` trong tháng, chốt ngày 1, hạn ngày 10.
- **Hóa đơn ghi danh** (`ENROLLMENT`): tạo khi nhận `StudentEnrolled` của lớp `MONTHLY`, `ISSUED` ngay với phí tháng đầu theo tỉ lệ, hạn 7 ngày (BR-BI-06). Hóa đơn tháng sau không lặp lại dòng phí đã thu ở đây.

Hóa đơn đã `ISSUED` không bao giờ bị sửa. Sửa sai được ghi thành dòng `ADJUSTMENT` trên hóa đơn `DRAFT` kế tiếp ([ADR-0002](adr/0002-immutable-invoices-with-adjustments.md)). Trạng thái hóa đơn luôn suy ra từ các khoản `PAYMENT` và `REVERSAL`.

**Phát event:** `InvoiceIssued` (kèm `kind`), `PaymentReceived` (kèm `invoiceKind`, `enrollmentId`, `invoiceStatus`), `InvoiceOverdue`
**Nhận event:** `StudentCreated`, `StudentUpdated`, `StudentStatusChanged`, `ClassCreated`, `ClassUpdated`, `StudentEnrolled`, `StudentWithdrawn`, `AttendanceRecorded`, `AttendanceCorrected`, `SessionScheduled`, `SessionCancelled`, `SessionRescheduled`
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

**Nhận event:** `UserRegistered`, `InvitationCreated`, `EnrollmentConfirmed`, `SessionScheduled`, `SessionCancelled`, `SessionRescheduled`, `AttendanceRecorded` (khi vắng), `GradeRecorded`, `InvoiceIssued`, `InvoiceOverdue`, `PaymentReceived`, `MonthlyReportGenerated`
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
├── backend/                     # mọi service NestJS
│   ├── api-gateway/
│   ├── identity-service/
│   │   ├── src/
│   │   │   ├── modules/         # auth, users, invitations
│   │   │   ├── outbox/          # outbox + relay
│   │   │   ├── messaging/       # publisher / consumer RabbitMQ
│   │   │   ├── app.setup.ts     # cấu hình dùng chung cho main.ts và test
│   │   │   └── main.ts
│   │   ├── test/
│   │   ├── Dockerfile           # build từ thư mục gốc repo
│   │   └── .env.example
│   ├── student-service/
│   ├── class-service/
│   ├── schedule-service/
│   └── billing-service/         # academic / notification: chỉ làm nếu còn thời gian
├── frontend/                    # Next.js (App Router), cổng 5173, chỉ gọi API Gateway
├── packages/
│   ├── contracts/               # kiểu dữ liệu event và DTO dùng chung (versioned)
│   └── common/                  # logger, auth guard, health check, outbox helper
├── infra/
│   ├── rabbitmq/definitions.json
│   └── grafana/
├── docs/
├── pnpm-workspace.yaml          # workspace + catalog phiên bản dùng chung
├── docker-compose.yml
├── docker-compose.override.yml  # cấu hình riêng cho dev (hot reload)
└── .env.example
```
