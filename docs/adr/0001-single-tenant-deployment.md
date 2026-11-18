# Mỗi bản triển khai phục vụ một trung tâm (single-tenant)

Một bản triển khai phục vụ đúng một trung tâm (một Admin và 1–5 giáo viên). Không mô hình dữ liệu nào có thực thể "tổ chức" hay "trung tâm"; Admin nghĩa là "thấy mọi dữ liệu trong bản triển khai này". Các trung tâm độc lập chạy các bản triển khai riêng.

Nếu sau này mới thêm tenant id vào mọi bảng, token và event thì phải sửa mọi service, nên mô hình SaaS nhiều trung tâm được cố ý để ngoài phạm vi. Người dùng mục tiêu là một gia sư hoặc một trung tâm rất nhỏ; chi phí cô lập dữ liệu giữa các tenant lớn hơn lợi ích nó mang lại cho dự án.
