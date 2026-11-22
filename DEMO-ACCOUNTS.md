# Tài khoản demo

Đăng nhập tại http://localhost:5173. Tạo bằng `pnpm seed` (Admin) và `pnpm seed:demo` (còn lại), xem [scripts/seed-demo.mjs](scripts/seed-demo.mjs).

Mật khẩu chung: `Demo@1234` (riêng Admin: `Admin@123`).

## Admin

| Email | Mật khẩu | Dùng để demo |
|---|---|---|
| admin@tms.local | `Admin@123` | Quản lý người dùng, xem mọi giáo viên |

## Giáo viên (TUTOR)

| Email | Tên | Lớp | Học sinh |
|---|---|---|---|
| gv.minh@tms.demo | Thầy Nguyễn Văn Minh (Toán) | **Toán 9 – Ôn thi vào 10**: nhóm tối đa 6, 1.200.000 ₫/tháng, T2 + T5 18:00–19:30<br>**Toán 7 – Kèm 1-1**: 250.000 ₫/buổi, T3 17:30–19:00 | Minh Khoa, Thu Hà, Gia Bảo, Hoàng Phúc |
| gv.lan@tms.demo | Cô Trần Thị Lan (Tiếng Anh) | **IELTS Foundation**: nhóm tối đa 8, 1.500.000 ₫/tháng, T2 + T4 19:00–20:30<br>**Tiếng Anh 6 – Nhóm nhỏ**: nhóm tối đa 4, 200.000 ₫/buổi, CN 09:00–10:30 | Quỳnh Anh, Đức Huy, Bảo Ngọc |

## Phụ huynh (PARENT)

| Email | Tên | Con | Tình huống demo |
|---|---|---|---|
| ph.hoa@tms.demo | Nguyễn Thị Hoa | Nguyễn Minh Khoa, Nguyễn Thu Hà | Phụ huynh có **2 con**: Khoa học Toán 9 (đã đóng đủ), Hà học Toán 7 (tính theo buổi) |
| ph.nam@tms.demo | Trần Văn Nam | Trần Gia Bảo | Toán 9 **chưa thanh toán** (chờ thanh toán, có VietQR). Quá 7 ngày không trả thì tự rút khỏi lớp |
| ph.tuan@tms.demo | Lê Minh Tuấn | Lê Hoàng Phúc | Toán 9 **đã trả một phần** (600.000 / 1.200.000 ₫) |
| ph.thao@tms.demo | Võ Thị Thảo | Võ Đức Huy | Học 2 lớp: Tiếng Anh 6 (theo buổi) và IELTS (đã đóng đủ) |
| ph.mai@tms.demo | Đặng Thị Mai | Đặng Bảo Ngọc | Tiếng Anh 6 (theo buổi) |

## Học sinh (STUDENT)

| Email | Tên | Tình huống demo |
|---|---|---|
| hs.khoa@tms.demo | Nguyễn Minh Khoa (lớp 9) | Học sinh có phụ huynh: xem lịch học, chuyên cần |
| hs.quynhanh@tms.demo | Phạm Quỳnh Anh (lớp 12) | **Tự thanh toán**, không có phụ huynh: IELTS đã đóng đủ |

Thu Hà, Gia Bảo, Hoàng Phúc, Đức Huy và Bảo Ngọc không có tài khoản riêng; xem các em bằng tài khoản phụ huynh.

## Lưu ý

- Lịch học bắt đầu từ ngày sau khi chạy seed, nên lúc đầu chưa có buổi đã diễn ra hay dữ liệu điểm danh.
- Các tài khoản nằm trên project Firebase mà stack đang dùng (emulator nếu có `FIREBASE_AUTH_EMULATOR_HOST`, nếu không thì project thật).
