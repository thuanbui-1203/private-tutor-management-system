# Thông tin ngân hàng chỉ lưu khi người dùng đồng ý

Trước đây tài khoản nhận tiền cho VietQR chỉ nằm trong biến môi trường `BILLING_BANK_*` và hệ thống không lưu thông tin ngân hàng của ai. Nay giáo viên (tài khoản nhận tiền, dùng cho VietQR) và người thanh toán (tài khoản để giáo viên hoàn tiền) được tự lưu một tài khoản ngân hàng, **chỉ khi họ đồng ý**.

## Quyết định

- **Consent trước, dữ liệu sau.** `PUT /billing/bank-account` chỉ nhận khi body có `consent: true` và phiên bản điều khoản; thiếu thì trả 400 và không lưu gì. Mỗi lần đồng ý là một dòng trong `consents` (mục đích `BANK_ACCOUNT`, phiên bản điều khoản, thời điểm đồng ý, thời điểm rút).
- **Mã hóa.** Số tài khoản lưu bằng AES-256-GCM với khóa `BANK_DATA_KEY` (không nằm trong database). Thiếu khóa thì không lưu được (503), không bao giờ lưu dạng rõ. Database chỉ có thêm 4 số cuối để hiển thị.
- **Ai thấy số đầy đủ.** Chủ tài khoản chỉ thấy bản đã che. Giáo viên (chỉ với người thanh toán của học sinh mình) và Admin thấy số đầy đủ của người thanh toán khi Consent còn hiệu lực, vì mục đích đã nêu là hoàn tiền; không kiểm tra được quan hệ thì không hiện gì (503); mỗi lần xem đều có Access record.
- **Rút lại đồng ý = che dữ liệu.** Số đầy đủ (bản mã hóa) và tên chủ tài khoản bị xóa ngay; chỉ giữ mã ngân hàng (BIN) và 4 số cuối để còn tra cứu lịch sử. Dòng Consent được giữ, có `withdrawn_at`.
- **VietQR** dùng tài khoản của giáo viên khi Consent còn hiệu lực, nếu không thì quay về `BILLING_BANK_*`, nếu cũng không có thì 503 như trước.
- Mọi thao tác ghi Change record (ADR-0005), số tài khoản luôn ở dạng `••••1234`.

## Phương án đã loại

- **Xóa hẳn khi rút đồng ý**: người dùng chọn giữ bản đã che để còn đối chiếu các lần chuyển khoản cũ.
- **Băm số tài khoản**: không dùng lại được để tạo VietQR hay hoàn tiền, mà số tài khoản ngắn nên băm vẫn dò ngược được.
- **Lưu ở identity-service**: tài khoản ngân hàng chỉ phục vụ thu tiền và hoàn tiền, nên thuộc billing-service.
