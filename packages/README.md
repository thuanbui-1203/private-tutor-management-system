# Package dùng chung

- `contracts/` (`@tms/contracts`): kiểu dữ liệu, routing key và bộ kiểm tra (zod) cho mọi event, cùng DTO của các API nội bộ (issue #3).
- `common/` (`@tms/common`): outbox + relay, consumer RabbitMQ idempotent có retry và DLQ, auth guard, health / metrics, logger JSON, HTTP client nội bộ (issue #4).

Các service khai báo phụ thuộc dạng `"@tms/contracts": "workspace:*"`. Mọi thay đổi ở đây nên nằm trong một PR riêng để các agent khác rebase theo.

## Dùng `@tms/common` trong một service

Mọi service đã được nối sẵn `TmsCommonModule` trong `src/app.module.ts` (cùng `PrismaService` riêng của service). Việc của từng service chỉ là dùng nó:

```ts
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CurrentUser, enqueueEvent, Messaging, Roles, type AuthUser } from '@tms/common';

// 1. Phát event: ghi vào outbox TRONG CÙNG transaction với thay đổi nghiệp vụ.
//    Relay tự publish sau khi commit (mỗi giây); rollback thì event không bao giờ đi.
await prisma.$transaction(async (tx) => {
  await tx.class.update({ where: { id }, data: { status: 'CLOSED' } });
  await enqueueEvent(tx, 'ClassClosed', { classId: id }); // payload sai contract → ném lỗi, rollback
});

// 2. Nhận event: handler chạy trong một transaction cùng bản ghi processed_events.
//    Event trùng bị bỏ qua; handler ném lỗi → thử lại sau 5s, 30s, 2 phút, rồi vào <service>.dlq.
@Injectable()
export class BillingConsumers implements OnModuleInit {
  constructor(private readonly messaging: Messaging) {}

  onModuleInit() {
    return this.messaging.subscribe('AttendanceRecorded', async (event, tx) => {
      // dùng `tx` cho mọi thao tác database để chúng commit / rollback cùng nhau
    });
  }
}

// 3. Phân quyền: guard toàn cục đọc X-User-Id / X-User-Role do gateway gắn.
@Roles('TUTOR', 'ADMIN')
@Get('classes')
list(@CurrentUser() user: AuthUser) { /* user.id là users.id (UUID) */ }
// @Public() cho route không cần đăng nhập, kể cả /internal/** gọi giữa các service.

// 4. Gọi đồng bộ sang service khác: timeout 2s, retry 2 lần, circuit breaker.
const students = new InternalHttpClient('http://student-service:3002');
const student = await students.get(`/internal/students/${id}`, InternalStudentResponse);
// CircuitOpenError / ServiceUnavailableError → xử lý dự phòng (ví dụ ghi danh PENDING)
// HttpError (4xx) → câu trả lời thật của service kia, không retry
```

**Change record (ADR-0005):** mọi thay đổi do người dùng gây ra phải ghi một Change record trong CÙNG transaction:

```ts
import { recordChange } from '@tms/common';

await prisma.$transaction(async (tx) => {
  const before = await tx.student.findUniqueOrThrow({ where: { id } });
  const after = await tx.student.update({ where: { id }, data });
  await recordChange(tx, {
    action: 'student.update',
    entityType: 'Student',
    entityId: id,
    before,
    after,
  });
});
// Người thực hiện và correlation id lấy từ request (AuthGuard); ngoài request là SYSTEM.
// Chỉ lưu các trường đã đổi; dữ liệu cá nhân (PERSONAL_FIELDS, thêm bằng `personal: [...]`)
// ghi là '[personal]', bí mật là '[secret]', số tài khoản là '••••1234'.
```

Bảng `audit_log` (DDL tham chiếu: `common/sql/audit.sql`, chỉ được thêm) nằm trong migration `audit` của từng service; `GET /internal/audit` có sẵn để audit-service đọc.

Có sẵn, không cần viết thêm: `GET /health/live`, `GET /health/ready` (database + broker), `GET /metrics`, header `X-Correlation-Id` đi theo request → log → event, và logger JSON (`JsonLogger`).

**Bảng outbox / processed_events:** đã có trong Prisma schema và migration `messaging` của từng service (DDL tham chiếu: `common/sql/messaging.sql`).

**Test:** `pnpm --filter @tms/common test` (không cần hạ tầng); `pnpm --filter @tms/common test:int` (cần `docker compose up -d postgres rabbitmq`).

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

Thông thường service không gọi `createEvent` / `parseEvent` trực tiếp: `enqueueEvent` và `Messaging.subscribe` của `@tms/common` đã làm việc đó.

Bảng event trong `docs/01-nghiep-vu.md` §5 và `EVENT_CATALOG` được một test so khớp với nhau: đổi event thì phải sửa cả hai.
