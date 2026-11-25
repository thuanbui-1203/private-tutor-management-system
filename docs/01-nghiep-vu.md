# 01. Nghiệp vụ hệ thống

> Hệ thống quản lý học sinh quy mô nhỏ cho gia sư / giáo viên dạy kèm (Tutor Management System – TMS).
> Sơ đồ liên quan: [use-case](diagrams/01-usecase.puml), [activity](diagrams/04-activity-attendance-billing.puml), [state](diagrams/09-state-lifecycle.puml).

## 1. Bối cảnh

| Mục | Mô tả |
|---|---|
| Đối tượng dùng | 1 gia sư độc lập hoặc nhóm / trung tâm nhỏ 1–5 giáo viên |
| Quy mô | Mỗi giáo viên khoảng 10–100 học sinh; lớp 1-1 hoặc lớp nhóm 2–8 em |
| Vấn đề | Lịch chồng chéo, quên buổi dạy bù, tính học phí theo buổi dễ sai, khó báo tiến độ cho phụ huynh |
| Mục tiêu | Một nơi duy nhất quản lý học sinh, lịch, điểm danh, điểm số, học phí; tự động nhắc lịch và nhắc phí |

## 2. Tác nhân và phân quyền

| Vai trò | Mô tả | Phạm vi dữ liệu được xem |
|---|---|---|
| `ADMIN` | Chủ trung tâm | Toàn bộ dữ liệu, báo cáo doanh thu, quản lý giáo viên |
| `TUTOR` | Giáo viên | Chỉ học sinh, lớp, lịch, hóa đơn do mình quản lý (`tutor_id = mình`) |
| `PARENT` | Phụ huynh | Chỉ dữ liệu của con mình (bảng `student_parents`); chỉ phụ huynh chính xem học phí |
| `STUDENT` | Học sinh | Chỉ dữ liệu của bản thân; chỉ xem học phí khi đã đủ 18 tuổi và là người thanh toán (Payer) của chính mình |
| `SYSTEM` | Tác vụ định kỳ (cron) | Chốt hóa đơn, nhắc lịch, đánh dấu quá hạn |

**Ma trận quyền (rút gọn):**

| Chức năng | ADMIN | TUTOR | PARENT | STUDENT |
|---|:-:|:-:|:-:|:-:|
| Quản lý giáo viên | ✔ | | | |
| Thêm / sửa học sinh | ✔ | ✔ | | |
| Tạo lớp, ghi danh | ✔ | ✔ | | |
| Thiết lập lịch, hủy / dạy bù | ✔ | ✔ | | |
| Điểm danh, nhập điểm, nhận xét | | ✔ | | |
| Xem lịch, điểm, nhận xét | ✔ | ✔ | ✔ (con) | ✔ (bản thân) |
| Xem hóa đơn, thanh toán | ✔ | ✔ | ✔ (con) | |
| Ghi nhận thanh toán | ✔ | ✔ | | |
| Báo cáo doanh thu | ✔ | ✔ (của mình) | | |

## 3. Các module nghiệp vụ

### 3.1. Tài khoản (Identity)

- Giáo viên tự đăng ký hoặc được Admin mời qua email.
- Tài khoản phụ huynh và học sinh do giáo viên **mời**: hệ thống gửi link kích hoạt, người nhận tự đặt mật khẩu.
- Đăng nhập bằng email + mật khẩu qua **Firebase Authentication** (giai đoạn sau có thể thêm Google) ([ADR-0004](adr/0004-firebase-authentication.md)).
- Firebase lưu mật khẩu, cấp ID token (hiệu lực 1 giờ, SDK tự làm mới), xử lý quên mật khẩu và chặn đăng nhập sai liên tục (thay cho quy tắc tự khóa 15 phút trước đây).
- Identity Service vẫn quản lý vai trò (lưu thành custom claim trên tài khoản Firebase), lời mời và việc vô hiệu hóa giáo viên. Mỗi lần đổi vai trò hoặc vô hiệu hóa, Identity thu hồi phiên đăng nhập để thay đổi có hiệu lực ngay.

### 3.2. Học sinh (Student)

