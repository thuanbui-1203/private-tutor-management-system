# @tms/frontend

Ứng dụng web Next.js (App Router) của Tutor Management System. Frontend chỉ gọi API Gateway, không gọi thẳng service nào ở backend. Đăng nhập dùng Firebase client SDK ([ADR-0004](../docs/adr/0004-firebase-authentication.md)).

```bash
pnpm --filter @tms/frontend dev     # http://localhost:5173
pnpm --filter @tms/frontend build
```

Cấu hình đặt trong `frontend/.env.local` (không commit): `NEXT_PUBLIC_API_URL` (ví dụ `http://localhost:8080/api`) và các giá trị `NEXT_PUBLIC_FIREBASE_*` lấy từ cấu hình Web app trong Firebase console.

Docker: chạy `docker build -f frontend/Dockerfile .` từ thư mục gốc repo. Các giá trị `NEXT_PUBLIC_*` được nhúng lúc build nên phải truyền bằng `--build-arg` (xem `docs/03-cach-chay.md` §4).
