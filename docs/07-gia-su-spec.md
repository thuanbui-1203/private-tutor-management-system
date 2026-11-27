# 07. Spec phần gia sư

> Trạng thái: đã duyệt 2026-11-25. **Đã cài đặt: mục 6, mục 7 (trừ phụ huynh đồng ý ghi danh), emulator RTDB.** Các mục khác chưa. Chạy và thử ở **local**.
> "Giáo viên" (`Tutor`) là thuật ngữ chuẩn trong [GLOSSARY.md](../GLOSSARY.md); tài liệu này dùng "gia sư" theo yêu cầu gốc.

## 1. Đã chốt

| # | Quyết định |
|---|---|
| 1 | Tiền đi: phụ huynh → trung tâm → gia sư. VietQR học phí trỏ vào tài khoản trung tâm, không còn trỏ vào gia sư |
| 2 | Công = mức cố định mỗi buổi theo lớp, chốt theo tháng, không phụ thuộc số học sinh |
| 3 | Một trung tâm (ADR-0001 giữ nguyên). Gia sư tự đăng ký, Admin duyệt |
| 4 | "Nước ngoài" áp dụng cho cả nơi dạy và nơi cấp bằng. Chi trả chỉ qua ngân hàng VN |
| 5 | Gia sư chưa duyệt được tạo lớp nháp, không được nhận học sinh |
| 6 | Lưu file trên Firebase Realtime Database (RTDB), có giới hạn ở mục 5 |
| 7 | Chi trả qua sandbox: chủ app quét một mã, hệ thống tự chia về từng công hợp lệ |
| 8 | Dạy online: gia sư dán link Meet / Zoom của mình |
| 9 | Email gửi qua Gmail SMTP của chủ dự án (địa chỉ và App Password chỉ nằm trong `.env`) |
| 10 | Đăng nhập Google cho cả 4 vai trò; học sinh được tự tạo tài khoản |

## 2. Hồ sơ gia sư (tutor-service, `tutor_db`)

Trạng thái: `DRAFT → SUBMITTED → VERIFIED | NEEDS_CHANGES | REJECTED`; `VERIFIED → SUSPENDED → VERIFIED`. Sửa phần đã duyệt thì riêng phần đó về `PENDING`, hồ sơ vẫn hiển thị bản đã duyệt.

| Bảng | Trường chính | Ai xem |
|---|---|---|
| `tutor_profiles` | loại (`STUDENT`, `TEACHER`, `GRADUATE`), tên hiển thị, giới thiệu, trường, quốc gia, trạng thái | Công khai khi `VERIFIED` |
| `credentials` | loại (thẻ SV, bằng, chứng chỉ, bảng điểm), tên, nơi cấp, quốc gia, số hiệu, ngày cấp, hạn, file, trạng thái duyệt, lý do | Công khai: tên + "đã xác minh". File và số hiệu: chủ hồ sơ, Admin |
| `transcript_entries` | GPA, thang điểm, môn, điểm | Chỉ khi gia sư bật công khai |
| `tutor_subjects` | môn, khối lớp, học phí gợi ý, bằng chứng liên quan, trạng thái duyệt | Công khai khi đã duyệt |
| `service_areas` | mã tỉnh + mã phường/xã, hoặc `ONLINE`, hoặc nước ngoài (quốc gia, thành phố, múi giờ) | Công khai |
| `availabilities` | thứ, giờ bắt đầu, giờ kết thúc, múi giờ | Công khai |
| `learner_proofs` | đánh giá 1–5 hoặc kết quả, buổi học liên kết, Consent | Công khai, ẩn tên |
| `verification_reviews` | người duyệt, quyết định, lý do, thời điểm (chỉ thêm) | Admin |

Quy tắc:

