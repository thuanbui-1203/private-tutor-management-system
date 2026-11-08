# Tài liệu dự án – Tutor Management System (TMS)

Hệ thống quản lý học sinh quy mô nhỏ cho gia sư / giáo viên dạy kèm, xây dựng theo kiến trúc microservice.

## Mục lục

| # | Tài liệu | Nội dung |
|---|---|---|
| 1 | [01-nghiep-vu.md](01-nghiep-vu.md) | Tác nhân, phân quyền, module nghiệp vụ, quy tắc (BR-xx), luồng chính, danh mục event, yêu cầu phi chức năng |
| 2 | [02-cac-service.md](02-cac-service.md) | Danh mục service, port, DB, API endpoint, event phát / nhận, quy ước RabbitMQ, cấu trúc thư mục |
| 3 | [03-cach-chay.md](03-cach-chay.md) | Yêu cầu môi trường, chạy bằng Docker Compose, biến môi trường, chạy riêng một service, kiểm thử, xử lý sự cố |
| 4 | [04-tich-hop-ben-ngoai.md](04-tich-hop-ben-ngoai.md) | Email, thanh toán / VietQR, Zalo, SMS, push, lịch, lưu trữ, PDF, hóa đơn điện tử, AI, giám sát |

## Sơ đồ (PlantUML)

| File | Loại |
|---|---|
| [diagrams/01-usecase.puml](diagrams/01-usecase.puml) | Use-case |
| [diagrams/02-architecture.puml](diagrams/02-architecture.puml) | Kiến trúc tổng thể |
| [diagrams/03-erd.puml](diagrams/03-erd.puml) | ERD (database per service) |
| [diagrams/04-activity-attendance-billing.puml](diagrams/04-activity-attendance-billing.puml) | Activity: điểm danh → học phí |
| [diagrams/05-activity-schedule.puml](diagrams/05-activity-schedule.puml) | Activity: thiết lập lịch |
| [diagrams/06-sequence-login.puml](diagrams/06-sequence-login.puml) | Sequence: đăng nhập / JWT |
| [diagrams/07-sequence-enrollment-saga.puml](diagrams/07-sequence-enrollment-saga.puml) | Sequence: ghi danh (Saga) |
| [diagrams/08-sequence-attendance-billing.puml](diagrams/08-sequence-attendance-billing.puml) | Sequence: Outbox + idempotent consumer |
| [diagrams/09-state-lifecycle.puml](diagrams/09-state-lifecycle.puml) | State: học sinh, ghi danh, buổi học, hóa đơn, runtime service |

Ảnh PNG đã render nằm trong [diagrams/out/](diagrams/out/). Lệnh render lại (chạy trong `docs/diagrams`):

```bash
java -jar ~/.vscode/extensions/jebbs.plantuml-2.18.1/plantuml.jar -charset UTF-8 -tpng -o out *.puml
```

## Tóm tắt kiến trúc

- **7 service:** Identity, Student, Class, Schedule & Attendance, Academic, Billing, Notification; đứng trước là **API Gateway**.
- **Database per service:** PostgreSQL (MongoDB cho Academic).
- **Giao tiếp:** REST cho truy vấn đồng bộ; **RabbitMQ** cho event, có Outbox pattern và idempotent consumer.
- **Triển khai:** Docker Compose; giám sát bằng Prometheus / Grafana / Loki (tùy chọn).
