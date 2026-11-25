# TMS Load Tester

Bản gọn của [`tools/flow-simulator`](../flow-simulator/README.md) để demo trên VPS. App gốc vẫn giữ nguyên để học (có hoạt ảnh và mô phỏng hàng đợi). App này chỉ giữ hai phần:

| Tab                | Làm gì                                                                                                                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Luồng endpoint** | Mô phỏng từng bước một request: resolveRoute → rate limit IP → verify Firebase token → rate limit user → proxy → service → PostgreSQL → outbox → RabbitMQ → consumer, và Access record cho audit-service. Chọn kịch bản lỗi (401, 403, 429, 400, 502, 504, consumer sập). Nút **Gửi thật** gọi gateway, hiện status, thời gian và `x-correlation-id` |
| **Stress test**    | Virtual user (thread) gọi HTTP thật qua gateway. **Không vẽ biểu đồ**: kết quả xem trên Grafana. Mỗi lần chạy được đánh dấu thành một vùng tô màu trên dashboard                                                                                                                                                                                     |

Chỉ dùng thư viện chuẩn của Python 3.10+ (Tkinter).

```bash
python tools/load-tester/tms_load.py
```

## Chạy stress test với bản demo trên VPS

1. **Bật phần quan sát** (một lần cho mỗi buổi demo, xem [docs/06-trien-khai-vps.md](../../docs/06-trien-khai-vps.md) §6.1):
   ```bash
   ssh tms-vps "cd ~/tms && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile monitoring up -d prometheus"
   docker compose -f docker-compose.grafana-vps.yml up -d      # Grafana ở http://localhost:3030
   ```
2. **Mở app**: `python tools/load-tester/tms_load.py`. Giá trị mặc định đã trỏ sẵn vào demo:
   - API gateway: `https://api.timgiasu.date/api`
   - Tài khoản: `gv.minh@tms.demo, gv.lan@tms.demo`, mật khẩu lấy từ biến môi trường `DEMO_PASSWORD` hoặc nhập trong app (xem [DEMO-ACCOUNTS.md](../../DEMO-ACCOUNTS.md)). App tự đăng nhập Firebase, không cần dán token.
   - Firebase API key: đọc từ `NEXT_PUBLIC_FIREBASE_API_KEY` trong `.env` ở gốc repo.
3. Tab **Stress test**: chọn số VU, thời gian, kịch bản, bấm **▶ Chạy stress test**, rồi bấm **📈 Mở Grafana**. Dashboard **TMS – Luồng API** hiện vùng màu cam đúng khoảng thời gian chạy. Các panel nên xem: Request/s theo status code, Latency p95, Top endpoint, RAM và CPU từng service.

Kịch bản **chỉ đọc** (7 GET của giáo viên), nên stress test không làm thay đổi dữ liệu demo. Kịch bản "+10% lỗi 404" giúp panel lỗi 4xx có dữ liệu.

## Giới hạn cần biết

| Giới hạn                                                       | Ảnh hưởng                                                                                                                                                     | Cách xử lý                                                                                                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rate limit của gateway: **600 request/phút/IP**, 300/phút/user | Mọi VU từ một máy chung một IP (gateway thấy IP thật nhờ `TRUST_PROXY`), nên trên khoảng 10 request/giây sẽ nhận **429**. Đây cũng là một tình huống demo hay | Muốn đo sức chịu tải thật: trên VPS đặt `RATE_LIMIT_IP_PER_MINUTE=100000` và `RATE_LIMIT_USER_PER_MINUTE=100000` trong `~/tms/.env`, chạy `dc up -d api-gateway`, **rồi trả lại 600/300 sau khi test** |
| Mỗi request gọi Firebase (`verifyIdToken` có kiểm tra thu hồi) | Khoảng 450 ms mỗi request đến từ VN → VPS → Firebase; throughput bị giới hạn bởi số VU chứ không phải CPU                                                     | Tăng VU, giảm think time                                                                                                                                                                               |
| VPS chỉ có 2 GB RAM                                            | Quá nhiều VU có thể làm service chậm hoặc bị swap. Theo dõi panel RAM/CPU trên Grafana                                                                        | Bắt đầu từ 10 VU, tăng dần                                                                                                                                                                             |
| Cloudflare chặn User-Agent `Python-urllib` (403, error 1010)   | App gửi User-Agent riêng `TMS-LoadTester/1.0` nên không bị chặn. App gốc `flow-simulator` thì vẫn bị chặn khi gọi vào VPS                                     | Dùng app này cho VPS; dùng app gốc với `http://localhost:8080/api`                                                                                                                                     |

Kết quả một lần chạy thử (2026-11-22, 8 VU, 45 giây, think 0,3 s, đọc + 10% 404): 437 request, khoảng 11 request/giây, p50 khoảng 450 ms, p95 khoảng 540 ms, 391 × 200 và 46 × 404, không có 429/5xx.

## So với app gốc

|                                          | `flow-simulator` (học) | `load-tester` (demo)             |
| ---------------------------------------- | ---------------------- | -------------------------------- |
| Luồng endpoint                           | Hoạt ảnh trên canvas   | Dải các bước tô màu + log        |
| Stress test mô phỏng (hàng đợi, pool DB) | Có                     | Bỏ                               |
| Stress test gọi thật                     | Có, dán token tay      | Có, tự đăng nhập nhiều tài khoản |
| Biểu đồ, xuất CSV                        | Trong app              | Grafana (+ annotation)           |
| Gọi VPS qua Cloudflare                   | Bị chặn (User-Agent)   | Được                             |
| Số dòng code                             | khoảng 1.370           | khoảng 610                       |
