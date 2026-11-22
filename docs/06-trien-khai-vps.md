# Triển khai lên VPS (Bizfly Cloud + Cloudflare Tunnel)

> Cách đưa TMS lên một VPS để demo công khai. Các file dùng ở đây: [`docker-compose.prod.yml`](../docker-compose.prod.yml), [`.env.production.example`](../.env.production.example), [`scripts/vps/`](../scripts/vps/). Cách chạy trên máy cá nhân xem [03-cach-chay.md](03-cach-chay.md).

## 1. Kiến trúc khi chạy trên VPS

```
Trình duyệt ──HTTPS──▶ Cloudflare ──(tunnel, VPS tự kết nối ra)──▶ cloudflared ─┬─▶ frontend:5173     (app.<domain>)
                                                                                └─▶ api-gateway:8080  (api.<domain>)
                                                    VPS: mọi container nằm trong mạng Docker tms-net
```

- **VPS không mở cổng nào ra Internet** ngoài SSH (22). `cloudflared` tự kết nối ra Cloudflare, nên không cần mở 80/443, không cần Nginx và không phải tự quản lý chứng chỉ SSL.
- `docker-compose.prod.yml` bỏ mọi `ports:` của stack. Lý do: Docker tự ghi luật iptables và **đi vòng qua UFW**, nên một cổng đã publish vẫn mở ra Internet dù tường lửa đang bật.
- Grafana chỉ nghe trên `127.0.0.1:3000` của VPS. Muốn xem thì mở SSH tunnel (mục 6).

## 2. Cấu hình VPS

| Mục | Giá trị |
|---|---|
| Nhà cung cấp | Bizfly Cloud |
| Cấu hình đang dùng | 2 vCPU, **2 GB RAM**, 40 GB SSD, cộng 4 GB swap (script tự tạo). Đủ cho demo khi tắt Prometheus/Grafana (profile `monitoring`); khi chạy, RAM còn trống khoảng 500 MB |
| Hệ điều hành | Ubuntu 24.04 LTS (hoặc 22.04), x86_64 |
| Người dùng | `deploy` (sudo, docker), chỉ đăng nhập bằng SSH key; tắt đăng nhập root và đăng nhập bằng mật khẩu |
| Tường lửa | UFW: chỉ mở OpenSSH; fail2ban chặn dò mật khẩu SSH |
| Thư mục app | `/home/deploy/tms` |

## 3. Những gì đã đổi trong code để chạy được trên VPS

| Thay đổi | Lý do |
|---|---|
| `docker-compose.prod.yml` (mới) | Bỏ mọi cổng publish, `restart: unless-stopped`, giới hạn log 10 MB × 3, tắt Mailpit, thêm service `cloudflared` |
| Gateway đọc biến `TRUST_PROXY` ([app.setup.ts](../backend/api-gateway/src/app.setup.ts)) | Khi chạy sau `cloudflared`, mọi request đều mang IP của container `cloudflared`, khiến tất cả người dùng chung một hạn mức rate limit 600/phút. `TRUST_PROXY=uniquelocal` cho gateway lấy IP thật từ `X-Forwarded-For` |
| Truyền `CORS_ORIGINS`, `TRUST_PROXY`, `RATE_LIMIT_*` vào gateway; `FRONTEND_URL` vào identity ([docker-compose.yml](../docker-compose.yml)) | Trước đây code đã đọc các biến này nhưng compose không truyền vào. Hậu quả: CORS chỉ nhận `localhost:5173`, và link mời luôn trỏ về `localhost` |
| [`scripts/vps/migrate.sh`](../scripts/vps/migrate.sh) | Trên VPS, PostgreSQL không mở cổng ra host, nên migration chạy trong mạng Docker bằng image stage `build` của từng service |
| `NODE_ENV=development` trong `.env` của VPS | Khi là `production`, API mời người dùng ẩn link mời, mà chưa có notification-service để gửi email. Image vẫn chạy bản build production |

## 4. Các bước thao tác trên dashboard (làm một lần)

