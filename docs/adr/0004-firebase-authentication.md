# Đăng nhập bằng Google qua Firebase Authentication

> Cập nhật 2026-11-26: chỉ còn đăng nhập **Google** cho cả 4 vai trò; trước đó là email và mật khẩu.

Firebase Authentication lo toàn bộ phần thông tin đăng nhập; mọi người đăng nhập bằng **Google**. Frontend đăng nhập bằng Firebase client SDK rồi gửi Firebase ID token tới API Gateway; gateway xác thực token bằng Admin SDK (có kiểm tra token đã bị thu hồi), **chỉ nhận token có `sign_in_provider = google.com` và email đã xác minh**, rồi chuyển xuống các header `X-User-Id`, `X-User-Role` như trước. Project dùng gói miễn phí Spark.

Identity Service vẫn giữ những gì thuộc nghiệp vụ của hệ thống: **danh tính** và **vai trò** duy nhất của mỗi người dùng, lưu thành hai custom claim trên tài khoản Firebase: `userId` (là `users.id`, UUID) và `role`. Gateway chuyển `userId` thành `X-User-Id`, nên mọi service và event chỉ dùng UUID của hệ thống; `uid` của Firebase chỉ nằm trong Identity.

- **Lần đăng nhập đầu** (`POST /auth/register`): người dùng chọn TUTOR, STUDENT hoặc PARENT. ADMIN không chọn được; chỉ email trong `ADMIN_EMAILS` (hoặc đã được `pnpm seed` tạo) mới là Admin.
- **Email đã có trong hệ thống**: Google đã xác minh chủ email, nên tài khoản Firebase mới được nối lại với người dùng cũ, giữ nguyên vai trò. Người bị vô hiệu hóa thì bị từ chối.
- **Lời mời** (token riêng của hệ thống, dùng 1 lần, hiệu lực 7 ngày, thu hồi được, BR-AU-02): chỉ người đăng nhập Google bằng **đúng email được mời** mới nhận được. Link bị chuyển cho người khác thì vô dụng.
- **Tự đăng ký không tự liên kết**: `UserRegistered` có `selfRegistered`, student-service không gắn người đó vào hồ sơ do người khác nhập cùng email. Chỉ nhận lời mời mới là đồng ý liên kết; nếu không, bất kỳ giáo viên nào cũng gắn được người khác vào học sinh của mình bằng cách gõ email của họ.
- **Vô hiệu hóa** giáo viên sẽ vô hiệu hóa tài khoản Firebase và thu hồi refresh token.

Chúng tôi không chọn tự băm mật khẩu và tự ký JWT RS256: đó là mã nguồn nhạy cảm về bảo mật mà Firebase đã làm tốt hơn.

## Hệ quả

- ID token sống 1 giờ và Firebase SDK tự làm mới. Không còn màn hình mật khẩu, quên mật khẩu.
- Identity không còn `password_hash`, bảng `refresh_tokens` hay endpoint JWKS. `users.firebase_uid` được phép trống cho đến lần đăng nhập đầu của người được mời hoặc được seed.
- Đổi vai trò chỉ có hiệu lực khi ID token được làm mới (tối đa 1 giờ), trừ khi Identity thu hồi token; Identity luôn thu hồi token mỗi khi đổi vai trò hoặc vô hiệu hóa.
- Khi phát triển và test dùng Firebase Auth Emulator (`pnpm emulators`), không dùng project thật. Emulator không có Google thật, nên trang đăng nhập cho nhập email muốn đóng vai; Firebase thật từ chối loại token này.
- Tài khoản email + mật khẩu cũ không vào được nữa. Cần chuyển dần thì đặt `AUTH_SIGN_IN_PROVIDERS=google.com,password`.
- Công cụ còn đăng nhập bằng mật khẩu (`tools/load-tester`, `tools/demo-recorder`) chưa chuyển sang cách này.
