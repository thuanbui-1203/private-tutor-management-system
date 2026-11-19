# Tài liệu dự án – Tutor Management System (TMS)

Hệ thống quản lý học sinh quy mô nhỏ cho gia sư / giáo viên dạy kèm, xây dựng theo kiến trúc microservice. Thuật ngữ chuẩn nằm ở [GLOSSARY.md](../GLOSSARY.md).

## Mục lục

| # | Tài liệu | Nội dung |
|---|---|---|
| 1 | [01-nghiep-vu.md](01-nghiep-vu.md) | Tác nhân, phân quyền, module nghiệp vụ, quy tắc (BR-xx), luồng chính, danh mục event, yêu cầu phi chức năng |
| 2 | [02-cac-service.md](02-cac-service.md) | Danh mục service, port, DB, API endpoint, event phát / nhận, quy ước RabbitMQ, cấu trúc thư mục |
| 3 | [03-cach-chay.md](03-cach-chay.md) | Yêu cầu môi trường, chạy bằng Docker Compose, biến môi trường, chạy riêng một service, kiểm thử, xử lý sự cố |
| 4 | [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md) | Email, thanh toán / VietQR, Zalo, SMS, push, lịch, lưu trữ, PDF, hóa đơn điện tử, AI, giám sát |
| 5 | [05-phan-cong-doc-tai-lieu.md](05-phan-cong-doc-tai-lieu.md) | Chia tài liệu cho 3 người đọc theo nhóm service: phần chung, phần riêng, câu hỏi tự kiểm tra, các luồng giao nhau |

## Quyết định kiến trúc (ADR)

| ADR | Quyết định |
|---|---|
| [0001](adr/0001-single-tenant-deployment.md) | Mỗi bản triển khai phục vụ một trung tâm (single-tenant) |
| [0002](adr/0002-immutable-invoices-with-adjustments.md) | Hóa đơn đã phát hành là bất biến; sửa sai bằng dòng điều chỉnh |
| [0003](adr/0003-postgresql-database-per-service.md) | PostgreSQL 18 trong Docker, mỗi service một database + login role |
| [0004](adr/0004-firebase-authentication.md) | Đăng nhập bằng Firebase Authentication; Identity giữ vai trò, lời mời |

## Sơ đồ (PlantUML)

| File | Loại |
|---|---|
| [diagrams/01-usecase.puml](diagrams/01-usecase.puml) | Use-case |
| [diagrams/02-architecture.puml](diagrams/02-architecture.puml) | Kiến trúc tổng thể |
| [diagrams/03-erd.puml](diagrams/03-erd.puml) | ERD (database per service) |
| [diagrams/04-activity-attendance-billing.puml](diagrams/04-activity-attendance-billing.puml) | Activity: điểm danh → học phí |
| [diagrams/05-activity-schedule.puml](diagrams/05-activity-schedule.puml) | Activity: thiết lập lịch |
| [diagrams/06-sequence-login.puml](diagrams/06-sequence-login.puml) | Sequence: đăng nhập qua Firebase Auth, gọi API có xác thực |
| [diagrams/07-sequence-enrollment-saga.puml](diagrams/07-sequence-enrollment-saga.puml) | Sequence: ghi danh (Saga) |
| [diagrams/08-sequence-attendance-billing.puml](diagrams/08-sequence-attendance-billing.puml) | Sequence: Outbox + idempotent consumer |
| [diagrams/09-state-lifecycle.puml](diagrams/09-state-lifecycle.puml) | State: học sinh, ghi danh, buổi học, hóa đơn, runtime service |

Ảnh PNG đã render nằm trong [diagrams/out/](diagrams/out/). Lệnh render lại (chạy trong `docs/diagrams`):

```bash
java -jar ~/.vscode/extensions/jebbs.plantuml-2.18.1/plantuml.jar -charset UTF-8 -tpng -o out *.puml
```

## Tóm tắt kiến trúc

- **Phạm vi MVP (BR-SYS-03):** API Gateway + 5 service: Identity, Student, Class, Schedule & Attendance, Billing. Academic và Notification đã được mô tả nhưng chỉ làm nếu còn thời gian.
- **Mã nguồn:** pnpm monorepo. `backend/` chứa các service NestJS 11, `frontend/` là ứng dụng Next.js 16 (cổng 5173, chỉ gọi API Gateway), `packages/` chứa contract và mã dùng chung. Phiên bản thư viện dùng chung được khóa trong `pnpm-workspace.yaml` (catalog).
- **Database per service:** PostgreSQL 18 trong Docker, mỗi service một database + login role, truy cập qua Prisma 7 ([ADR-0003](adr/0003-postgresql-database-per-service.md)).
- **Đăng nhập:** Firebase Authentication (gói miễn phí Spark); gateway xác thực Firebase ID token ([ADR-0004](adr/0004-firebase-authentication.md)).
- **Giao tiếp:** REST cho truy vấn đồng bộ; **RabbitMQ** cho event, có Outbox pattern và idempotent consumer.
- **Triển khai:** Docker Compose; giám sát bằng Prometheus / Grafana / Loki (tùy chọn).

## Lệnh thường dùng (thư mục gốc)

```bash
pnpm install          # cài toàn bộ workspace
pnpm build            # build mọi service và frontend
pnpm test             # chạy test mọi package
pnpm lint             # ESLint backend + frontend
pnpm format:check     # kiểm tra Prettier
pnpm migrate:all      # chạy migration Prisma của mọi service
```

## Kế hoạch triển khai

Công việc được chia thành GitHub issue #1–#21 và #23 (issue #1 là bản đồ tổng). Phần nền tảng (#2–#5) làm trước, sau đó 4 agent làm song song, mỗi agent trong một git worktree riêng, theo nhãn:

| Agent | Nhãn | Phạm vi | Issue |
|---|---|---|---|
| A | `agent-a` | Gateway, Identity, Student | #6–#10 |
| B | `agent-b` | Class, Schedule & Attendance | #11–#15 |
| C | `agent-c` | Billing | #16–#20 |
| D | `agent-d` | Frontend (`frontend/`) | #23 |

Agent D chỉ cần #2 và #3 là bắt đầu được, vì test frontend stub các lời gọi `/api/*`. Test end-to-end với hệ thống thật nằm ở #21.