### 4.1 Bizfly Cloud
1. Tạo Cloud Server: Ubuntu 24.04, 2 vCPU / 4 GB / 40 GB, đặt ở Hà Nội hoặc TP.HCM.
2. Ở phần xác thực, chọn SSH key và dán public key của máy bạn (`~/.ssh/id_ed25519.pub`). Nếu chỉ có mật khẩu root thì vẫn được: script ở mục 5 sẽ thêm key rồi tắt đăng nhập bằng mật khẩu.
3. Ghi lại IP public. Nếu Bizfly có security group (tường lửa phía nhà cung cấp), chỉ cho phép inbound TCP 22.

### 4.2 Cloudflare: hai cách đưa app ra Internet

**Cách A, đang dùng: Quick Tunnel (không cần tên miền, không cần tài khoản).** [`docker-compose.quicktunnel.yml`](../docker-compose.quicktunnel.yml) chạy hai container `tunnel-app` và `tunnel-api`; mỗi container nhận một URL ngẫu nhiên `https://<tên>.trycloudflare.com`.

- URL **đổi mỗi khi container tunnel khởi động lại** (kể cả khi VPS reboot). Khi đó làm lại các bước ở mục 6, dòng "URL Quick Tunnel bị đổi".
- Không có SLA và giới hạn khoảng 200 request đồng thời: chỉ dùng cho demo.

**Cách B, khi gắn tên miền riêng: named tunnel tạo từ dòng lệnh.** Không cần vào dashboard Zero Trust; chỉ cần một lần bấm **Authorize** trong trình duyệt.

```bash
# Trên VPS. In ra một link: mở link trong trình duyệt đã đăng nhập Cloudflare, chọn tên miền,
# bấm Authorize (link hết hạn sau khoảng 8 phút). cert.pem được ghi vào ~/.cloudflared/.
CF="docker run --rm -v $HOME/.cloudflared:/home/nonroot/.cloudflared cloudflare/cloudflared:2025.11.1"
$CF tunnel login
$CF tunnel create tms-vps                     # ghi credentials ~/.cloudflared/<TUNNEL_ID>.json
$CF tunnel route dns tms-vps app.<domain>     # tạo CNAME trên Cloudflare
$CF tunnel route dns tms-vps api.<domain>
cp ~/.cloudflared/<TUNNEL_ID>.json ~/tms/infra/cloudflared/
cat > ~/tms/infra/cloudflared/config.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: app.<domain>
    service: http://frontend:5173
  - hostname: api.<domain>
    service: http://api-gateway:8080
  - service: http_status:404
EOF
```

Sau đó sửa `.env` (`FRONTEND_URL`, `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL` sang `app.`/`api.<domain>`), thêm `app.<domain>` vào Firebase (mục 4.3), rồi chạy **không có** file quicktunnel:

```bash
docker compose -f docker-compose.yml -f docker-compose.quicktunnel.yml rm -sf tunnel-app tunnel-api
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build frontend api-gateway identity-service cloudflared
```

### 4.3 Firebase: thêm domain của frontend vào Authorized domains
Vào Console: **Authentication → Settings → Authorized domains → Add domain**. Hoặc làm bằng API với key service account, không cần mở Console:

```bash
# Chạy trong backend/identity-service (có sẵn firebase-admin)
node ../../scripts/vps/fb-domains.cjs ../../infra/keys/firebase-service-account.json <host-của-frontend>
```

## 5. Các bước trên server

Chạy từ máy Windows (Git Bash):

```bash
# 5.1 SSH key riêng cho VPS, rồi chạy script cài đặt bằng root (lần đầu đăng nhập)
ssh-keygen -t ed25519 -C tms-vps -f ~/.ssh/tms_vps    # đã tạo ngày 2026-11-22
cat >> ~/.ssh/config <<EOF
Host tms-vps
  HostName <VPS_IP>
  User deploy
  IdentityFile ~/.ssh/tms_vps
EOF
scp scripts/vps/setup-server.sh root@<VPS_IP>:/root/
ssh root@<VPS_IP> "bash /root/setup-server.sh '$(cat ~/.ssh/tms_vps.pub)'"
# Từ giờ chỉ đăng nhập được bằng key: ssh tms-vps   (deploy@<VPS_IP>)

# 5.2 Lấy code và đưa các file bí mật lên
ssh tms-vps "git clone https://github.com/thuanbui-1203/private-tutor-management-system.git tms && mkdir -p tms/infra/keys"
scp infra/keys/firebase-service-account.json tms-vps:tms/infra/keys/
scp .env.vps tms-vps:tms/.env          # .env.vps: bản .env.production.example đã điền đủ
ssh tms-vps "chmod 600 tms/.env tms/infra/keys/*"
```