- Hồ sơ gồm họ tên, ngày sinh, trường, khối lớp, ghi chú (điểm yếu, mục tiêu), phụ huynh liên kết.
- Một phụ huynh có thể có nhiều con; mỗi học sinh có tối đa 1 phụ huynh chính.
- Vòng đời học sinh: `ACTIVE → PAUSED → ACTIVE`, `ACTIVE → GRADUATED`, `ACTIVE/PAUSED → DROPPED`.
- **Quy tắc:**
  - BR-ST-01: không được xóa hẳn học sinh còn hóa đơn `ISSUED` hoặc `OVERDUE`.
  - BR-ST-02: học sinh `PAUSED` quá 60 ngày thì hệ thống tự chuyển sang `DROPPED`.
  - BR-ST-03: khi học sinh chuyển `PAUSED`, mọi ghi danh của em cũng chuyển `PAUSED` và không sinh phí.

### 3.3. Lớp học và ghi danh (Class)

- Lớp có các thuộc tính: tên, môn, loại (`ONE_ON_ONE` / `GROUP`), sĩ số tối đa, chính sách học phí.
- Hai chính sách học phí:
  - `PER_SESSION` – tính theo buổi thực học (ví dụ 200.000đ/buổi).
  - `MONTHLY` – trọn gói tháng (ví dụ 1.500.000đ/tháng), không phụ thuộc số buổi.
- **Quy tắc:**
  - BR-CL-01: lớp `ONE_ON_ONE` chỉ có đúng 1 học sinh `ACTIVE`.
  - BR-CL-02: lớp `GROUP` không vượt `max_students`.
  - BR-CL-03: một học sinh không được ghi danh 2 lần vào cùng một lớp (`UNIQUE(class_id, student_id)`).
  - BR-CL-04: đổi học phí chỉ áp dụng từ kỳ hóa đơn **tiếp theo**, không sửa hóa đơn đã phát hành.
  - BR-CL-05: đóng lớp thì toàn bộ ghi danh chuyển `WITHDRAWN` và các buổi tương lai bị hủy.

### 3.4. Lịch học và điểm danh (Schedule & Attendance)

- Giáo viên khai báo lịch lặp (ví dụ thứ 2 và thứ 5, 19:00–20:30, từ 01/09 đến 31/12). Hệ thống sinh sẵn các buổi học, mỗi lần tối đa 3 tháng.
- Vòng đời buổi học: `SCHEDULED → IN_PROGRESS → COMPLETED`, hoặc `CANCELLED`, `RESCHEDULED`, `MISSED`.
- Bốn trạng thái điểm danh:

| Trạng thái | Ý nghĩa | Tính phí (PER_SESSION) |
|---|---|:-:|
| `PRESENT` | Có mặt | ✔ |
| `LATE` | Đi trễ | ✔ |
| `EXCUSED` | Vắng có phép (báo trước ≥ 24h) | ✘ |
| `ABSENT` | Vắng không phép | ✔ (cấu hình được) |

- **Quy tắc:**
  - BR-SC-01: một giáo viên không được có 2 buổi học trùng giờ (kiểm tra khi tạo lịch, dời buổi, dạy bù).
  - BR-SC-02: chỉ được điểm danh khi buổi đã bắt đầu và chưa đóng.
  - BR-SC-03: chỉ được sửa điểm danh trong vòng 48 giờ sau buổi học. Khi sửa, hệ thống phát `AttendanceCorrected` để Billing điều chỉnh phí.
  - BR-SC-04: giáo viên hủy buổi thì không tính phí cho học sinh nào và gợi ý tạo buổi bù.
  - BR-SC-05: buổi bù liên kết với buổi gốc qua `makeup_of`, tính phí như một buổi bình thường (chỉ với lớp `PER_SESSION`; lớp `MONTHLY` không tính thêm).
  - BR-SC-06: quá 24h sau giờ kết thúc mà chưa điểm danh thì buổi chuyển `MISSED` và giáo viên nhận nhắc nhở.

### 3.5. Học tập (Academic)

- Giao bài tập cho lớp, kèm hạn nộp và file đính kèm.
- Nhập điểm theo loại `HOMEWORK`, `QUIZ`, `TEST`, thang 0–10.
- Nhận xét từng học sinh theo buổi, đánh giá 1–5 sao.
- Báo cáo tiến độ tháng: điểm trung bình, tỉ lệ chuyên cần, các nhận xét nổi bật.
- BR-AC-01: chỉ được nhận xét buổi `COMPLETED` cho học sinh có mặt (`PRESENT` / `LATE`).

