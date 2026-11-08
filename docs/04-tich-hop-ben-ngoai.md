# 04. Dịch vụ bên ngoài có thể tích hợp

> Mọi tích hợp đều **tùy chọn**. Hệ thống phải chạy đầy đủ nghiệp vụ lõi khi không cấu hình tích hợp nào: email gửi qua Mailpit, thanh toán ghi nhận thủ công.
> Giá và chính sách của các nhà cung cấp thay đổi thường xuyên, cần kiểm tra lại trên trang chính thức trước khi dùng thật.

## 1. Nguyên tắc tích hợp

1. **Adapter / Port:** mỗi loại tích hợp có một interface trong service sở hữu (ví dụ `PaymentGateway`, `NotificationChannel`, `FileStorage`). Mỗi nhà cung cấp là một adapter riêng, chọn qua biến môi trường. Đổi nhà cung cấp không phải sửa nghiệp vụ.
2. **Chỉ service sở hữu được gọi ra ngoài:** Billing gọi cổng thanh toán, Notification gọi email / SMS / Zalo. Các service khác không gọi trực tiếp.
3. **Webhook vào qua Gateway:** đường dẫn `/api/webhooks/{provider}`, **bắt buộc kiểm tra chữ ký**, xử lý idempotent theo mã giao dịch của nhà cung cấp, trả 200 nhanh rồi mới xử lý bất đồng bộ.
4. **Chịu lỗi:** đặt timeout, retry có backoff, circuit breaker. Lỗi từ bên ngoài **không được** làm hỏng giao dịch nghiệp vụ, mà được đưa vào hàng đợi để thử lại.
5. **Bí mật:** API key đặt trong biến môi trường / secret manager, không commit, không ghi log.
6. **Dữ liệu cá nhân:** chỉ gửi ra ngoài lượng dữ liệu tối thiểu cần thiết (ví dụ không gửi ngày sinh học sinh cho nhà cung cấp SMS).

## 2. Bảng tổng hợp

| Nhóm | Mục đích | Lựa chọn gợi ý | Service tích hợp | Ưu tiên |
|---|---|---|---|:-:|
| Email | Hóa đơn, nhắc lịch, mời tài khoản, báo cáo | SMTP (Gmail / Zoho), SendGrid, Amazon SES, Resend, Brevo | Notification | Cao |
| Thanh toán / QR | Mã QR chuyển khoản, tự đối soát | VietQR (tạo QR), PayOS, SePay / Casso (webhook biến động số dư), MoMo, VNPay | Billing | Cao |
| Zalo | Kênh liên lạc phổ biến nhất với phụ huynh VN | Zalo OA + ZNS (Zalo Notification Service) | Notification | Cao |
| SMS | Báo vắng, nhắc phí khẩn | eSMS, SpeedSMS, Stringee, Twilio | Notification | Trung bình |
| Push notification | Thông báo trên app / web | Firebase Cloud Messaging (FCM), Web Push | Notification | Trung bình |
| Lịch | Đồng bộ lịch học sang lịch cá nhân | iCal feed (`.ics`), Google Calendar API, Microsoft Graph | Schedule | Trung bình |
| Học online | Tạo link phòng học cho buổi online | Google Meet (qua Calendar API), Zoom API, Jitsi | Schedule | Thấp |
| Đăng nhập | Đăng nhập nhanh | Google OAuth 2.0 / OpenID Connect, Zalo Login | Identity | Thấp |
| Lưu trữ file | Bài tập, file đính kèm, PDF báo cáo | MinIO (tự host, tương thích S3), Amazon S3, Cloudflare R2, Cloudinary | Academic, Billing | Trung bình |
| Tạo PDF | Hóa đơn, báo cáo tiến độ | Gotenberg (container), Puppeteer, PDFKit | Billing, Academic | Trung bình |
| Hóa đơn điện tử | Xuất HĐĐT theo quy định (nếu là trung tâm) | VNPT Invoice, Viettel S-Invoice, MISA meInvoice | Billing | Thấp |
| AI | Gợi ý nhận xét, tóm tắt báo cáo tháng | Claude API (Anthropic) | Academic | Thấp |
| Giám sát lỗi | Theo dõi exception | Sentry, Grafana Cloud, Better Stack | Tất cả | Trung bình |
| Bảo vệ form | Chống spam đăng ký | Cloudflare Turnstile, Google reCAPTCHA | Identity | Thấp |

## 3. Chi tiết từng nhóm

### 3.1. Email – Notification Service

