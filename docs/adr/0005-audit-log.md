# Nhật ký kiểm toán: Access record ở gateway, Change record ở từng service

Mọi hành động của người dùng phải được ghi lại. "Hành động" có hai mức, và chúng tôi ghi cả hai:

1. **Access record**: API Gateway ghi một bản cho **mọi** request dưới `/api`, kể cả `GET` và cả những request gateway tự từ chối (401, 403, 404, 429, 501). Gateway gửi bản ghi lên exchange `tms.audit` (routing key `access.recorded`), audit-service lưu vào database riêng `audit_db`. Mọi request đều đi qua gateway, nên không endpoint nào bị sót.
2. **Change record**: service sở hữu dữ liệu ghi một bản cho mỗi thay đổi nghiệp vụ vào bảng `audit_log` của chính nó, **trong cùng transaction** với thay đổi (`recordChange(tx, …)` trong `@tms/common`). Thay đổi commit thì bản ghi có; rollback thì không. Gateway không biết trường nào đổi, service thì biết.

Hai loại bản ghi nối với nhau bằng `correlationId` (gateway tạo, đi theo request, log và event). audit-service có `GET /audit/access` và `GET /audit/changes` cho Admin; `GET /audit/changes` hỏi `GET /internal/audit` của từng service rồi gộp lại.

## Những gì không bao giờ được ghi

- Nội dung request/response, giá trị header, giá trị query (chỉ ghi tên tham số), token. Đoạn đường dẫn bí mật (`/auth/invitations/{token}/accept`, `/calendar/{token}.ics`) được thay bằng `:token`.
- Dữ liệu cá nhân trong Change record: chỉ ghi là trường đó đã đổi (`[personal]`), không ghi giá trị. Bảng `audit_log` không sửa được, nên nếu ghi giá trị thì Anonymisation (BR-ST-08) sẽ không bao giờ hoàn tất. Danh sách mặc định: `PERSONAL_FIELDS` trong `@tms/common`; service thêm được trường riêng.
- Bí mật (mật khẩu, token, khóa, dữ liệu đã mã hóa) ghi là `[secret]`; số tài khoản/thẻ ghi dạng `••••1234`.

## Toàn vẹn

- `audit_log` có trigger chặn `UPDATE`, `DELETE`, `TRUNCATE`, kể cả với role của chính service.
- `access_log` của audit-service chỉ bị xóa bởi job dọn theo thời hạn lưu (`AUDIT_RETENTION_DAYS`, mặc định 365 ngày).

## Khi RabbitMQ không có mặt

Gateway gửi bằng publisher confirm. Nếu broker không xác nhận, bản ghi được nối vào một file spool trên volume của gateway và gửi lại khi broker trở lại, nên broker ngừng không làm mất Access record. Chỉ những bản ghi đang ở trong bộ nhớ đúng lúc gateway bị kill mới có thể mất; số bản ghi gửi được, phải spool và bị bỏ được đếm trong metrics. Chúng tôi không chặn request khi không ghi được Access record: nhật ký không được làm sập cả API, giống cách rate limiter bỏ qua khi Redis ngừng.

Change record không có vấn đề này vì nằm cùng transaction với dữ liệu.

## Phương án đã loại

- **Chỉ ghi ở gateway**: không biết trường nào đổi, không biết thay đổi do consumer hay job gây ra.
- **Chỉ ghi ở service**: bỏ sót các request đọc và các request bị gateway từ chối.
- **Ghi Access record thẳng vào database từ gateway**: gateway không có database (ADR-0003 cho mỗi service một database), thêm một kết nối database vào đường đi của mọi request làm chậm và làm gateway phụ thuộc thêm một thành phần.
