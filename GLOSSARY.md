# Tutor Management System – Thuật ngữ

Hệ thống giúp gia sư độc lập và trung tâm dạy kèm nhỏ quản lý học sinh, lớp học, lịch học, điểm danh, điểm số và học phí.

**Quy ước:** mỗi khái niệm có một **thuật ngữ tiếng Anh dùng trong code** (tên class, bảng, event, API) và một **thuật ngữ tiếng Việt dùng trong tài liệu**. Mục _Tránh dùng_ liệt kê các từ dễ gây nhầm, không dùng cho khái niệm đó ở cả code lẫn tài liệu.

## Thuật ngữ

### Con người

**Tutor** – Giáo viên:
Người dạy các lớp và sở hữu dữ liệu của mình. Admin có dạy thì được xem như giáo viên đối với các lớp họ sở hữu.
_Tránh dùng_: Teacher, instructor; "gia sư" (chỉ dùng khi nói về người dùng mục tiêu)

**Admin** – Quản trị viên:
Chủ trung tâm, xem được mọi dữ liệu và quản lý giáo viên. Là vai trò riêng, khác Tutor; mỗi người chỉ giữ đúng một vai trò.
_Tránh dùng_: Owner, manager, chủ

**Parent** – Phụ huynh:
Người giám hộ gắn với một học sinh. Một học sinh có thể có nhiều phụ huynh, đúng một người là phụ huynh chính (Payer); chỉ phụ huynh chính xem được học phí.
_Tránh dùng_: Guardian

**Invitation** – Lời mời:
Đường link dùng một lần, hiệu lực 7 ngày, giúp học sinh hoặc phụ huynh kích hoạt tài khoản và tự đặt mật khẩu. Gửi lại sẽ thu hồi link cũ. Đây là token riêng của hệ thống, không phải email kích hoạt của Firebase.
_Tránh dùng_: Activation email, signup link

**Student** – Học sinh:
Người học ghi danh vào một hoặc nhiều lớp. Mặc định mọi học sinh đều có tài khoản; học sinh dưới 18 tuổi phải có thông tin người giám hộ.
_Tránh dùng_: Pupil, child, "con" (trừ khi nói từ góc nhìn phụ huynh)

**Payer** – Người thanh toán:
Người duy nhất của mỗi học sinh nhận và thanh toán hóa đơn. Với học sinh chưa đủ 18 tuổi là phụ huynh chính; với người học đã trưởng thành là chính học sinh đó.
_Tránh dùng_: Bill-to, customer, khách hàng

**Anonymisation** – Ẩn danh:
Xóa tên, thông tin liên lạc và ghi chú của học sinh đã nghỉ khi có yêu cầu, sau khi mọi hóa đơn đã tất toán. Số liệu tiền được giữ lại với mã giả danh.
_Tránh dùng_: Deletion, GDPR delete, xóa học sinh

### Lớp và buổi học

**Class** – Lớp:
Một lớp nhóm (hoặc 1-1) dạy một môn, kèm chính sách học phí.
_Tránh dùng_: Course, khóa học

**Session** – Buổi học:
Một lần học có ngày giờ cụ thể của một lớp.
_Tránh dùng_: Lesson, meeting, "tiết"

**Schedule** – Lịch lặp:
Mẫu lặp hằng tuần, bất biến, dùng để sinh các buổi học của lớp. Muốn đổi thì kết thúc lịch cũ và tạo lịch mới.
_Tránh dùng_: Timetable, recurring session, thời khóa biểu

**Missed session** – Buổi bị bỏ lỡ (`MISSED`):
Buổi học chưa được điểm danh sau 24 giờ kể từ giờ kết thúc. Vẫn điểm danh được đến 48 giờ sau giờ kết thúc; quá hạn thì khóa và không tính phí.
_Tránh dùng_: Skipped session, buổi vắng

**Makeup session** – Buổi bù:
Buổi học thay cho một buổi đã hủy và liên kết về buổi gốc (`makeup_of`).
_Tránh dùng_: Replacement class, lớp thay thế