- **Dev:** Mailpit (đã có trong docker compose), không gửi email ra ngoài.
- **Quy mô nhỏ:** SMTP của Gmail / Google Workspace (dùng App Password), giới hạn khoảng vài trăm email mỗi ngày.
- **Gửi giao dịch nghiêm túc:** SendGrid, Amazon SES, Resend, Brevo. Cần xác thực domain (SPF, DKIM, DMARC) để không bị vào spam.
- **Thiết kế:** adapter `EmailChannel` (`SmtpEmailChannel`, `SendgridEmailChannel`); template Handlebars / MJML lưu trong bảng `templates`; xử lý webhook *bounce* / *complaint* để tự tắt gửi cho địa chỉ lỗi.

```dotenv
EMAIL_PROVIDER=smtp           # smtp | sendgrid | ses
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...                 # App Password
```

### 3.2. Thanh toán và đối soát – Billing Service

Gia sư thường nhận học phí qua **chuyển khoản**. Có ba mức tích hợp:

| Mức | Cách làm | Tự động hóa |
|---|---|---|
| 1. QR tĩnh | Tạo ảnh QR theo chuẩn **VietQR** (số tài khoản, số tiền, nội dung `TMS INV-2026-11-0012`) gắn vào email hóa đơn | Giáo viên vẫn ghi nhận thanh toán thủ công |
| 2. Webhook biến động số dư | Dịch vụ như **SePay** hoặc **Casso** theo dõi tài khoản ngân hàng và gọi webhook khi có tiền vào | Billing đọc nội dung chuyển khoản, khớp mã hóa đơn, tự ghi `PaymentReceived` |
| 3. Cổng thanh toán | **PayOS**, **MoMo**, **VNPay**: tạo link / QR thanh toán, nhận IPN / webhook | Tự động hoàn toàn, có trạng thái giao dịch |

**Luồng webhook (mức 2 / 3):**

```
Ngân hàng / Cổng TT ──webhook──▶ API Gateway /api/webhooks/payments/{provider}
                                  └─▶ Billing: kiểm tra chữ ký (HMAC / checksum)
                                        ├─ đã xử lý mã giao dịch này? → trả 200, bỏ qua
                                        ├─ tách mã hóa đơn từ nội dung chuyển khoản
                                        ├─ không khớp hóa đơn → lưu "unmatched_payments", báo giáo viên
                                        └─ khớp → INSERT payment, cập nhật trạng thái, outbox PaymentReceived
```

**Lưu ý:** số tiền chuyển có thể khác tổng hóa đơn. Thiếu thì chuyển `PARTIALLY_PAID`; thừa thì ghi số dư dư để trừ vào kỳ sau.

### 3.3. Zalo OA / ZNS – Notification Service

- Phụ huynh ở Việt Nam đọc Zalo nhiều hơn email, nên đây là kênh nhắc lịch và nhắc phí hiệu quả nhất.
- **ZNS** cho phép gửi tin theo mẫu đã được duyệt tới số điện thoại (tính phí theo tin); cần Zalo OA đã xác thực và đăng ký mẫu tin trước.
- Mẫu tin gợi ý: *Nhắc lịch học*, *Thông báo vắng*, *Hóa đơn học phí*, *Xác nhận thanh toán*.
- Adapter `ZaloZnsChannel`; tự làm mới access token (token có hạn ngắn, cần lưu refresh token an toàn).
- Fallback: ZNS lỗi thì gửi SMS, SMS lỗi thì gửi email.

### 3.4. SMS – Notification Service

- Dùng cho tin khẩn (báo vắng) khi phụ huynh không dùng Zalo.
- Nhà cung cấp trong nước (eSMS, SpeedSMS, Stringee) hỗ trợ **brandname**, cần đăng ký tên thương hiệu với nhà mạng. Twilio phù hợp khi gửi quốc tế.
- Giới hạn tần suất: tối đa N tin mỗi phụ huynh mỗi ngày để tránh spam và tốn chi phí.

### 3.5. Push notification

- **FCM** cho mobile app (React Native / Flutter) và web; **Web Push (VAPID)** nếu chỉ có web.
- Notification lưu push token của thiết bị (`POST /notifications/devices`) và xóa token khi FCM báo token không còn hợp lệ.

### 3.6. Lịch – Schedule Service

