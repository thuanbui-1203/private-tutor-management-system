# @tms/frontend

Ứng dụng web Next.js (App Router) của Tutor Management System. Frontend chỉ gọi API Gateway, không gọi thẳng service nào ở backend. Đăng nhập dùng Firebase client SDK ([ADR-0004](../docs/adr/0004-firebase-authentication.md)).

```bash
pnpm --filter @tms/frontend dev     # http://localhost:5173
pnpm --filter @tms/frontend build
```

Cấu hình đặt trong `frontend/.env.local` (không commit): `NEXT_PUBLIC_API_URL` (ví dụ `http://localhost:8080/api`) và các giá trị `NEXT_PUBLIC_FIREBASE_*` lấy từ cấu hình Web app trong Firebase console.

Docker: chạy `docker build -f frontend/Dockerfile .` từ thư mục gốc repo. Các giá trị `NEXT_PUBLIC_*` được nhúng lúc build nên phải truyền bằng `--build-arg` (xem `docs/03-cach-chay.md` §4).

## Kiểm thử giao diện

```bash
pnpm emulators                                   # terminal khác: Firebase Auth Emulator 127.0.0.1:9099
pnpm --filter @tms/frontend exec playwright install chromium   # lần đầu
pnpm --filter @tms/frontend test:e2e
```

Playwright tự chạy `next dev` ở cổng 5174 với cấu hình giả (`demo-tms`, API `http://api.tms.test/api`), nên test không bao giờ dùng project Firebase thật hay backend thật. Mỗi test stub các lời gọi `/api/*` bằng `stubApi` trong `e2e/support.ts`; lời gọi không có stub trả 501 để lộ ra ngay.

Cấu trúc mã:

- `src/lib/auth.tsx`: module xác thực (Firebase client SDK, vai trò từ custom claim).
- `src/lib/api.ts`: mọi lời gọi gateway, gắn `Authorization: Bearer`, 401 → đăng xuất.
- `src/components/session.tsx`: chặn route theo vai trò (`RoleGate`), khung trang (`AppShell`).
- `src/components/ui.tsx`: các component dùng chung (tải / trống / lỗi, tiền, ngày, form).