- **BR-TU-01:** chỉ hồ sơ `VERIFIED` và môn đã duyệt mới xuất hiện trong tìm kiếm và nhận ghi danh.
- **BR-TU-02:** không thu ảnh CCCD. Xác minh danh tính bằng thẻ sinh viên / bằng cấp; phần không cần thiết trong ảnh nên được che trước khi tải lên.
- **BR-TU-03:** `TEACHER` đang dạy ở trường phải khai trường, xác nhận đã báo cáo Hiệu trưởng và xác nhận học sinh ghi danh không phải học sinh mình được phân công dạy.
- **BR-TU-04:** học sinh lớp 1–5 chỉ ghi danh được môn nghệ thuật, thể dục thể thao, kĩ năng sống; môn khác → 422.
- **BR-TU-05:** minh chứng học viên chỉ nhận từ học sinh có ít nhất 1 buổi `PRESENT` / `LATE` với gia sư. Học sinh dưới 18 tuổi cần phụ huynh đồng ý; từ 7 tuổi cần thêm chính em đồng ý.
- **BR-TU-06:** chứng chỉ hết hạn tự mất dấu xác minh.

## 3. Tìm gia sư

`GET /tutors` (không cần đăng nhập, có rate limit): lọc môn, khối, tỉnh / phường, online, quốc gia, thứ + giờ trống, khoảng học phí. `GET /tutors/{id}` trả hồ sơ công khai.

Học sinh hoặc phụ huynh gửi **yêu cầu học** (`PENDING → ACCEPTED | DECLINED | EXPIRED`, 7 ngày). Gia sư chấp nhận thì chạy luồng ghi danh hiện có.

Danh mục (76 ngân hàng, trong đó 48 hỗ trợ chuyển khoản; 34 tỉnh, 3.321 phường/xã tại 2026-11-25) được đồng bộ vào database mỗi tuần và có bản sao trong repo, nên API ngoài ngừng thì app vẫn chạy. Quốc gia lấy từ dữ liệu tĩnh ISO 3166. Trường đại học: gợi ý, luôn cho nhập tay.

## 4. Lớp học (academic-service, `academic_db`)

| Chức năng | Nội dung |
|---|---|
| Nội dung buổi | Mục tiêu, nội dung đã dạy, dặn dò |
| Tài liệu | File (mục 5) hoặc link; gắn với lớp hoặc buổi |
| Bài tập | Đề, hạn nộp, file; học sinh nộp, gia sư chấm 0–10 và nhận xét |
| Điểm | `HOMEWORK`, `QUIZ`, `TEST` |
| Điểm danh | Giữ nguyên ở schedule-service |
| Tiến trình | Chuyên cần, bài đã nộp, điểm trung bình, xu hướng; tính từ event |
| Link online | `meetingUrl` của lớp, có thể ghi đè từng buổi |

- **BR-AC-02:** link chỉ nhận `https` và host `meet.google.com`, `zoom.us`, `*.zoom.us`. Chỉ người trong roster và gia sư thấy link. Nút tham gia mở từ 15 phút trước giờ học. Bấm link **không** phải điểm danh.
- **BR-AC-03:** chỉ gia sư của lớp và Admin được giao bài, chấm, xem tiến trình cả lớp. Học sinh / phụ huynh chỉ thấy phần của mình (BR-SC-10).

## 5. Lưu file trên RTDB, thiết kế để mở rộng

RTDB là cơ sở dữ liệu JSON, không phải kho file. Giới hạn gói Spark: lưu 1 GB, tải 10 GB/tháng, 100 kết nối đồng thời, chuỗi ≤ 10 MB, một lần ghi qua SDK ≤ 16 MB, **một database mỗi project**. File phải đổi sang base64 (lớn hơn khoảng 1/3), nên sức chứa thật khoảng **750 MB**, và file 5 MB chỉ tải được khoảng **50 lần mỗi ngày**.

