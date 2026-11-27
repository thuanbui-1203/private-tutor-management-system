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

**Cách A, dùng tạm lúc chưa có tên miền: Quick Tunnel (không cần tên miền, không cần tài khoản).** [`docker-compose.quicktunnel.yml`](../docker-compose.quicktunnel.yml) chạy hai container `tunnel-app` và `tunnel-api`; mỗi container nhận một URL ngẫu nhiên `https://<tên>.trycloudflare.com`.

- URL **đổi mỗi khi container tunnel khởi động lại** (kể cả khi VPS reboot). Khi đó làm lại các bước ở mục 6, dòng "URL Quick Tunnel bị đổi".
- Không có SLA và giới hạn khoảng 200 request đồng thời: chỉ dùng cho demo.

**Cách B, đang dùng (timgiasu.date): named tunnel tạo từ dòng lệnh.** Không cần vào dashboard Zero Trust; chỉ cần một lần bấm **Authorize** trong trình duyệt.

```bash
# Trên VPS. In ra một link: mở link trong trình duyệt đã đăng nhập Cloudflare, chọn tên miền,
# bấm Authorize (link hết hạn sau khoảng 8 phút). cert.pem được ghi vào ~/.cloudflared/.
mkdir -p ~/.cloudflared && chmod 777 ~/.cloudflared
docker run --rm -v $HOME/.cloudflared:/home/nonroot/.cloudflared cloudflare/cloudflared:2025.11.1 tunnel login
sudo chown -R deploy:deploy ~/.cloudflared && chmod 700 ~/.cloudflared   # file do uid nonroot của container tạo
# uid 1000 không có home trong image, nên chỉ thẳng đường dẫn cert:
CF="docker run --rm -u 1000:1000 -e TUNNEL_ORIGIN_CERT=/cf/cert.pem -v $HOME/.cloudflared:/cf cloudflare/cloudflared:2025.11.1"
$CF tunnel create --credentials-file /cf/tms-vps.json tms-vps
$CF tunnel route dns tms-vps app.<domain>     # tạo CNAME trên Cloudflare
$CF tunnel route dns tms-vps api.<domain>
cp ~/.cloudflared/tms-vps.json ~/tms/infra/cloudflared/ && chmod 600 ~/tms/infra/cloudflared/tms-vps.json
cat > ~/tms/infra/cloudflared/config.yml <<EOF
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/tms-vps.json
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

### 4.4 Gmail: gửi email kích hoạt tài khoản
`identity-service` gửi email kích hoạt qua SMTP. Trên VPS không có Mailpit, nên dùng Gmail:

1. Tài khoản Google gửi thư phải bật **Xác minh 2 bước**.
2. Vào https://myaccount.google.com/apppasswords, tạo App Password (tên tuỳ ý, ví dụ `tms-vps`), nhận 16 ký tự.
3. Thêm vào `~/tms/.env` trên VPS (bỏ dấu cách trong App Password), rồi `dc up -d identity-service`:
   ```bash
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_SECURE=true
   SMTP_USER=<địa chỉ gmail>
   SMTP_PASS=<app password>
   SMTP_FROM="Tim Gia Su <địa chỉ gmail>"
   ```
4. Kiểm tra: thêm học sinh có email, rồi `dc logs identity-service | grep "activation email"` phải thấy `activation email sent to ...`.

Gmail cho khoảng 500 thư mỗi ngày, đủ cho demo. Thư đầu tiên có thể vào mục Spam hoặc Quảng cáo.

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

### 5.6 Nâng cấp VPS đã chạy lên bản có audit-service (#51)
`init.sql` chỉ chạy với volume rỗng, nên trên VPS đã có dữ liệu phải tạo `audit_db` bằng tay, rồi thêm 3 biến vào `.env`:

```bash
dc exec -T postgres psql -U tms -d postgres < infra/postgres/add-audit-db.sql
cat >> .env <<EOF
AUDIT_DB_URL=postgresql://audit:audit@postgres:5432/audit_db
AUDIT_RETENTION_DAYS=365
BANK_DATA_KEY=$(openssl rand -base64 32)   # KHÔNG đổi sau khi đã lưu tài khoản ngân hàng
EOF
```

Trên VPS 2 GB, mỗi image build mất khoảng 5 phút, và `migrate.sh` build lại stage `build` của từng service (thêm khoảng 5 phút mỗi service). Một lần nâng cấp đầy đủ mất khoảng 70 phút.

### 5.7 Backup hằng ngày
```bash
mkdir -p ~/backups
(crontab -l 2>/dev/null; echo '0 2 * * * bash /home/deploy/tms/scripts/vps/backup-db.sh >> /home/deploy/backups/backup.log 2>&1') | crontab -
```

## 6. Vận hành

| Việc | Lệnh (trên VPS, trong `~/tms`) |
|---|---|
| Alias (đã có trong `~/.bashrc` của `deploy`) | `dc` = `docker compose -f docker-compose.yml -f docker-compose.prod.yml` (named tunnel; không còn file quicktunnel) |
| URL Quick Tunnel bị đổi | `dc logs tunnel-app tunnel-api \| grep trycloudflare.com`; sửa 3 biến URL trong `.env`; thêm host mới vào Firebase (mục 4.3); `dc up -d --build frontend api-gateway identity-service` |
| Cập nhật code mới | `git pull && dc up -d --build && bash scripts/vps/migrate.sh` |
| Xem log | `dc logs -f api-gateway` (hoặc tên service khác) |
| Trạng thái, RAM | `dc ps`, `docker stats --no-stream` |
| Khởi động lại | `dc restart <service>` |
| Dừng tất cả (giữ dữ liệu) | `dc down` (**không** thêm `-v`, vì `-v` xoá database) |
| Quan sát (Prometheus + Grafana) | Xem mục 6.1 bên dưới |
| Dọn image cũ khi đầy ổ | `docker image prune -f && docker builder prune -f` |

**Đổi `NEXT_PUBLIC_*` hoặc tên miền:** phải build lại frontend (`dc up -d --build frontend`), vì các biến này được gắn vào lúc build.

### 6.1 Quan sát VPS từ laptop

VPS chỉ chạy **Prometheus** (khoảng 100 MB, nghe trên `127.0.0.1:9090`, không có đăng nhập nên không bao giờ mở ra ngoài). **Grafana chạy trên laptop** và đọc Prometheus qua SSH, nên VPS không phải gánh thêm Grafana.

```
Laptop: Grafana :3030 ──▶ vps-tunnel (container, ssh -L) ──SSH──▶ VPS 127.0.0.1:9090 ──▶ Prometheus ──▶ các service (tms-net)
```

```bash
# 1. Bật Prometheus trên VPS (chạy từ máy Windows)
ssh tms-vps "cd ~/tms && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile monitoring up -d prometheus"