### 3.6. Học phí (Billing)

- Mỗi học sinh có **một hóa đơn cho mỗi tháng** (`UNIQUE(student_id, period)`). Hóa đơn gộp tất cả các lớp em học.
- Hóa đơn ở trạng thái `DRAFT` trong tháng, được cập nhật dần theo từng lần điểm danh.
- 00:00 ngày 1 hàng tháng: chốt hóa đơn tháng trước (`DRAFT → ISSUED`), hạn thanh toán là ngày 10.
- Cho phép thanh toán nhiều lần (`PARTIALLY_PAID`), bằng tiền mặt, chuyển khoản hoặc ví điện tử.
- **Quy tắc:**
  - BR-BI-01: mỗi cặp (buổi học, học sinh) chỉ sinh tối đa 1 khoản phí, tức là chống tính trùng.
  - BR-BI-02: hóa đơn có tổng bằng 0 sẽ tự `VOID` khi chốt.
  - BR-BI-03: quá hạn thì chuyển `OVERDUE` vào ngày hôm sau hạn thanh toán và gửi nhắc vào các ngày hạn + 1, + 5, + 10 (áp dụng cho cả hóa đơn tháng và hóa đơn ghi danh).
  - BR-BI-04: không sửa hóa đơn đã `ISSUED`; nếu sai thì `VOID` rồi phát hành hóa đơn thay thế. Hóa đơn tháng chỉ có tối đa 1 bản không `VOID` cho mỗi (học sinh, kỳ). Sửa điểm danh sau khi chốt hóa đơn tạo **dòng điều chỉnh (Adjustment)** trên hóa đơn kế tiếp, không sửa hóa đơn cũ ([ADR-0002](adr/0002-immutable-invoices-with-adjustments.md)).
  - BR-BI-05: lớp `MONTHLY` tạo 1 dòng phí cố định cho tháng, không đổi khi giáo viên hủy buổi hay có buổi bù; học sinh vào hoặc rời giữa tháng thì tính theo tỉ lệ số buổi trong khoảng thời gian học. Nếu đã thu thừa thì chênh lệch được điều chỉnh ở hóa đơn kế tiếp, hệ thống không hoàn tiền.
  - BR-BI-06: lớp `MONTHLY` khi ghi danh sẽ phát hành ngay **hóa đơn ghi danh** (phí tháng đầu theo tỉ lệ, hạn 7 ngày). Hóa đơn tháng sau đó không lặp lại dòng phí này. Lớp `PER_SESSION` không có hóa đơn ghi danh.
  - BR-BI-07: khoản thanh toán không được vượt số còn nợ của hóa đơn; thanh toán không sửa / xóa, ghi sai thì tạo bút toán đảo (Reversal). Trạng thái hóa đơn luôn được suy ra từ các khoản thanh toán.
  - BR-BI-08: phí `ABSENT` cấu hình theo từng lớp (mặc định có tính phí), thay cho biến môi trường toàn cục.
  - BR-BI-09: học sinh `DROPPED` vẫn bị tính các buổi đã học; hóa đơn nháp vẫn được chốt bình thường.

### 3.7. Thông báo (Notification)

| Sự kiện | Người nhận | Kênh | Thời điểm |
|---|---|---|---|
| Nhắc lịch học | Học sinh, phụ huynh | Email / Zalo / Push | Trước buổi 1 giờ |
| Buổi học bị hủy / dời | Học sinh, phụ huynh | Email / Zalo | Ngay lập tức |
| Học sinh vắng không phép | Phụ huynh | SMS / Zalo | Ngay sau điểm danh |
| Hóa đơn tháng | Phụ huynh | Email | Ngày 1 |
| Nhắc học phí quá hạn | Phụ huynh | Email / Zalo | Ngày 11, 15, 20 |
| Biên nhận thanh toán | Phụ huynh | Email | Ngay khi ghi nhận |
| Báo cáo tiến độ tháng | Phụ huynh | Email (PDF) | Ngày 1 |
| Có điểm mới | Phụ huynh | Push | Ngay khi nhập |