**Enrollment** – Ghi danh:
Việc một học sinh thuộc một lớp, với trạng thái `PENDING`, `AWAITING_PAYMENT`, `ACTIVE`, `PAUSED`, `WITHDRAWN` hoặc `REJECTED`. `PENDING`, `AWAITING_PAYMENT` và `ACTIVE` đều giữ chỗ.
_Tránh dùng_: Registration, đăng ký lớp

**Awaiting payment** – Chờ thanh toán (`AWAITING_PAYMENT`):
Trạng thái ghi danh của học sinh vào lớp học phí theo tháng khi chưa trả hóa đơn ghi danh. Sau 7 ngày chuyển `WITHDRAWN` (lý do `UNPAID`). Lớp học phí theo buổi không có trạng thái này.
_Tránh dùng_: Unpaid enrollment, deposit pending, nợ cọc

**Roster** – Danh sách lớp (roster):
Các học sinh có ghi danh `ACTIVE` hoặc `AWAITING_PAYMENT` trong một lớp, dùng để biết ai sẽ có mặt ở các buổi học. Học sinh chờ thanh toán vẫn đi học trong 7 ngày đó.
_Tránh dùng_: Class list, attendance list, danh sách điểm danh

### Điểm danh

**Attendance** – Điểm danh:
Bản ghi cho biết học sinh có mặt ở buổi học hay không: `PRESENT`, `LATE`, `EXCUSED` hoặc `ABSENT`.

**Excused absence** – Vắng có phép (`EXCUSED`):
Vắng mà giáo viên chọn đánh dấu `EXCUSED` vì học sinh đã báo trước khoảng 24 giờ. Hệ thống không kiểm tra việc báo trước.
_Tránh dùng_: Approved absence, nghỉ được duyệt

### Học phí

**Invoice** – Hóa đơn:
Yêu cầu thanh toán gửi tới người thanh toán của học sinh, gồm các dòng phí gắn với giáo viên. Có hai loại: hóa đơn tháng và hóa đơn ghi danh.
_Tránh dùng_: Bill, phiếu thu

**Monthly invoice** – Hóa đơn tháng:
Hóa đơn định kỳ cho một học sinh trong một tháng. Mỗi học sinh mỗi tháng có tối đa một hóa đơn tháng chưa `VOID`; hóa đơn đã `VOID` có thể được thay thế.
_Tránh dùng_: Statement, sao kê

**Enrollment invoice** – Hóa đơn ghi danh:
Hóa đơn phát hành ngay khi ghi danh vào lớp học phí theo tháng, chỉ gồm phí kỳ đầu tính theo tỉ lệ. Hóa đơn tháng sau đó bỏ qua các dòng đã thu theo cách này.
_Tránh dùng_: Deposit, first invoice, tiền cọc

**Payment** – Thanh toán:
Bản ghi bất biến về số tiền đã nhận cho một hóa đơn, không bao giờ vượt số còn nợ. Trạng thái hóa đơn được suy ra từ các khoản thanh toán và bút toán đảo.
_Tránh dùng_: Receipt, transaction, giao dịch

**Reversal** – Bút toán đảo:
Một khoản thanh toán dùng để hủy một khoản thanh toán đã ghi sai trước đó.
_Tránh dùng_: Refund, payment edit, hoàn tiền

**Adjustment** – Dòng điều chỉnh:
Dòng trên hóa đơn còn mở kế tiếp để sửa một khoản phí trên hóa đơn đã phát hành, ví dụ sau khi sửa điểm danh. Hóa đơn đã phát hành không bao giờ bị sửa.
_Tránh dùng_: Credit note, refund line

**Per-session fee** – Học phí theo buổi (`PER_SESSION`):
Học phí tính cho mỗi buổi học có mặt hoặc phải tính phí, kể cả buổi bù.

**Monthly fee** – Học phí theo tháng (`MONTHLY`):
Học phí trọn gói của tháng, không phụ thuộc số buổi. Buổi bù và buổi bị hủy không làm thay đổi nó.
_Tránh dùng_: Package fee, subscription, gói đăng ký
