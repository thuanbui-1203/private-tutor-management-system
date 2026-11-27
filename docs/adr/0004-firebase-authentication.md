# Đăng nhập qua Firebase Authentication: Google hoặc email đã xác minh

> Cập nhật 2026-11-27: đăng nhập bằng **Google** hoặc **email + mật khẩu**, và cả hai đều phải có **email đã xác minh**. Bản 2026-11-26 chỉ cho Google; trước nữa là email + mật khẩu không cần xác minh.

Firebase Authentication lo toàn bộ phần thông tin đăng nhập. Người dùng chọn một trong hai cách:

- **Google**: Google đã xác minh chủ email.
- **Email + mật khẩu**: Firebase gửi thư xác minh (miễn phí trên gói Spark). Chỉ sau khi mở liên kết trong thư thì token mới có `email_verified = true`. Trước lúc đó trang đăng nhập giữ người dùng ở bước "kiểm tra hộp thư" và không gọi API. Quên mật khẩu thì Firebase gửi thư đặt lại; giao diện không cho biết email có tồn tại hay không.

Frontend đăng nhập bằng Firebase client SDK rồi gửi Firebase ID token tới API Gateway. Gateway xác thực token bằng Admin SDK (có kiểm tra token đã bị thu hồi), **chỉ nhận token có `sign_in_provider` là `google.com` hoặc `password` và `email_verified = true`** (`signInAllowed` trong `@tms/common`; Identity kiểm tra lại y như vậy), rồi chuyển xuống các header `X-User-Id`, `X-User-Role` như trước. Token ẩn danh, số điện thoại hay email chưa xác minh đều bị từ chối. `AUTH_SIGN_IN_PROVIDERS` thu hẹp danh sách, ví dụ `google.com` để chỉ cho Google.

**Vì sao bắt buộc xác minh email:** Identity tìm người dùng cũ và Admin (`ADMIN_EMAILS`) theo địa chỉ email. Nếu nhận email chưa xác minh, ai cũng có thể đăng ký bằng địa chỉ của người khác, kể cả của Admin, rồi chiếm tài khoản đó.

Identity Service vẫn giữ những gì thuộc nghiệp vụ của hệ thống: **danh tính** và **vai trò** duy nhất của mỗi người dùng, lưu thành hai custom claim trên tài khoản Firebase: `userId` (là `users.id`, UUID) và `role`. Gateway chuyển `userId` thành `X-User-Id`, nên mọi service và event chỉ dùng UUID của hệ thống; `uid` của Firebase chỉ nằm trong Identity.

- **Lần đăng nhập đầu** (`POST /auth/register`): người dùng chọn TUTOR, STUDENT hoặc PARENT. ADMIN không chọn được; chỉ email trong `ADMIN_EMAILS` (hoặc đã được `pnpm seed` tạo) mới là Admin.
- **Email đã có trong hệ thống**: chủ email đã được xác minh, nên tài khoản Firebase mới được nối lại với người dùng cũ và giữ nguyên vai trò. Người bị vô hiệu hóa thì bị từ chối.
- **Lời mời** (token riêng của hệ thống, dùng 1 lần, hiệu lực 7 ngày, thu hồi được, BR-AU-02): chỉ người đăng nhập bằng **đúng email được mời** (Google, hoặc mật khẩu đặt cho email đó sau khi đã xác minh) mới nhận được. Link bị chuyển cho người khác thì vô dụng.
- **Tự đăng ký không tự liên kết**: `UserRegistered` có `selfRegistered`, nên student-service không gắn người đó vào hồ sơ do người khác nhập cùng email. Chỉ nhận lời mời mới tính là đồng ý liên kết. Nếu không có quy tắc này, giáo viên nào cũng gắn được người khác vào học sinh của mình chỉ bằng cách gõ email của họ.
- **Vô hiệu hóa** giáo viên sẽ vô hiệu hóa tài khoản Firebase và thu hồi refresh token.

Chúng tôi không tự băm mật khẩu và tự ký JWT RS256: đó là mã nguồn nhạy cảm về bảo mật, và Firebase đã làm việc này tốt hơn. Mật khẩu chỉ nằm ở Firebase.

## Hệ quả

- ID token sống 1 giờ và được Firebase SDK tự làm mới.
- Identity không có `password_hash`, bảng `refresh_tokens` hay endpoint JWKS. `users.firebase_uid` được phép trống cho đến lần đăng nhập đầu của người được mời hoặc được seed.
- Đổi vai trò chỉ có hiệu lực khi ID token được làm mới (tối đa 1 giờ), trừ khi Identity thu hồi token. Identity luôn thu hồi token mỗi khi đổi vai trò hoặc vô hiệu hóa.
- Khi phát triển và test dùng Firebase Auth Emulator (`pnpm emulators`), không dùng project thật. Emulator không có Google thật, nên nút Google cho nhập email muốn đóng vai ("Email Google (giả lập)"); Firebase thật từ chối loại token này. Thư xác minh và thư đặt lại mật khẩu không được gửi đi mà nằm trong emulator (`/emulator/v1/projects/demo-tms/oobCodes`).
- Tài khoản mật khẩu cũ có cờ đã xác minh được tạo sẵn (các tài khoản demo `*@tms.demo`, `admin@tms.local`) đăng nhập lại được. Phải vô hiệu hóa chúng hoặc đổi mật khẩu (`scripts/rotate-demo-passwords.mjs`) trước khi bật cách này trên project thật.
- Công cụ còn đăng nhập bằng mật khẩu (`tools/load-tester`, `tools/demo-recorder`) phải dùng tài khoản đã xác minh.
