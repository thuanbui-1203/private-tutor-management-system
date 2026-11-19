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
| MongoDB 7 (chưa có trong compose) | 27017 | Cho academic-service, chỉ thêm nếu còn thời gian (BR-SYS-03) |
| RabbitMQ 4.2 | 5672 / 15672 (UI) | Message broker, exchange `tms.events` và `tms.dlx` loại topic; user `tms` |
| Redis 7.4 | 6379 | Rate limit, cache, delayed job (BullMQ) |
| Mailpit | 1025 (SMTP) / 8025 (UI) | Hộp thư giả để test email ở môi trường dev |
| Prometheus + Grafana (tùy chọn, chưa có trong compose) | 9090 / 3000 | Metrics |
| Loki (tùy chọn, chưa có trong compose) | 3100 | Log tập trung |

**Nguyên tắc chung:**
- Mỗi service sở hữu riêng DB của mình. **Không** service nào truy cập DB của service khác.
- Giao tiếp đồng bộ qua REST (chỉ khi cần câu trả lời ngay), có timeout 2s, retry 2 lần và circuit breaker.
- Giao tiếp bất đồng bộ qua RabbitMQ. Event được ghi vào **Outbox table** trong cùng transaction với dữ liệu nghiệp vụ, sau đó mới publish.
- Bên nhận event phải **idempotent**: lưu `eventId` đã xử lý vào `processed_events`.
- Gateway chuyển xuống các header `X-User-Id`, `X-User-Role`, `X-Correlation-Id`.
- Mọi service đều có `GET /health/live`, `GET /health/ready`, `GET /metrics` và tài liệu Swagger tại `/docs`.
- Các nguyên tắc trên đã có sẵn trong package dùng chung [`@tms/common`](../packages/README.md): outbox + relay, consumer idempotent có retry và DLQ, `AuthGuard` đọc `X-User-*`, health / metrics, logger JSON mang `correlationId`, HTTP client nội bộ có timeout, retry và circuit breaker. Service không tự viết lại các phần này.

---

## 2. API Gateway

**Trách nhiệm:** định tuyến, xác thực Firebase ID token bằng Firebase Admin SDK (kiểm tra cả token đã bị thu hồi) rồi lấy hai custom claim `userId` (là `users.id` của Identity, UUID) và `role`, chuyển xuống thành `X-User-Id` và `X-User-Role`, rate limit theo IP và user (Redis), CORS, gán `X-Correlation-Id`.

| Đường dẫn (sau `/api`) | Chuyển tới | Xác thực |
|---|---|---|
| `POST /auth/invitations/{token}/accept` | identity-service | Không (public) |
| `POST /auth/register` | identity-service | ID token hợp lệ, chưa cần vai trò; gateway chuyển nguyên header `Authorization` để Identity tự xác thực |
| `/auth/**`, `/users/**` | identity-service | ID token có claim `userId` + `role` |
| `/students/{id}/classes` | class-service | Như trên |
| `/students/{id}/attendance` | schedule-service | Như trên |
| `/students/**`, `/parents/**` | student-service | Như trên |
| `/classes/**` | class-service | Như trên |
| `/schedules/**`, `/sessions/**` | schedule-service | Như trên |
| `GET /calendar/{token}.ics` | schedule-service | Không (token riêng trong đường dẫn) |
| `/billing/**` | billing-service | ID token có claim `userId` + `role` |
| `/academic/**`, `/notifications/**`, `/webhooks/**` | – | Trả 501 (ngoài phạm vi MVP, BR-SYS-03) |
| Mọi đường dẫn có đoạn `internal` | – | Trả 404: API nội bộ không bao giờ đi qua gateway |

**Cách gateway xử lý một request** (`backend/api-gateway/src/gateway`):

1. Giới hạn theo IP (Redis, cửa sổ 1 phút, `RATE_LIMIT_IP_PER_MINUTE`, mặc định 600) → quá thì 429 kèm `Retry-After`.
2. Xóa mọi header `X-User-*` và `Authorization` do client gửi.
3. Xác thực ID token (`verifyIdToken(token, checkRevoked = true)`): thiếu, sai, hết hạn, bị thu hồi → 401; hợp lệ nhưng chưa có claim → 403 (trừ `/auth/register`).
4. Giới hạn theo người dùng (`RATE_LIMIT_USER_PER_MINUTE`, mặc định 300).
5. Gắn `X-User-Id` (claim `userId`, không bao giờ là `uid` của Firebase), `X-User-Role`, `X-Correlation-Id` rồi chuyển tiếp nguyên luồng (body không bị đọc ở gateway). Service không phản hồi → 502, quá 30 giây → 504.

Redis không hoạt động thì gateway bỏ qua giới hạn (ghi log) thay vì chặn toàn bộ API. CORS cho các origin trong `CORS_ORIGINS` (mặc định `http://localhost:5173`).
---

## 3. Identity Service

**Dữ liệu:** `users` (`id` UUID dùng làm id người dùng trong toàn hệ thống, `firebase_uid`, email, vai trò, trạng thái), `invitations`, `outbox_events`. Mật khẩu và phiên đăng nhập nằm ở Firebase Authentication, không lưu trong `identity_db` ([ADR-0004](adr/0004-firebase-authentication.md)).

