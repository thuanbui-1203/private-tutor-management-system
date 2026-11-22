# TMS Flow & Stress Simulator

App Tkinter (chỉ dùng thư viện chuẩn của Python 3.10+) để minh hoạ luồng request của hệ thống và stress test.

```bash
python tools/flow-simulator/tms_simulator.py
```

## Tab "Luồng endpoint"

- Chọn endpoint (nhóm theo service, lấy từ `backend/*/src/**/*.controller.ts` và route table
  `backend/api-gateway/src/gateway/routes.ts`), chọn kịch bản, bấm **Chạy mô phỏng**.
- Hoạt ảnh đi qua 5 bước của gateway (`gateway.service.ts`): resolveRoute → rate limit IP (Redis)
  → verify Firebase ID token → rate limit user → proxy, rồi service → PostgreSQL → outbox
  → RabbitMQ → các consumer (kể cả saga `StudentEnrolled` → `EnrollmentConfirmed`).
- Kịch bản lỗi: 401, 403, 429 (IP/user), 400 (zod), 400 vì thiếu đồng ý lưu tài khoản ngân hàng,
  502 (service sập), 504 (timeout 30s), consumer sập (event nằm chờ trong queue), RabbitMQ sập
  (Access record vào file spool của gateway).
- Nhật ký (ADR-0005): mọi request, kể cả bị từ chối, kết thúc bằng một Access record gửi lên
  `tms.audit` cho audit-service; mọi thao tác ghi có thêm `INSERT INTO audit_log` (Change record)
  trong cùng transaction.
- **Gửi thật**: gọi gateway thật (mặc định `http://localhost:8080/api`, dán Firebase ID token nếu cần),
  hiển thị status, thời gian, `x-correlation-id` và body.

## Tab "Stress test"

- **Mô phỏng** (không cần backend): discrete-event simulation gồm gateway (1 event loop Node,
  `Gateway CPU ms/req`), rate limit Redis theo cửa sổ 1 phút (600/IP, 300/user), mỗi service có
  pool kết nối DB (`Pool`) và thời gian xử lý đọc/ghi (log-normal), timeout 30s của gateway,
  consumer RabbitMQ (prefetch 10), và audit-service nhận một Access record cho mỗi request
  (prefetch 50): tick **Sập** cho audit để thấy backlog nhật ký tăng mà API vẫn chạy. Tick **Sập** khi đang chạy để thấy 502 và backlog tăng rồi xả.
- **Gọi thật**: mỗi virtual user là một thread gọi HTTP thật qua gateway; nhiều token cách nhau bởi dấu phẩy.
  Endpoint ghi gửi body `{}` (sẽ nhận 400), nên kịch bản "Chỉ đọc" phù hợp nhất. Mọi request từ máy này
  chung 1 IP, nên quá 600 req/phút sẽ nhận 429.
- Biểu đồ: throughput, p50/p95/p99, tỉ lệ lỗi, VU/in-flight/RabbitMQ backlog; bảng theo endpoint; xuất CSV.

Mẹo demo: đặt "Số IP nguồn" = 1 để thấy rate limit theo IP chặn gần hết tải; tăng VU/giảm think time
để thấy service bão hoà pool DB, độ trễ tăng vọt rồi 504.