# 2. Grafana trên laptop, chạy trong thư mục repo. Cần TMS_VPS_HOST=<IP VPS> trong .env
#    và key ~/.ssh/tms_vps.
docker compose -f docker-compose.grafana-vps.yml up -d
#    Mở http://localhost:3030 (admin / admin); dashboard "TMS – Luồng API" mở sẵn.

# 3. Xem xong thì tắt cả hai
docker compose -f docker-compose.grafana-vps.yml down
ssh tms-vps "cd ~/tms && docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile monitoring stop prometheus"
```

- Muốn xem giao diện Prometheus (Status → Targets, chạy PromQL): `ssh -N -L 19090:127.0.0.1:9090 tms-vps`, rồi mở http://localhost:19090. Dùng 19090 vì Prometheus của stack local có thể đang chiếm 9090.
- Cổng 3030 được chọn để không trùng Grafana local (3000) và identity-service (3001), nên chạy song song được với stack local.
- Container `vps-tunnel` tự kết nối lại khi mạng rớt (`restart: unless-stopped`). Nếu Grafana báo lỗi datasource, xem `docker logs tms-grafana-vps-vps-tunnel-1`.

### 6.2 Chế độ bảo trì

```bash
ssh tms-vps "cd ~/tms && bash scripts/vps/maintenance.sh on"      # trang 503, tắt frontend + gateway + các service
ssh tms-vps "cd ~/tms && bash scripts/vps/maintenance.sh status"
ssh tms-vps "cd ~/tms && bash scripts/vps/maintenance.sh off"     # mở lại app
```

Tunnel trỏ `app.` và `api.` về container `tms-maintenance` ([infra/maintenance/server.mjs](../infra/maintenance/server.mjs)). PostgreSQL, RabbitMQ, Redis vẫn chạy nên backup hằng ngày vẫn hoạt động; không xóa dữ liệu nào. Trước khi `off`, hãy deploy bản vá cần thiết. `on` / `off` cần `infra/cloudflared/config.live.yml` (bản cấu hình thật được lưu lại) không bị xóa.

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
| 2026-11-22 | Bizfly: server `ubuntu-2vcpu-2gb-1-timgiasu`, IP trong `~/.ssh/config` (alias `tms-vps`; không ghi vào repo public), Ubuntu 24.04.2, 2 vCPU / 1,9 GB RAM / 38 GB | Người dùng tự tạo |
| 2026-11-22 | Chạy `setup-server.sh`: user `deploy` + key `~/.ssh/tms_vps` (alias `tms-vps` trong `~/.ssh/config` của máy Windows), 4 GB swap, Docker 29.10 / Compose 5.8, UFW chỉ mở OpenSSH, fail2ban, múi giờ Asia/Ho_Chi_Minh | |
| 2026-11-22 | `sshd_config` của Bizfly **không có** `Include sshd_config.d/*`, nên file drop-in bị bỏ qua: sửa thẳng `PermitRootLogin no`, `PasswordAuthentication no` trong file chính (bản cũ: `/etc/ssh/sshd_config.bak`). Đã kiểm tra: root/mật khẩu bị từ chối | Script đã sửa để làm việc này |
| 2026-11-22 | Clone nhánh `deploy/vps-cloudflare` vào `~/tms`; đưa lên `.env` (mật khẩu Postgres/Grafana sinh ngẫu nhiên) và `infra/keys/firebase-service-account.json` (chmod 600; `deploy` uid 1000 = `node` trong container) | |
| 2026-11-22 | `cloudflared tunnel login` hai lần, cả hai hết hạn vì chưa ai bấm Authorize, nên chuyển sang Quick Tunnel (mục 4.2, cách A) | Chuyển sang cách B khi có người bấm Authorize |
| 2026-11-22 | Quick Tunnel: app `https://common-oecd-spanking-downtown.trycloudflare.com`, api `https://schools-installed-brisbane-provinces.trycloudflare.com` | Đổi khi container tunnel khởi động lại |
| 2026-11-22 | Firebase Authorized domains: thêm `common-oecd-spanking-downtown.trycloudflare.com` qua Admin API (`scripts/vps/fb-domains.cjs`) | |
| 2026-11-22 | Build 6 backend + frontend trên VPS (khoảng 22 phút), `up`, migration 5 database, import dump từ máy local (11 user), cron backup 02:00 | |
| 2026-11-22 | Kiểm tra từ Internet: app 200; `/health/ready` ok; CORS cho origin app; bundle frontend trỏ đúng API; đăng nhập `gv.minh@tms.demo`, rồi `/api/classes`, `/api/students`, `/api/billing/invoices` đều 200; Admin `/api/users` 200; cổng 80/443/3000/5432/5672/6379/8080/15672 đóng | |
| 2026-11-22 | Bấm Authorize trong Brave (lần thứ 4), `cert.pem` về VPS, zone **timgiasu.date**. Tạo named tunnel `tms-vps` (id `85b76a86-11ec-4d71-a7f5-12b83fe721fe`), CNAME `app.timgiasu.date` và `api.timgiasu.date`; `infra/cloudflared/config.yml` + `tms-vps.json` (chmod 600, cloudflared chạy uid 1000) | Cert và credentials chỉ nằm trên VPS (`~/.cloudflared`, `~/tms/infra/cloudflared`) |
| 2026-11-22 | `.env`: 3 URL sang `https://app.timgiasu.date` / `https://api.timgiasu.date/api`; Firebase Authorized domains thêm `app.timgiasu.date`; build lại frontend; gỡ 2 Quick Tunnel; `dc up -d --remove-orphans`. Tunnel nối qua Cloudflare HKG | |
| 2026-11-22 | Kiểm tra trên tên miền thật: app 200 (0,66 s); `/health/ready` ok; CORS cho `https://app.timgiasu.date`; bundle frontend trỏ `api.timgiasu.date/api`; đăng nhập `gv.minh@tms.demo`, rồi classes/students/invoices đều 200; Quick Tunnel cũ trả 530 (đã tắt) | Domain trycloudflare cũ vẫn còn trong Firebase Authorized domains, xoá được trên Console |
| 2026-11-22 | Merge toàn bộ PR còn mở: chuỗi audit #59–#65 (xung đột với main ở comment `tms-common.module.ts`, constructor gateway [giữ cả metrics lẫn Access record], volume compose, flow-simulator [lấy bản #58]) và #66. Đóng issue #51 | Trước khi merge, đã kiểm tra trên nhánh tích hợp: build, lint, format, 213 unit test, e2e 8/8 trên stack mới. `main` sau merge giống hệt cây đã kiểm tra |
| 2026-11-22 | Bản cuối lên VPS: backup, `git checkout main` (`de2c6a3`), tạo `audit_db`, thêm `AUDIT_DB_URL`, `AUDIT_RETENTION_DAYS`, `BANK_DATA_KEY` (sinh ngẫu nhiên, chỉ có trên VPS), build 8 image, migrate 6 database, `up` | Khoảng 70 phút; 12 container healthy; RAM trống khoảng 240 MB |
| 2026-11-22 | Kiểm tra sau triển khai: app 200, `/health/ready` ok, CORS đúng; Tutor: classes, students, invoices, bank-account đều 200; Tutor gọi `/audit/access` nhận 403 (đúng); Admin: users, `/audit/access`, `/audit/changes` 200; Access record ghi IP thật của client (`TRUST_PROXY` hoạt động) | Danh sách hoá đơn trả 403 cho Parent là đúng thiết kế (chỉ TUTOR/ADMIN) |
| 2026-11-22 | Quan sát VPS từ laptop (mục 6.1): Prometheus VPS chỉ nghe `127.0.0.1:9090` (profile `monitoring`, chỉ bật Prometheus), thêm `audit-service:3008` vào scrape; Grafana chạy local (`docker-compose.grafana-vps.yml`, cổng 3030) qua container SSH tunnel. Kiểm tra: 9/9 target `up` khi query qua Grafana local. Xoá IP VPS khỏi tài liệu (repo public) | IP chỉ còn trong `~/.ssh/config` và `.env` local (`TMS_VPS_HOST`) |
| 2026-11-23 | Email kích hoạt (PR #70): backup, build identity-service, student-service, frontend, `up`. Gmail SMTP (mục 4.4) do chủ tài khoản tự nhập App Password bằng `~/set-smtp.sh` (chỉ có trên VPS; ghi `SMTP_*` vào `~/tms/.env`, bản cũ ở `.env.bak-smtp`). Kiểm tra: đăng nhập SMTP thành công, thư thử được Gmail nhận (`250 OK`). VPS về `main` (`84f19c7`) | Trên Windows (Git Bash) phải chạy `ssh -t tms-vps "bash /home/deploy/set-smtp.sh"`, vì `~` bị đổi thành thư mục của máy local |
| 2026-11-27 | Lên `main` (`03ed1d6`, #72–#76: đăng nhập Google, tutor-service, lương gia sư, danh mục ngân hàng/tỉnh/phường): xóa bản chép tay `scripts/vps/maintenance.sh` và `infra/maintenance/server.mjs` (giống hệt main) rồi `git pull`; `.env` thêm `ADMIN_EMAILS`, `TUTOR_DB_URL`, `FIREBASE_DATABASE_URL` (instance mặc định asia-southeast1), `FILE_DATA_KEY` (sinh ngẫu nhiên, chỉ có trên VPS: không đổi sau khi đã có file); tạo `tutor_db` (`add-tutor-db.sql`); `docker builder prune -af` (đĩa 90% → 81%); build cả bộ image từng cái một (32 phút); migrate 7 database (tutor-service chạy tay; `migrate.sh` nay đã có nó); `up`; tắt chế độ bảo trì | Từ máy local: `firebase deploy --only database` (rules chặn mọi client, chỉ server đọc/ghi). Google provider đã bật, `app.timgiasu.date` có trong Authorized domains. `PAYOUT_MODE` để trống: chưa trả lương trên VPS (sandbox bị chặn khi `NODE_ENV=production`) |
| 2026-11-27 | Kiểm tra: 9 container app healthy; ghi/đọc/xóa thử một node trên Realtime Database thật từ container tutor-service; app 200, gateway `/health/ready` ok, CORS đúng; bundle frontend trỏ project Firebase thật, không có emulator | RAM trống khoảng 380 MB, swap dùng khoảng 1,5 GB lúc build |