Trên VPS (`ssh tms-vps`, `cd ~/tms`):

```bash
# 5.3 Build và chạy (lần đầu mất khoảng 10–15 phút)
# VPS 2 GB: build từng service một (mỗi service khoảng 3 phút), rồi mới chạy
DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.quicktunnel.yml"
for s in api-gateway identity-service student-service class-service schedule-service billing-service frontend; do $DC build $s; done
$DC up -d --no-build
$DC ps   # chờ mọi container healthy

# 5.4 Tạo bảng
bash scripts/vps/migrate.sh
```

### 5.5 Dữ liệu
Firebase dùng **chung một project thật** với máy cá nhân, nên các tài khoản demo đã có sẵn trên Firebase. Nếu chạy `pnpm seed:demo` trên VPS, script sẽ thấy tài khoản đã tồn tại và **không tạo gì cả**, để lại database trống. Cách đúng là **chép database từ máy cá nhân lên** (UID khớp với Firebase):

```bash
# Trên máy Windows (stack local đang chạy, Postgres mở cổng 5432)
mkdir -p dumps
for db in identity_db student_db class_db schedule_db billing_db; do
  docker compose exec -T postgres pg_dump -U tms -Fc "$db" > "dumps/$db.dump"
done
ssh tms-vps mkdir -p dumps && scp dumps/*.dump tms-vps:dumps/

# Trên VPS, trong ~/tms (sau bước 5.4)
for db in identity_db student_db class_db schedule_db billing_db; do
  docker compose exec -T postgres pg_restore -U tms -d "$db" --clean --if-exists \
    --no-owner --role="${db%_db}" < ~/dumps/"$db".dump
done
$DC restart identity-service student-service class-service schedule-service billing-service api-gateway
```

Tài khoản đăng nhập xem ở [DEMO-ACCOUNTS.md](../DEMO-ACCOUNTS.md).

### 5.6 Backup hằng ngày
```bash
mkdir -p ~/backups
(crontab -l 2>/dev/null; echo '0 2 * * * bash /home/deploy/tms/scripts/vps/backup-db.sh >> /home/deploy/backups/backup.log 2>&1') | crontab -
```

## 6. Vận hành

| Việc | Lệnh (trên VPS, trong `~/tms`) |
|---|---|
| Alias (đã có trong `~/.bashrc` của `deploy`) | `dc` = `docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.quicktunnel.yml` |
| URL Quick Tunnel bị đổi | `dc logs tunnel-app tunnel-api \| grep trycloudflare.com`; sửa 3 biến URL trong `.env`; thêm host mới vào Firebase (mục 4.3); `dc up -d --build frontend api-gateway identity-service` |
| Cập nhật code mới | `git pull && dc up -d --build && bash scripts/vps/migrate.sh` |
| Xem log | `dc logs -f api-gateway` (hoặc tên service khác) |
| Trạng thái, RAM | `dc ps`, `docker stats --no-stream` |
| Khởi động lại | `dc restart <service>` |
| Dừng tất cả (giữ dữ liệu) | `dc down` (**không** thêm `-v`, vì `-v` xoá database) |
| Xem Grafana | `dc --profile monitoring up -d prometheus grafana` (tốn khoảng 300 MB RAM), rồi trên máy Windows: `ssh -L 3000:127.0.0.1:3000 tms-vps`, rồi mở http://localhost:3000 |
| Dọn image cũ khi đầy ổ | `docker image prune -f && docker builder prune -f` |

**Đổi `NEXT_PUBLIC_*` hoặc tên miền:** phải build lại frontend (`dc up -d --build frontend`), vì các biến này được gắn vào lúc build.

## 7. Kiểm tra sau khi triển khai

```bash
curl -s https://api.<domain>/health/ready       # {"status":"ok",...}
curl -sI https://app.<domain> | head -1          # HTTP/2 200
# Từ máy ngoài: không cổng nào ngoài 22 được mở
nmap -Pn -p 22,80,443,3000,5432,5672,6379,8080,15672 <VPS_IP>
```