| Quyết định | Chi tiết |
|---|---|
| Truy cập | Chỉ backend (Admin SDK). Rules: `".read": false, ".write": false`. Trình duyệt tải qua gateway, nên không tốn 100 kết nối |
| Metadata | PostgreSQL của service sở hữu: id, chủ, tên, MIME, kích thước, SHA-256, trạng thái, **`location`** |
| Nội dung | `/blobs/{shard}/{fileId}/{n}`: mỗi phần 512 KB, mã hóa AES-256-GCM trước khi base64 (khóa `FILE_DATA_KEY`, có số phiên bản khóa) |
| Giới hạn | 5 MB mỗi file; bằng cấp: PDF, JPG, PNG; kiểm tra magic bytes; hạn mức tổng 700 MB, vượt thì trả 507 |
| File lớn | Gia sư dán link Drive / YouTube |
| Giảm lượt tải | Cache có giới hạn trên đĩa của service, `ETag` cho trình duyệt; file giống nhau của cùng chủ chỉ lưu một lần (SHA-256) |
| Ghi dở | Metadata `UPLOADING → READY`; job dọn phần mồ côi |
| Local | RTDB Emulator (`--import` / `--export-on-exit`), project `demo-tms`, không dùng project thật |

**Mở rộng.** Nghiệp vụ chỉ biết port `FileStorage` (`put`, `get`, `delete`), không biết RTDB. Mỗi file ghi `location` = `<backend>:<instance>` (ví dụ `rtdb:default`), đọc luôn theo `location` của chính file đó, ghi thì theo cấu hình hiện tại. Nhờ vậy:

| Khi nào | Làm gì | Có phải sửa nghiệp vụ, dừng hệ thống? |
|---|---|---|
| Gần 700 MB | Lên Blaze, thêm database instance; file mới sang instance mới, file cũ đọc chỗ cũ | Không |
| Lượt tải nhiều | Chạy thêm bản sao service (không giữ trạng thái, cache chỉ là bản phụ); thêm CDN cho file công khai | Không |
| File lớn, video | Thêm `S3FileStorage` (R2, SeaweedFS, S3) với presigned URL; file mới ghi vào đó | Không |
| Bỏ hẳn RTDB | Job nền: sao chép từng file sang nơi mới, kiểm tra SHA-256, đổi `location`, rồi mới xóa bản cũ; dừng và chạy tiếp được | Không |

Giới hạn cần nói thẳng: không thiết kế nào làm RTDB gói miễn phí lớn hơn 1 GB. Cái được bảo đảm là **đổi chỗ lưu không phải viết lại hệ thống**.

## 6. Công và chi trả (billing-service): đã cài đặt

**Công hợp lệ** (BR-PY-01) khi đủ: buổi đã điểm danh; đã qua hạn sửa 48 giờ (tính từ cuối ngày học); có **ít nhất một học sinh `PRESENT` hoặc `LATE`**; lớp có mức công; buổi không bị hủy hay dời. Cả lớp không ai đến (dù có phép hay không) thì **không tính công**. Mỗi buổi tối đa một dòng công (khóa duy nhất trong database). Điều kiện gia sư `VERIFIED` thêm khi có tutor-service.

**Mức công:** Admin đặt theo lớp. Lần đầu áp dụng cho cả buổi đã dạy; lần đổi sau áp dụng từ tháng kế tiếp.

Trạng thái công: `WAITING_LOCK`, `NO_RATE`, `NOT_PAYABLE`, `ELIGIBLE`, `IN_RUN`, `PAID`. Công đã vào kỳ chi trả không bao giờ bị sửa; điểm danh đổi sau đó tạo dòng `ADJUSTMENT` cho kỳ sau (như ADR-0002). Tổng của một gia sư không dương thì giữ lại sang kỳ sau.

`PayrollRun`: `DRAFT → AWAITING_FUNDS → SETTLING → COMPLETED | PARTIAL`; hủy được khi chưa nhận tiền. Mỗi lúc chỉ một kỳ đang mở.

Luồng:

