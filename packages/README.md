# Package dùng chung

- `contracts/` (`@tms/contracts`): kiểu dữ liệu, routing key và bộ kiểm tra (zod) cho mọi event, cùng DTO của các API nội bộ (issue #3).
- `common/`: outbox, messaging RabbitMQ, auth guard, health check và logging (issue #4).

Các service khai báo phụ thuộc dạng `"@tms/contracts": "workspace:*"`. Mọi thay đổi ở đây nên nằm trong một PR riêng để các agent khác rebase theo.

## Dùng `@tms/contracts`

```ts
import { createEvent, parseEvent, queueName, routingKeyOf } from '@tms/contracts';

// Phát: payload được kiểm tra ngay khi tạo; sai contract thì ném ZodError.
const event = createEvent('AttendanceRecorded', data, { correlationId });
// publish lên exchange tms.events với routing key routingKeyOf(event.eventType)

// Nhận: luôn kiểm tra message trước khi xử lý.
const received = parseEvent(JSON.parse(message.content.toString()));
if (received.eventType === 'AttendanceRecorded') {
  received.data.status; // đã có kiểu AttendanceStatus
}

queueName('billing', 'AttendanceRecorded'); // 'billing.attendance-recorded'
```

Bảng event trong `docs/01-nghiep-vu.md` §5 và `EVENT_CATALOG` được một test so khớp với nhau: đổi event thì phải sửa cả hai.
