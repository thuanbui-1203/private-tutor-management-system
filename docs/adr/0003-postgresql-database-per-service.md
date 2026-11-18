# PostgreSQL trong Docker, mỗi service một database

Mỗi service lưu dữ liệu trong database riêng (`identity_db`, `student_db`, `class_db`, `schedule_db`, `billing_db`) trên **một container PostgreSQL 18** trong `docker compose`. Mỗi database có một login role riêng và role đó chỉ kết nối được database của mình, nên nguyên tắc database-per-service được PostgreSQL phân quyền bảo đảm, không chỉ là quy ước. Schema và truy vấn đi qua Prisma 7 (client được sinh vào `src/generated/prisma`, dùng driver adapter `pg`), mỗi service một Prisma schema.

Chúng tôi đã cân nhắc Cloud Firestore, vì Firebase đã lo phần đăng nhập ([ADR-0004](0004-firebase-authentication.md)). Ở gói miễn phí Spark, mỗi project chỉ có một database, khiến database-per-service chỉ còn là quy ước đặt tên; hạn mức mỗi ngày (50.000 lượt đọc, 20.000 lượt ghi) cũng quá chật cho outbox relay và test. Firestore còn thiếu ràng buộc unique và phép join mà các quy tắc nghiệp vụ cần, như `UNIQUE(class_id, student_id)` hay mỗi học sinh mỗi tháng chỉ có một hóa đơn tháng chưa `VOID`. Chúng tôi cũng từng thử PostgreSQL cài trực tiếp trên máy, rồi bỏ để mọi máy đều có cùng một database chỉ với `docker compose up`.

## Hệ quả

- Một server chứa nhiều database giúp cả hệ thống đủ nhẹ để chạy trên laptop; nếu sau này tách một database ra server riêng thì chỉ cần đổi `DATABASE_URL` của service đó.
- `infra/postgres/` tạo các database và role ở lần khởi động đầu tiên; dữ liệu nằm trong một named volume của Docker. Image PostgreSQL 18 lưu dữ liệu dưới `/var/lib/postgresql` (không còn là `/var/lib/postgresql/data` như các image cũ), nên volume phải gắn vào đúng đường dẫn đó.
- Port 5432 được mở ra máy host để chạy migration (`pnpm migrate:all`) và Prisma Studio từ máy host.
- Integration test dùng chung container này, mỗi lần chạy dùng một database riêng.