- Mỗi người dùng tự chọn kênh nhận thông báo và có thể tắt từng loại.
- Gửi lỗi thì thử lại tối đa 3 lần với khoảng chờ tăng dần, vẫn lỗi thì chuyển vào Dead Letter Queue.

## 4. Các luồng nghiệp vụ chính

### 4.1. Bắt đầu với một học sinh mới
1. Giáo viên tạo hồ sơ học sinh và nhập thông tin phụ huynh.
2. Hệ thống gửi lời mời kích hoạt tài khoản cho phụ huynh (tùy chọn).
3. Giáo viên ghi danh học sinh vào một lớp có sẵn hoặc tạo lớp 1-1 mới.
4. Hệ thống thêm học sinh vào các buổi sắp tới và gửi email chào mừng kèm lịch học.

### 4.2. Một buổi học
1. Trước 1 giờ: học sinh và phụ huynh nhận nhắc lịch.
2. Đến giờ, giáo viên mở buổi rồi điểm danh.
3. Billing tự cộng khoản phí; phụ huynh của học sinh vắng không phép nhận tin báo.
4. Giáo viên nhập nhận xét và giao bài tập (tùy chọn).

### 4.3. Cuối tháng
1. Ngày 1: Billing chốt hóa đơn, phụ huynh nhận email hóa đơn kèm mã QR chuyển khoản.
2. Academic tổng hợp báo cáo tiến độ và gửi cho phụ huynh.
3. Khi phụ huynh chuyển khoản, giáo viên ghi nhận thủ công, hoặc hệ thống tự đối soát qua webhook ngân hàng nếu đã tích hợp (xem [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md)).
4. Từ ngày 11, hóa đơn chưa thanh toán chuyển `OVERDUE` và hệ thống gửi nhắc.

### 4.4. Hủy buổi và dạy bù
1. Giáo viên hủy buổi và nhập lý do. Hệ thống phát `SessionCancelled`, Notification báo cho học sinh và phụ huynh.
2. Giáo viên chọn "Tạo buổi bù" và chọn giờ mới; hệ thống kiểm tra trùng lịch.
3. Buổi bù được tạo với `makeup_of` trỏ về buổi gốc, kèm `SessionScheduled` để nhắc lịch.

## 5. Danh mục event nghiệp vụ

| Event | Routing key | Service phát | Payload chính | Service nhận |
|---|---|---|---|---|
| `UserRegistered` | `user.registered` | Identity | userId, email, role, selfRegistered? | Student, Notification |
| `InvitationCreated` | `invitation.created` | Identity | invitationId, userId, email, expiresAt | Notification |
| `StudentCreated` / `StudentUpdated` | `student.created` / `student.updated` | Student | studentId, fullName, tutorId, payerContact | Billing, Notification |
| `StudentStatusChanged` | `student.status-changed` | Student | studentId, from, to | Class, Billing |
| `ClassCreated` / `ClassUpdated` | `class.created` / `class.updated` | Class | classId, tutorId, feeType, feeAmount, chargeAbsent, effectiveFrom | Billing, Schedule |
| `ClassClosed` | `class.closed` | Class | classId | Schedule |
| `StudentEnrolled` | `enrollment.enrolled` | Class | enrollmentId, classId, studentId, studentName, feeType, status, joinedAt | Schedule, Billing (lớp `MONTHLY` → hóa đơn ghi danh) |
| `EnrollmentConfirmed` | `enrollment.confirmed` | Schedule | enrollmentId, classId, studentId | Class, Notification (gửi email chào mừng, BR-NO-01) |
| `EnrollmentSyncFailed` | `enrollment.sync-failed` | Schedule | enrollmentId, classId, studentId, error | Class (bù trừ → `REJECTED`) |
| `StudentWithdrawn` | `enrollment.withdrawn` | Class | enrollmentId, classId, studentId, reason (`REQUESTED`, `UNPAID`, `CLASS_CLOSED`, `STUDENT_STATUS`, `SYNC_FAILED`) | Schedule, Billing |
| `SessionScheduled` | `session.scheduled` | Schedule | sessionId, classId, startAt, studentIds | Billing (bản sao `session_calendar` để tính tỉ lệ phí), Notification |
| `SessionCancelled` | `session.cancelled` | Schedule | sessionId, reason, cancelledBy | Billing, Notification |
| `SessionRescheduled` | `session.rescheduled` | Schedule | oldSessionId, newSessionId, classId, newStartAt, studentIds | Billing (cập nhật `session_calendar`), Notification (1 thông báo "dời buổi") |
| `AttendanceRecorded` | `attendance.recorded` | Schedule | sessionId, studentId, classId, status, date | Billing, Academic, Notification |
| `AttendanceCorrected` | `attendance.corrected` | Schedule | sessionId, studentId, classId, date, oldStatus, newStatus | Billing |
| `GradeRecorded` | `grade.recorded` | Academic | studentId, classId, type, score | Notification |
| `InvoiceIssued` | `invoice.issued` | Billing | invoiceId, kind, studentId, enrollmentId?, period, total, dueDate | Notification |
| `PaymentReceived` | `payment.received` | Billing | invoiceId, invoiceKind, enrollmentId?, amount, method, invoiceStatus | Class (kích hoạt ghi danh `AWAITING_PAYMENT`), Notification |
| `InvoiceOverdue` | `invoice.overdue` | Billing | invoiceId, daysOverdue | Notification |