1. Admin xem trước, tạo kỳ, duyệt.
2. App hiện **một QR** cho tổng tiền. QR sandbox là link nội bộ có token (lưu dạng băm, hết hạn 30 phút, tạo mã mới thì mã cũ mất hiệu lực), **không phải VietQR thật**. Quét bằng điện thoại cần `SANDBOX_PUBLIC_URL` là IP LAN của máy; hoặc mở link trên máy.
3. Trang giả lập: thành công, thiếu một nửa, thất bại. Kết quả vào `POST /billing/payroll/webhook` có chữ ký HMAC, từ chối nếu quá 5 phút, chống gửi trùng theo mã giao dịch.
4. Nhận đủ thì hệ thống **tự chia**: mỗi gia sư một `Payout` đúng bằng tổng công của họ. Trước khi chia kiểm tra trong transaction: tổng các phần = tổng kỳ, và mỗi phần = tổng công của đúng gia sư đó. Thiếu thì chờ; thừa thì ghi lại, không chia cho ai.
5. Một payout lỗi không chặn người khác, sửa tài khoản rồi chuyển lại riêng. Không rõ kết quả (timeout) thì gửi lại với **cùng khóa idempotency**, nên không trả hai lần.
6. Gia sư chưa có tài khoản còn Consent không nằm trong tổng QR, tự vào kỳ sau.

Khi `PAYOUT_MODE` bật, QR học phí chỉ trỏ về tài khoản trung tâm (`BILLING_BANK_*`). `PAYOUT_MODE=sandbox` với `NODE_ENV=production` thì service từ chối khởi động.

Tiền thật về sau: một lần quét chỉ đưa tiền vào **một** tài khoản; ngân hàng không tự chia. Thêm một `PayoutProvider` gọi API chi hộ (ví dụ payOS) là đủ, phần còn lại giữ nguyên. Sandbox quy ước: tài khoản tận cùng `0000` bị từ chối để thử tình huống lỗi.

Chưa làm: khấu trừ thuế TNCN, tự tạo kỳ theo lịch, chọn ngân hàng từ danh sách (bước 3), bỏ việc giáo viên xem số tài khoản phụ huynh.

**Ngân hàng:** lưu BIN + số tài khoản + tên, có Consent, mã hóa (ADR-0006). **Không lưu số thẻ.**

## 7. Đăng nhập và tài khoản

- `signInWithPopup` (máy tính), `signInWithRedirect` (điện thoại). Lần đầu chọn TUTOR, STUDENT hoặc PARENT. ADMIN chỉ theo danh sách email trong `.env`.
- Backend kiểm tra `sign_in_provider = google.com` và `email_verified = true`.
- Lời mời chỉ nhận khi email Google trùng email được mời; bỏ bước đặt mật khẩu.
- Học sinh dưới 18 tự tạo được tài khoản, nhưng ghi danh cần một phụ huynh đã liên kết (hai bên xác nhận) và đồng ý.
- Local dùng Auth Emulator (đăng nhập Google giả lập). Chưa tắt mật khẩu trên project thật vì VPS dùng chung.
- Seed, e2e, load tester, demo recorder chuyển sang emulator + Google giả lập.

## 8. Thông báo

Gmail SMTP với App Password (cần bật xác minh 2 bước). Giới hạn Gmail cá nhân: 500 email/ngày, nên hàng đợi gửi tối đa 400/ngày, ưu tiên: lời mời và duyệt hồ sơ > hủy / dời buổi > hóa đơn, chi trả > nhắc lịch. Lỗi thì thử lại, quá 3 lần vào DLQ. Local mặc định Mailpit; đặt `SMTP_*` để gửi thật.

## 9. Thay đổi kiến trúc

| Phần | Thay đổi |
|---|---|
| Service mới | tutor-service, academic-service (mỗi service một database, ADR-0003) |
| `Student.tutorId` | Bỏ quan hệ một học sinh – một gia sư; quyền suy ra từ ghi danh (`tutor ↔ class ↔ student`). **Rủi ro nhất**: mọi kiểm tra quyền ở student, class, schedule, billing dựa vào trường này. Làm theo bước: thêm bảng quan hệ → ghi song song → chuyển đọc → xóa cột |
| Hóa đơn | `tutorId` trên hóa đơn chuyển thành theo dòng phí; QR trỏ về trung tâm |
| ADR | 0001 (thêm: tự đăng ký + duyệt), 0004 (chỉ Google), 0006 (QR trung tâm), mới: 0007 file trên RTDB, 0008 chi trả qua port, 0009 xác minh gia sư |
| Event mới | `TutorSubmitted`, `TutorVerified`, `TutorSuspended`, `LearningRequestCreated`, `MaterialPublished`, `AssignmentCreated`, `SubmissionGraded`, `WorkItemEligible`, `PayrollFunded`, `PayoutSettled` |

