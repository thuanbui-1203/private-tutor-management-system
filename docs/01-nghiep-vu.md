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
| `PARENT` | Phụ huynh | Chỉ dữ liệu của con mình (`students.parent_id`) |
| `STUDENT` | Học sinh | Chỉ dữ liệu của bản thân, không xem học phí |
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
- Đăng nhập bằng email + mật khẩu (giai đoạn sau có thể thêm Google).
- Access token sống 15 phút, refresh token 7 ngày, mỗi lần làm mới sẽ cấp refresh token mới (xoay vòng).
- Đăng nhập sai 5 lần liên tiếp thì khóa tài khoản 15 phút.

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
  - BR-SC-05: buổi bù liên kết với buổi gốc qua `makeup_of`, tính phí như một buổi bình thường.
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
  - BR-BI-03: quá hạn thì chuyển `OVERDUE` và gửi nhắc vào các ngày 11, 15, 20.
  - BR-BI-04: không sửa hóa đơn đã `ISSUED`; nếu sai thì `VOID` rồi phát hành hóa đơn thay thế.
  - BR-BI-05: lớp `MONTHLY` tạo 1 dòng phí cố định cho tháng; nếu học sinh vào giữa tháng thì tính theo tỉ lệ số buổi còn lại.

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

| Event | Service phát | Payload chính | Service nhận |
|---|---|---|---|
| `UserRegistered` | Identity | userId, email, role | Notification |
| `StudentCreated` / `StudentUpdated` | Student | studentId, fullName, tutorId, parentContact | Billing, Notification |
| `StudentStatusChanged` | Student | studentId, from, to | Class, Billing |
| `ClassCreated` / `ClassUpdated` | Class | classId, tutorId, feeType, feeAmount, effectiveFrom | Billing, Schedule |
| `ClassClosed` | Class | classId | Schedule |
| `StudentEnrolled` | Class | classId, studentId, studentName | Schedule, Billing, Notification |
| `StudentWithdrawn` | Class | classId, studentId, reason | Schedule, Billing |
| `SessionScheduled` | Schedule | sessionId, classId, startAt, studentIds | Notification |
| `SessionCancelled` | Schedule | sessionId, reason, cancelledBy | Billing, Notification |
| `AttendanceRecorded` | Schedule | sessionId, studentId, classId, status, date | Billing, Academic, Notification |
| `AttendanceCorrected` | Schedule | sessionId, studentId, oldStatus, newStatus | Billing |
| `GradeRecorded` | Academic | studentId, classId, type, score | Notification |
| `InvoiceIssued` | Billing | invoiceId, studentId, period, total, dueDate | Notification |
| `PaymentReceived` | Billing | invoiceId, amount, method | Notification |
| `InvoiceOverdue` | Billing | invoiceId, daysOverdue | Notification |

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
| Bảo mật | HTTPS, mật khẩu bcrypt, JWT RS256, phân quyền ở từng service, không log thông tin cá nhân |
| Quyền riêng tư | Dữ liệu trẻ vị thành niên: chỉ phụ huynh và giáo viên phụ trách được xem; hỗ trợ xóa / ẩn danh khi nghỉ học |
| Khả năng quan sát | Log có `correlationId`, endpoint `/health/live` và `/health/ready`, metrics Prometheus |
| Triển khai | Toàn bộ chạy bằng `docker compose up` |