## 8. Sự cố thường gặp

| Triệu chứng | Nguyên nhân / cách sửa |
|---|---|
| Trình duyệt báo lỗi CORS | `CORS_ORIGINS` phải đúng `https://app.<domain>` (không có `/` ở cuối), rồi `dc up -d api-gateway` |
| Frontend vẫn gọi `localhost:8080` | `NEXT_PUBLIC_API_URL` sai lúc build; sửa `.env` rồi `dc up -d --build frontend` |
| Đăng nhập báo `auth/unauthorized-domain` | Chưa thêm `app.<domain>` vào Authorized domains của Firebase |
| Cloudflare báo lỗi 1033 / 502 | `dc logs cloudflared`: sai token, hoặc Public Hostname trỏ sai tên service hoặc cổng |
| Build bị dừng vì hết RAM | Kiểm tra swap bằng `swapon --show`; build từng service: `dc build frontend` |
| API trả 401 với mọi request | Thiếu hoặc sai `infra/keys/firebase-service-account.json`, hoặc `FIREBASE_AUTH_EMULATOR_HOST` chưa để trống |

## 9. Nhật ký cấu hình thực tế

Ghi lại những gì đã làm trên VPS và dashboard (không ghi mật khẩu hay token ở đây).

| Ngày | Việc | Ghi chú |
|---|---|---|
| 2026-11-22 | Chuẩn bị code: `docker-compose.prod.yml`, `TRUST_PROXY`, script `scripts/vps/*`, tài liệu này | PR #66, nhánh `deploy/vps-cloudflare` |
| 2026-11-22 | Bizfly: server `ubuntu-2vcpu-2gb-1-timgiasu`, IP `14.225.215.93`, Ubuntu 24.04.2, 2 vCPU / 1,9 GB RAM / 38 GB | Người dùng tự tạo |
| 2026-11-22 | Chạy `setup-server.sh`: user `deploy` + key `~/.ssh/tms_vps` (alias `tms-vps` trong `~/.ssh/config` của máy Windows), 4 GB swap, Docker 29.10 / Compose 5.8, UFW chỉ mở OpenSSH, fail2ban, múi giờ Asia/Ho_Chi_Minh | |
| 2026-11-22 | `sshd_config` của Bizfly **không có** `Include sshd_config.d/*`, nên file drop-in bị bỏ qua: sửa thẳng `PermitRootLogin no`, `PasswordAuthentication no` trong file chính (bản cũ: `/etc/ssh/sshd_config.bak`). Đã kiểm tra: root/mật khẩu bị từ chối | Script đã sửa để làm việc này |
| 2026-11-22 | Clone nhánh `deploy/vps-cloudflare` vào `~/tms`; đưa lên `.env` (mật khẩu Postgres/Grafana sinh ngẫu nhiên) và `infra/keys/firebase-service-account.json` (chmod 600; `deploy` uid 1000 = `node` trong container) | |
| 2026-11-22 | `cloudflared tunnel login` hai lần, cả hai hết hạn vì chưa ai bấm Authorize, nên chuyển sang Quick Tunnel (mục 4.2, cách A) | Chuyển sang cách B khi có người bấm Authorize |
| 2026-11-22 | Quick Tunnel: app `https://common-oecd-spanking-downtown.trycloudflare.com`, api `https://schools-installed-brisbane-provinces.trycloudflare.com` | Đổi khi container tunnel khởi động lại |
| 2026-11-22 | Firebase Authorized domains: thêm `common-oecd-spanking-downtown.trycloudflare.com` qua Admin API (`scripts/vps/fb-domains.cjs`) | |
| 2026-11-22 | Build 6 backend + frontend trên VPS (khoảng 22 phút), `up`, migration 5 database, import dump từ máy local (11 user), cron backup 02:00 | |
| 2026-11-22 | Kiểm tra từ Internet: app 200; `/health/ready` ok; CORS cho origin app; bundle frontend trỏ đúng API; đăng nhập `gv.minh@tms.demo`, rồi `/api/classes`, `/api/students`, `/api/billing/invoices` đều 200; Admin `/api/users` 200; cổng 80/443/3000/5432/5672/6379/8080/15672 đóng | |