## 10. Thứ tự làm và điều kiện xong

| Bước | Xong khi |
|---|---|
| 1. Emulator Auth + RTDB, đăng nhập Google | 4 vai trò đăng nhập được ở local; e2e xanh |
| 2. Hồ sơ gia sư + file + duyệt | Nộp, yêu cầu sửa, duyệt, từ chối; file chỉ chủ và Admin tải được |
| 3. Ngân hàng, danh mục | Chọn từ danh sách; API ngoài tắt vẫn lưu được |
| 4. Lớp học: nội dung, tài liệu, bài tập, điểm, link online | Học sinh lớp khác nhận 404 |
| 5. Công + chi trả sandbox | Test: gửi trùng webhook, thiếu tiền, một payout lỗi, sửa điểm danh sau chốt, tổng chia = tổng nạp |
| 6. Bỏ `Student.tutorId` | Test phân quyền cho mọi vai trò |
| 7. Tìm kiếm, học sinh, phụ huynh | Sau khi gia sư hoàn thiện |

## 11. Pháp lý cần nhớ khi vận hành thật

Không phải tư vấn pháp lý. Nguồn và mức tin cậy:

| Điểm | Nguồn | Mức tin cậy |
|---|---|---|
| Tổ chức, cá nhân dạy thêm ngoài nhà trường có thu tiền phải đăng ký kinh doanh và công khai môn, thời lượng, địa điểm, hình thức, thời gian, danh sách người dạy, mức thu | Thông tư 29/2024 Điều 6.1 | Bản PDF có chữ ký trên cổng Chính phủ (đọc qua OCR) |
| Không dạy thêm học sinh tiểu học trừ nghệ thuật, thể thao, kĩ năng sống; giáo viên không thu tiền học sinh mình đang được phân công dạy | Thông tư 29/2024 Điều 4.1, 4.2 | Như trên |
| Thông tư 19/2026 sửa đổi từ 15/5/2026; ngoại ngữ, STEM, nghệ thuật... ngoài chương trình môn học không thuộc phạm vi | Tin của Bộ GD&ĐT | Chưa đọc toàn văn |
| Sinh viên dạy qua trung tâm không phải tự đăng ký kinh doanh, nhưng phải ký hợp đồng với trung tâm | Thư Viện Pháp Luật (bài tư vấn) | Nguồn thứ cấp |
| Ảnh CCCD, thông tin thẻ và lịch sử giao dịch ngân hàng là dữ liệu nhạy cảm; phải báo rõ khi xin đồng ý, không đồng ý mặc định | NĐ 356/2025 Điều 4, Điều 6 | Bản sao trên trang tư vấn |
| Trẻ em: người đại diện thực hiện quyền; công bố đời tư từ 7 tuổi cần cả trẻ và người đại diện | Luật 91/2025 Điều 24 | Bản sao trên trang tư vấn |
| Lưu dữ liệu ở máy chủ nước ngoài là chuyển dữ liệu xuyên biên giới, phải lập hồ sơ đánh giá trong 60 ngày | Luật 91/2025 Điều 20 | Bản sao; chưa đọc các trường hợp miễn trừ trong nghị định |
| RTDB không có vùng Việt Nam (gần nhất Singapore) | Tài liệu Firebase | Chính thức |
| Khấu trừ thuế TNCN 10% từ 5 triệu đồng/lần chi trả từ 1/7/2026 | Bài tư vấn về NĐ 253/2026 | Thấp, các nguồn chưa thống nhất |

Ở giai đoạn local dùng emulator, không có dữ liệu cá nhân nào rời khỏi máy.
