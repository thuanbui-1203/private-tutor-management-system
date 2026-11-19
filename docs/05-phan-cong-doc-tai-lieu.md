# 05. Phân công đọc tài liệu cho 3 người

Mục tiêu: mỗi người nắm thật chắc một nhóm service, và đủ hiểu phần chung để làm việc với hai người còn lại. Cách chia trùng với phân công code (nhãn issue `agent-a`, `agent-b`, `agent-c` trong [issue #1](https://github.com/thuanbui-1203/private-tutor-management-system/issues/1)), nên ai đọc phần nào thì cũng là người review code phần đó.

| Người | Phạm vi | Service | Issue tương ứng |
|---|---|---|---|
| **Người 1** | Cổng vào và con người | API Gateway, Identity, Student | #6–#10 |
| **Người 2** | Lớp, lịch và điểm danh | Class, Schedule & Attendance | #11–#15 |
| **Người 3** | Học phí | Billing | #16–#20 |

Frontend (#23) không tách thành người thứ tư khi đọc: mỗi người đọc thêm nhóm user story của #23 thuộc phạm vi mình (xem cuối mỗi phần); user story 77–82 (ngôn ngữ, định dạng, trạng thái tải / lỗi) thì cả 3 người cùng đọc.

---

## Bước 0. Phần chung – cả 3 người đọc trước (khoảng 1,5 giờ)

Đọc theo đúng thứ tự, vì phần sau dùng thuật ngữ của phần trước.

| # | Tài liệu | Đọc để hiểu |
|---|---|---|
| 1 | [README.md](README.md) | Bức tranh tổng: phạm vi MVP, cấu trúc monorepo, danh sách ADR |
| 2 | [GLOSSARY.md](../GLOSSARY.md) | Thuật ngữ chuẩn (tiếng Anh trong code, tiếng Việt trong tài liệu). Đọc kỹ: Enrollment, Roster, Invoice, Adjustment, Payer |
| 3 | [01-nghiep-vu.md](01-nghiep-vu.md) §1, §2 | Bối cảnh, 4 vai trò và ma trận quyền |
| 4 | [01-nghiep-vu.md](01-nghiep-vu.md) §4 | 4 luồng nghiệp vụ chính, chạy xuyên qua nhiều service |
| 5 | [01-nghiep-vu.md](01-nghiep-vu.md) §5 | Danh mục event: ai phát, ai nhận. Đánh dấu các dòng có service của mình |
| 6 | [01-nghiep-vu.md](01-nghiep-vu.md) §6, §7 | Yêu cầu phi chức năng; các quy tắc bổ sung (BR-SYS-01..03 áp dụng cho mọi người) |
| 7 | ADR [0001](adr/0001-single-tenant-deployment.md), [0003](adr/0003-postgresql-database-per-service.md), [0004](adr/0004-firebase-authentication.md) | Single-tenant; mỗi service một database; đăng nhập bằng Firebase và id người dùng là UUID |
| 8 | [02-cac-service.md](02-cac-service.md) §1, §10, §11 | Nguyên tắc chung (database riêng, Outbox, idempotent consumer, header `X-User-*`), quy ước RabbitMQ, cấu trúc thư mục |
| 9 | Sơ đồ [02-architecture](diagrams/out/02-architecture.png) | Các service nói chuyện với nhau thế nào |
| 10 | [03-cach-chay.md](03-cach-chay.md) §1–§5 | Chạy được hệ thống trên máy mình |
| 11 | [packages/README.md](../packages/README.md) | Cách dùng `@tms/contracts` để phát / nhận event |

**Tự kiểm tra (cả nhóm):**
- Vì sao service A không được đọc database của service B, và khi cần dữ liệu của B thì A làm gì?
- Một event đi từ lúc ghi vào bảng `outbox_events` tới lúc service khác xử lý xong qua những bước nào? Nếu event bị gửi 2 lần thì chuyện gì xảy ra?
- `X-User-Id` lấy từ đâu, và vì sao nó là UUID chứ không phải `uid` của Firebase?

---

## Người 1 – API Gateway, Identity, Student

**Đọc (khoảng 2 giờ):**

| Tài liệu | Phần |
|---|---|
| [01-nghiep-vu.md](01-nghiep-vu.md) | §3.1 Tài khoản, §3.2 Học sinh; §7 các dòng BR-AU-01, BR-AU-02, BR-ST-04..08 |
| [02-cac-service.md](02-cac-service.md) | §2 API Gateway, §3 Identity, §4 Student |
| [ADR-0004](adr/0004-firebase-authentication.md) | Đọc lại kỹ: custom claim `userId` và `role`, thu hồi token |
| Sơ đồ | [06-sequence-login](diagrams/out/06-sequence-login.png); [09-state-student](diagrams/out/09-state-student.png); phần `identity_db` và `student_db` trong [03-erd](diagrams/out/03-erd.png) |
| [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md) | §3.8 Đăng nhập bên thứ ba |

**Quy tắc phải thuộc:** BR-AU-01, BR-AU-02, BR-ST-01..08, BR-SYS-02.

**Event của mình:**
- Phát: `UserRegistered`, `InvitationCreated`, `StudentCreated`, `StudentUpdated`, `StudentStatusChanged`.
- Nhận: `UserRegistered` (Student gắn `user_id`).

**Tự kiểm tra:**
- Giáo viên tự đăng ký thì những bước nào chạy ở frontend, ở Firebase và ở Identity? Khi nào ID token mới có `role`?
- Học sinh 17 tuổi và học sinh 19 tuổi khác nhau thế nào về phụ huynh chính và người thanh toán?
- Phụ huynh phụ được xem gì, không được xem gì?
- Khi nào được ẩn danh một học sinh, và dữ liệu nào vẫn được giữ lại?

**Frontend (#23):** user story 1–26 (đăng nhập, tài khoản, Admin, quản lý học sinh và phụ huynh).

---

## Người 2 – Class, Schedule & Attendance

**Đọc (khoảng 2,5 giờ):**

| Tài liệu | Phần |
|---|---|
| [01-nghiep-vu.md](01-nghiep-vu.md) | §3.3 Lớp học và ghi danh, §3.4 Lịch học và điểm danh; §4.2, §4.4; §7 các dòng BR-CL-06..08, BR-SC-07..10, BR-NO-01 |
| [02-cac-service.md](02-cac-service.md) | §5 Class, §6 Schedule & Attendance |
| Sơ đồ | [07-sequence-enrollment-saga](diagrams/out/07-sequence-enrollment-saga.png) (quan trọng nhất); [05-activity-schedule](diagrams/out/05-activity-schedule.png); [09-state-enrollment](diagrams/out/09-state-enrollment.png); [09-state-session](diagrams/out/09-state-session.png); phần đầu [08-sequence-attendance-billing](diagrams/out/08-sequence-attendance-billing.png) (tới bước publish); phần `class_db`, `schedule_db` trong [03-erd](diagrams/out/03-erd.png) |
| [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md) | §3.6 Lịch, §3.7 Học online |

**Quy tắc phải thuộc:** BR-CL-01..08, BR-SC-01..10, BR-NO-01.

**Event của mình:**
- Phát: `ClassCreated`, `ClassUpdated`, `ClassClosed`, `StudentEnrolled`, `StudentWithdrawn` (Class); `EnrollmentConfirmed`, `EnrollmentSyncFailed`, `SessionScheduled`, `SessionCancelled`, `SessionRescheduled`, `AttendanceRecorded`, `AttendanceCorrected` (Schedule).
- Nhận: `StudentStatusChanged`, `EnrollmentConfirmed`, `EnrollmentSyncFailed`, `PaymentReceived` (Class); `ClassCreated`, `ClassUpdated`, `ClassClosed`, `StudentEnrolled`, `StudentWithdrawn` (Schedule).

**Tự kiểm tra:**
- Ghi danh vào lớp học phí theo tháng đi qua những trạng thái nào? Điều gì xảy ra nếu sau 7 ngày chưa thanh toán?
- Student Service không phản hồi lúc ghi danh thì Class làm gì, và chỗ ngồi có bị giữ không?
- Vì sao lịch lặp không được sửa, và dời một buổi thì phát event nào?
- Một buổi bị bỏ lỡ (`MISSED`) còn điểm danh được đến khi nào?
- Sửa điểm danh sau ngày 1 của tháng sau thì Billing xử lý thế nào (để nói chuyện với Người 3)?

**Frontend (#23):** user story 27–53 (lớp, ghi danh, lịch, điểm danh) và 63–67, 73–74 (phụ huynh / học sinh xem lịch, chuyên cần).

---

## Người 3 – Billing

**Đọc (khoảng 2,5 giờ):**

| Tài liệu | Phần |
|---|---|
| [01-nghiep-vu.md](01-nghiep-vu.md) | §3.6 Học phí (BR-BI-01..09), §4.3 Cuối tháng; §3.4 bảng trạng thái điểm danh (phần "Tính phí") |
| [ADR-0002](adr/0002-immutable-invoices-with-adjustments.md) | Hóa đơn bất biến, dòng điều chỉnh, bút toán đảo: đọc kỹ nhất |
| [02-cac-service.md](02-cac-service.md) | §8 Billing |
| Sơ đồ | [08-sequence-attendance-billing](diagrams/out/08-sequence-attendance-billing.png); [04-activity-attendance-billing](diagrams/out/04-activity-attendance-billing.png); [09-state-invoice](diagrams/out/09-state-invoice.png); phần Billing trong [07-sequence-enrollment-saga](diagrams/out/07-sequence-enrollment-saga.png); phần `billing_db` trong [03-erd](diagrams/out/03-erd.png) |
| [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md) | §3.2 Thanh toán và đối soát, §3.10 Tạo PDF, §3.11 Hóa đơn điện tử |

**Quy tắc phải thuộc:** BR-BI-01..09, BR-CL-04, BR-CL-07, BR-SC-04, BR-SC-05, BR-ST-05.

**Event của mình:**
- Phát: `InvoiceIssued`, `PaymentReceived`, `InvoiceOverdue`.
- Nhận: `StudentCreated`, `StudentUpdated`, `StudentStatusChanged`, `ClassCreated`, `ClassUpdated`, `StudentEnrolled`, `StudentWithdrawn`, `SessionScheduled`, `SessionCancelled`, `SessionRescheduled`, `AttendanceRecorded`, `AttendanceCorrected`. Billing nhận nhiều event nhất, nên phải nắm chắc bảng §5.

**Tự kiểm tra:**
- Học sinh vào lớp học phí theo tháng ngày 15: hóa đơn ghi danh tính bao nhiêu, dựa vào dữ liệu nào (`session_calendar`)?
- Sửa điểm danh `ABSENT` → `EXCUSED` khi hóa đơn tháng đó đã `ISSUED` thì sinh ra gì, ở hóa đơn nào?
- Thanh toán vượt số còn nợ thì sao? Ghi nhầm một khoản thanh toán thì sửa thế nào?
- Vì sao Billing giữ bản sao lớp, học sinh và buổi học thay vì gọi sang service khác lúc tính phí?

**Frontend (#23):** user story 54–62 (học phí phía giáo viên), 68–72 và 75–76 (học phí phía phụ huynh / học sinh).

---

## Chỗ giao nhau – phải ngồi lại với nhau

Mỗi mục dưới đây cần hai người thống nhất trước khi code (đều đã có trong `@tms/contracts` và [01-nghiep-vu.md](01-nghiep-vu.md) §5):

| Luồng | Người | Nội dung cần thống nhất |
|---|---|---|
| Ghi danh (Saga) | 1, 2, 3 | Class gọi `GET /internal/students/{id}` của Student; Billing tạo hóa đơn ghi danh từ `StudentEnrolled`; Class kích hoạt ghi danh khi nhận `PaymentReceived` |
| Điểm danh → học phí | 2, 3 | Payload `AttendanceRecorded` / `AttendanceCorrected`; khi nào tính phí, khi nào sinh dòng điều chỉnh |
| Lịch → tỉ lệ học phí | 2, 3 | `SessionScheduled` / `SessionCancelled` / `SessionRescheduled` nuôi bảng `session_calendar` của Billing |
| Trạng thái học sinh | 1, 2, 3 | `StudentStatusChanged`: Class tạm dừng / rút ghi danh, Billing ngừng tính phí |
| Vô hiệu hóa giáo viên | 1, 2 | Identity gọi `GET /internal/tutors/{id}/open-classes` của Class (BR-CL-08) |
| Ẩn danh học sinh | 1, 3 | Student gọi `GET /internal/students/{id}/open-invoices` của Billing (BR-ST-08) |
| Lời mời khi tạo học sinh | 1 | Student gọi `POST /internal/invitations` của Identity |

Gợi ý: sau khi mỗi người đọc xong phần mình, mỗi người trình bày 15 phút cho hai người còn lại theo phần "Tự kiểm tra", rồi cả nhóm cùng đi qua sơ đồ [07-sequence-enrollment-saga](diagrams/out/07-sequence-enrollment-saga.png) từ đầu đến cuối.