| Cách | Mức độ | Mô tả |
|---|---|---|
| **iCal feed** | Dễ, nên làm trước | `GET /calendar/{token}.ics`; người dùng thêm URL này vào Google / Apple / Outlook Calendar, lịch tự cập nhật định kỳ. Không cần OAuth |
| Google Calendar API | Trung bình | Giáo viên liên kết tài khoản Google bằng OAuth; mỗi `SessionScheduled` / `SessionCancelled` tạo / xóa event; có thể tự tạo link Google Meet |
| Microsoft Graph | Trung bình | Tương tự, cho người dùng Outlook / Microsoft 365 |

### 3.7. Học online

- **Google Meet:** tạo qua Calendar API (`conferenceData`) khi tạo event.
- **Zoom:** Server-to-Server OAuth app; tạo meeting khi buổi học có `mode = ONLINE`, lưu `join_url` vào session.
- **Jitsi:** không cần API key, chỉ cần sinh tên phòng ngẫu nhiên; phù hợp cho demo.

### 3.8. Đăng nhập bên thứ ba – Identity Service

- **Google OIDC:** flow Authorization Code + PKCE. Identity đổi `id_token` lấy JWT nội bộ của hệ thống. Liên kết theo email đã xác minh.
- Vẫn dùng JWT nội bộ cho mọi service; token của Google không đi sâu vào hệ thống.

### 3.9. Lưu trữ file – Academic / Billing

- **MinIO** chạy trong docker compose cho dev; dùng chung SDK S3 nên chuyển sang S3 / R2 chỉ cần đổi biến môi trường.
- Upload trực tiếp từ trình duyệt bằng **presigned URL** để file không đi qua service.
- Kiểm tra loại file và kích thước (≤ 10 MB); quét virus (ClamAV) nếu cho phụ huynh / học sinh tải lên.

### 3.10. Tạo PDF

- **Gotenberg** (container, chuyển HTML sang PDF) là gọn nhất trong kiến trúc microservice: Billing và Academic render HTML từ template rồi gọi Gotenberg.
- File PDF lưu vào storage (3.9), email chỉ đính kèm hoặc gửi link có thời hạn.

### 3.11. Hóa đơn điện tử

- Chỉ cần khi giáo viên / trung tâm là hộ kinh doanh hoặc doanh nghiệp có nghĩa vụ xuất hóa đơn điện tử.
- Các nhà cung cấp (VNPT, Viettel, MISA...) đều có API phát hành. Billing gọi sau khi hóa đơn `PAID` hoặc theo yêu cầu, rồi lưu số hóa đơn điện tử trả về.

### 3.12. AI hỗ trợ nhận xét – Academic Service

- Dùng **Claude API** để:
  - Từ điểm số, chuyên cần và các ghi chú ngắn của giáo viên, soạn **nháp** nhận xét hoặc báo cáo tháng gửi phụ huynh.
  - Tóm tắt điểm mạnh / điểm yếu của học sinh sau nhiều buổi.
- Nguyên tắc: AI chỉ soạn nháp, **giáo viên duyệt trước khi gửi**; không gửi họ tên đầy đủ hay thông tin liên hệ của học sinh lên API (dùng mã ẩn danh).
- Gợi ý mô hình: `claude-haiku-5-5` cho tác vụ ngắn, chi phí thấp; `claude-sonnet-5-5` nếu cần chất lượng cao hơn.

```dotenv
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
AI_MODEL=claude-haiku-5-5
```

### 3.13. Giám sát và vận hành

- **Sentry:** bắt exception ở frontend và từng service, gắn `correlationId`.
- **Grafana Cloud / Better Stack:** nhận log và metrics nếu không muốn tự chạy Loki / Prometheus.
- **Uptime check:** ping `/health/ready` của Gateway mỗi phút.

## 4. Lộ trình tích hợp đề xuất

| Giai đoạn | Tích hợp | Lý do |
|---|---|---|
| MVP | Mailpit / SMTP, VietQR tĩnh, iCal feed | Không tốn phí, không cần đăng ký doanh nghiệp, đủ để demo trọn luồng |
| Mở rộng 1 | SePay / Casso webhook, MinIO + Gotenberg (PDF) | Tự đối soát học phí: lợi ích lớn nhất cho gia sư |
| Mở rộng 2 | Zalo ZNS, FCM, Google OAuth | Tăng tỉ lệ phụ huynh đọc thông báo |
| Mở rộng 3 | PayOS / MoMo, Google Calendar 2 chiều, Zoom / Meet, Claude API | Tự động hóa và tiện ích nâng cao |
| Khi cần | Hóa đơn điện tử, SMS brandname | Phụ thuộc yêu cầu pháp lý và quy mô |