Nguồn chuẩn của bảng này là package `@tms/contracts` (`packages/contracts`): mỗi event có kiểu dữ liệu, routing key và bộ kiểm tra (zod). Một test đọc bảng này và báo lỗi nếu hai bên lệch nhau, nên khi đổi event phải sửa cả hai trong cùng một PR.

- **Id:** mọi id là UUID. Id người dùng (`userId`, `tutorId`, `cancelledBy`...) là `users.id` của Identity, nằm trong custom claim `userId` của Firebase ID token; `uid` của Firebase không đi ra ngoài Identity ([ADR-0004](adr/0004-firebase-authentication.md)).
- **Kiểu dữ liệu:** tiền là số nguyên VND; ngày dạng `YYYY-MM-DD`, kỳ dạng `YYYY-MM`, thời điểm dạng ISO 8601 theo UTC (`...Z`).
- `payerContact`: tên và email / số điện thoại của người thanh toán (phụ huynh chính, hoặc chính học sinh đã trưởng thành, BR-ST-05).
- `PaymentReceived` chỉ phát cho khoản thanh toán, không phát cho bút toán đảo; `invoiceStatus` là `PARTIALLY_PAID` hoặc `PAID` sau khoản đó.

Mọi event đều có phần chung (envelope):

```json
{
  "eventId": "uuid",
  "eventType": "AttendanceRecorded",
  "occurredAt": "2026-11-08T12:30:00Z",
  "correlationId": "uuid",
  "version": 1,
  "data": { }
}
```

## 6. Yêu cầu phi chức năng

| Nhóm | Yêu cầu |
|---|---|
| Hiệu năng | API đọc p95 < 300ms; điểm danh 1 lớp < 1s |
| Sẵn sàng | Một service phụ lỗi (Notification, Academic) không làm gián đoạn điểm danh và học phí |
| Nhất quán | Nhất quán cuối cùng (eventual consistency) giữa các service, trễ < 5s; không mất event (Outbox); không xử lý trùng (idempotent consumer) |
| Bảo mật | HTTPS, đăng nhập qua Firebase Authentication, gateway xác thực Firebase ID token, phân quyền ở từng service, không log thông tin cá nhân |
| Quyền riêng tư | Dữ liệu trẻ vị thành niên: chỉ phụ huynh và giáo viên phụ trách được xem; hỗ trợ xóa / ẩn danh khi nghỉ học |
| Nhật ký kiểm toán | Mọi request (kể cả `GET` và request bị gateway từ chối) có Access record; mọi thay đổi nghiệp vụ có Change record ghi cùng transaction, không sửa/xóa được; không ghi nội dung request, token hay giá trị dữ liệu cá nhân ([ADR-0005](adr/0005-audit-log.md)) |
| Dữ liệu nhạy cảm | Thông tin ngân hàng chỉ lưu khi người dùng đồng ý, số tài khoản mã hóa; rút đồng ý thì xóa số đầy đủ, chỉ giữ bản đã che ([ADR-0006](adr/0006-bank-details-with-consent.md)) |
| Khả năng quan sát | Log có `correlationId`, endpoint `/health/live` và `/health/ready`, metrics Prometheus |
| Triển khai | Toàn bộ chạy bằng `docker compose up` |

