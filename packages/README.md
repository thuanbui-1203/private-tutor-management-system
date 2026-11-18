# Package dùng chung

- `contracts/`: kiểu dữ liệu event và DTO dùng chung cho mọi service (issue #3).
- `common/`: outbox, messaging RabbitMQ, auth guard, health check và logging (issue #4).

Các service khai báo phụ thuộc dạng `workspace:*`. Mọi thay đổi ở đây nên nằm trong một PR riêng để các agent khác rebase theo.
