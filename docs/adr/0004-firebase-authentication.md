# Đăng nhập bằng Firebase Authentication

Firebase Authentication (email và mật khẩu) lo toàn bộ phần thông tin đăng nhập: lưu mật khẩu, đăng nhập, làm mới token, quên mật khẩu và chặn dò mật khẩu. Frontend đăng nhập bằng Firebase client SDK rồi gửi Firebase ID token tới API Gateway; gateway xác thực token bằng Admin SDK (có kiểm tra token đã bị thu hồi) và chuyển xuống các header `X-User-Id`, `X-User-Role` như trước. Project dùng gói miễn phí Spark.

Identity Service vẫn giữ những gì thuộc nghiệp vụ của hệ thống: **danh tính** và **vai trò** duy nhất của mỗi người dùng, lưu thành hai custom claim trên tài khoản Firebase: `userId` (là `users.id`, UUID) và `role`. Gateway chuyển `userId` thành `X-User-Id`, nên mọi service và event chỉ dùng UUID của hệ thống; `uid` của Firebase chỉ nằm trong Identity; **lời mời** (token riêng của hệ thống, dùng 1 lần, hiệu lực 7 ngày, thu hồi được, BR-AU-02; khi nhận lời mời, mật khẩu được đặt qua Admin SDK); và việc quản lý giáo viên, trong đó vô hiệu hóa giáo viên sẽ vô hiệu hóa tài khoản Firebase và thu hồi refresh token của họ.

Chúng tôi không chọn tự băm mật khẩu và tự ký JWT RS256: đó là mã nguồn nhạy cảm về bảo mật mà Firebase đã làm tốt hơn, và sẽ chiếm thời gian lẽ ra dành cho các service nghiệp vụ.

## Hệ quả

- Quy tắc token trong `docs/01-nghiep-vu.md` §3.1 thay đổi: ID token sống 1 giờ và Firebase SDK tự làm mới (không còn cơ chế 15 phút / 7 ngày xoay vòng của riêng hệ thống); quy tắc "sai 5 lần thì khóa 15 phút" được thay bằng cơ chế chống lạm dụng có sẵn của Firebase.
- Identity không còn `password_hash`, bảng `refresh_tokens` hay endpoint JWKS.
- Đổi vai trò chỉ có hiệu lực khi ID token của người dùng được làm mới (tối đa 1 giờ), trừ khi Identity thu hồi token; Identity luôn thu hồi token mỗi khi đổi vai trò hoặc vô hiệu hóa.
- Khi phát triển và test dùng Firebase Auth Emulator, không dùng project thật.