## 7. Quy tắc bổ sung (chốt sau phiên rà soát nghiệp vụ)

Thuật ngữ chuẩn nằm ở [GLOSSARY.md](../GLOSSARY.md); quyết định kiến trúc nằm ở [docs/adr/](adr/).

| Mã | Quy tắc |
|---|---|
| BR-AU-01 | Mỗi người dùng giữ đúng 1 vai trò. Admin có thể sở hữu lớp như một giáo viên. |
| BR-AU-02 | Lời mời kích hoạt dùng 1 lần, hiệu lực 7 ngày; gửi lại sẽ thu hồi link cũ. |
| BR-ST-04 | Mọi học sinh có tài khoản theo mặc định (tạo lời mời khi thêm học sinh). Dưới 18 tuổi bắt buộc có thông tin phụ huynh; lời mời gửi cho học sinh nếu em có email, và cho cả phụ huynh chính (nếu có email và chưa có tài khoản); em chưa có email thì chỉ mời phụ huynh chính. Lời mời được gửi qua email. |
| BR-ST-05 | Mỗi học sinh có 1 người thanh toán (Payer) duy nhất: phụ huynh chính, hoặc chính học sinh nếu đã đủ 18 tuổi. Đủ 18 tuổi không tự đổi Payer. |
| BR-ST-06 | Một học sinh có thể có nhiều phụ huynh, đúng 1 phụ huynh chính. Phụ huynh phụ xem lịch, điểm, nhận xét nhưng không xem học phí. |
| BR-ST-07 | Ghi chú trong hồ sơ học sinh chỉ giáo viên và Admin xem. |
| BR-ST-08 | Ẩn danh học sinh chỉ thực hiện theo yêu cầu, khi học sinh đã `DROPPED` / `GRADUATED` và mọi hóa đơn đã `PAID` hoặc `VOID`; dữ liệu cá nhân bị xóa, số liệu tiền được giữ với mã giả danh. |
| BR-CL-06 | Ghi danh `PENDING` (chờ Student Service), `AWAITING_PAYMENT` và `ACTIVE` đều giữ chỗ. |
| BR-CL-07 | Lớp `MONTHLY`: ghi danh ở trạng thái `AWAITING_PAYMENT` cho đến khi thanh toán hóa đơn ghi danh; sau 7 ngày chưa thanh toán thì chuyển `WITHDRAWN` (lý do `UNPAID`), nhả chỗ và phát `StudentWithdrawn`. Trong 7 ngày vẫn được học; khoản đã phát sinh không bị xóa. |
| BR-CL-08 | Giáo viên chỉ bị vô hiệu hóa (không xóa) và chỉ khi không còn lớp đang mở; Admin chuyển lớp sang giáo viên khác trước. |
| BR-SC-07 | Lịch lặp (Schedule) bất biến: muốn đổi thì kết thúc lịch cũ và tạo lịch mới; người nhận chỉ thấy 1 thông báo "đổi lịch". |
| BR-SC-08 | `EXCUSED` do giáo viên chọn; hệ thống không kiểm tra quy tắc báo trước 24h. |
| BR-SC-09 | Buổi `MISSED` vẫn điểm danh được đến 48h sau khi kết thúc; quá hạn thì khóa và không tính phí. |
| BR-SC-10 | Dữ liệu buổi học nhóm chỉ hiển thị phần của chính học sinh / phụ huynh đó, không lộ tên hay dữ liệu bạn khác. |
| BR-NO-01 | Email chào mừng chỉ gửi sau khi Schedule xác nhận học sinh đã vào roster (event `EnrollmentConfirmed`). |
| BR-SYS-01 | Một triển khai phục vụ đúng một trung tâm ([ADR-0001](adr/0001-single-tenant-deployment.md)). |
| BR-SYS-02 | Toàn hệ thống dùng một múi giờ (Asia/Ho_Chi_Minh); thời điểm lưu theo UTC. |
| BR-SYS-03 | Phạm vi dự án: gateway + Identity, Student, Class, Schedule & Attendance, Billing. Notification và Academic được mô tả nhưng chỉ làm nếu còn thời gian. |