Đăng nhập, làm mới token, đăng xuất và quên mật khẩu do **Firebase client SDK** ở frontend gọi thẳng tới Firebase, không qua Identity Service.

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| POST | `/auth/register` | Giáo viên tự đăng ký: tạo tài khoản Firebase ở frontend, rồi gọi endpoint này để tạo bản ghi `users` và gán vai trò `TUTOR` | ID token hợp lệ, chưa có vai trò |
| POST | `/auth/invitations` | Mời phụ huynh hoặc học sinh (body `email`, `fullName`, `role` = `PARENT` / `STUDENT`): tạo tài khoản Firebase chưa có mật khẩu, bản ghi `users` `PENDING` và lời mời riêng (1 lần, 7 ngày, chỉ lưu SHA-256 của token, BR-AU-02); phát `InvitationCreated`. Gửi lại cho người còn `PENDING` sẽ thu hồi link cũ. Ngoài production, response kèm `acceptUrl` (chưa có Notification để gửi email) | TUTOR, ADMIN |
| POST | `/internal/invitations` | Như trên, cho student-service khi tạo học sinh (BR-ST-04); body thêm `invitedBy`. Gateway chặn `/internal/**` | Nội bộ |
| POST | `/auth/invitations/{token}/accept` | Kích hoạt tài khoản từ lời mời (body `password`, tối thiểu 8 ký tự): đặt mật khẩu qua Firebase Admin SDK, gán claim `userId` + `role`, chuyển `ACTIVE`, phát `UserRegistered`. Token không tồn tại → 404; đã dùng, đã thu hồi hoặc hết hạn → 410 | Public |
| GET | `/users/me` | Thông tin người đang đăng nhập | Đã đăng nhập |
| GET/PATCH | `/users/{id}` | Quản lý người dùng; PATCH body `role` và / hoặc `status` (`ACTIVE` / `DISABLED`). Đổi vai trò cập nhật claim; vô hiệu hóa khóa tài khoản Firebase (giáo viên chỉ khi không còn lớp mở, BR-CL-08, gọi class-service `GET /internal/tutors/{id}/open-classes`); mọi thay đổi đều thu hồi phiên đăng nhập. Admin không tự sửa tài khoản của mình | ADMIN |

**Phát event:** `UserRegistered`, `InvitationCreated`
**Nhận event:** không có

---

## 4. Student Service

**Dữ liệu:** `students`, `parents`, `student_parents` (nhiều phụ huynh, đúng 1 phụ huynh chính: partial unique index trong database), `outbox_events`, `processed_events`

| Method | Endpoint | Mô tả | Quyền |
|---|---|---|---|
| GET | `/students?status=&q=&page=&pageSize=` | Danh sách học sinh (giáo viên chỉ thấy học sinh của mình) | TUTOR, ADMIN |
| POST | `/students` | Tạo học sinh kèm phụ huynh (`parents`: liên kết `parentId` có sẵn hoặc nhập mới, `isPrimary`); mặc định gửi lời mời (`invite`) | TUTOR, ADMIN (Admin phải ghi `tutorId`) |
| GET | `/students/{id}` | Chi tiết học sinh, mỗi người xem một phần (xem dưới) | TUTOR (chủ sở hữu), ADMIN, PARENT (con), STUDENT (bản thân) |
| PATCH | `/students/{id}` | Sửa thông tin | TUTOR (chủ sở hữu), ADMIN |
| POST | `/students/{id}/parents` | Thêm / liên kết phụ huynh; `isPrimary: true` đổi phụ huynh chính | TUTOR (chủ sở hữu), ADMIN |
| DELETE | `/students/{id}/parents/{parentId}` | Bỏ liên kết phụ huynh (không bỏ được phụ huynh chính) | TUTOR (chủ sở hữu), ADMIN |
| POST | `/students/{id}/status` | Đổi trạng thái (PAUSED, GRADUATED...) – issue #10 | TUTOR, ADMIN |
| DELETE | `/students/{id}` | Ẩn danh (kiểm tra công nợ) – issue #10 | ADMIN |
| GET | `/parents/me/children` | Danh sách con của phụ huynh đang đăng nhập | PARENT |
| POST | `/parents`, PATCH `/parents/{id}` | Quản lý phụ huynh (đổi liên hệ của phụ huynh chính → phát lại `StudentUpdated`) | TUTOR, ADMIN |
| GET | `/internal/students/{id}` | DTO `InternalStudentResponse` cho class-service | Nội bộ |

**Quy tắc đã cài đặt:**
- Dưới 18 tuổi (tính theo ngày ở Việt Nam) bắt buộc có phụ huynh chính và người thanh toán là phụ huynh chính (BR-ST-04, BR-ST-05); đủ 18 tuổi có thể tự thanh toán nhưng khi đó phải có email; đủ 18 tuổi không tự đổi người thanh toán. Vi phạm → 422.
- Ai xem được gì (BR-ST-06, BR-ST-07): giáo viên chủ sở hữu và Admin thấy tất cả kể cả `note`; phụ huynh chính thấy học phí (`payer`, `payerContact`) và liên hệ các phụ huynh; phụ huynh phụ không thấy học phí và liên hệ; học sinh thấy học phí chỉ khi tự thanh toán. Người không liên quan nhận 404 (không phải 403) để không lộ học sinh có tồn tại.
- Lời mời (BR-ST-04): gửi cho học sinh nếu có email, nếu không thì cho phụ huynh chính có email; Identity lỗi thì học sinh vẫn được tạo, response ghi `invitation.status = failed`.
- Nhập lại cùng một phụ huynh (cùng email) cho anh chị em thì dùng lại bản ghi cũ; cùng một người do hai giáo viên nhập là hai bản ghi, nhưng một tài khoản phụ huynh thấy con ở cả hai.

**Phát event:** `StudentCreated`, `StudentUpdated` (cả khi đổi phụ huynh chính hoặc liên hệ của phụ huynh chính), `StudentStatusChanged` (#10)
**Nhận event:** `UserRegistered` (gắn `user_id` cho phụ huynh / học sinh theo email khi kích hoạt tài khoản)
**Gọi đồng bộ:** identity-service `POST /internal/invitations`
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
