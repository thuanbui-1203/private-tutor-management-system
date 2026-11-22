# Demo recorder

Quay video từng luồng end-to-end của TMS (frontend thật + các service thật), mỗi luồng một file trong `recordings/`.

- Stack riêng `tms-e2e` (DB riêng, Firebase Auth Emulator, cổng 2xxxx), không đụng project Firebase thật.
- Dữ liệu nền của mỗi luồng tạo qua API (ngoài khung hình); mọi thứ trên màn hình là thao tác UI thật.
- Tua thời gian (hạn 7 ngày, chốt tháng) dùng test hook `/internal/test/*`, có chú thích trên video.

## Chạy lại (Git Bash, từ thư mục gốc repo)

```bash
export COMPOSE_BAKE=false
git show HEAD:docker-compose.yml > tools/demo-recorder/base.compose.yml
C="docker compose -p tms-e2e --project-directory . -f tools/demo-recorder/base.compose.yml -f docker-compose.e2e.yml -f tools/demo-recorder/docker-compose.demo.yml"
$C down -v && $C up -d --wait --no-build postgres rabbitmq redis firebase-emulator
# migration: như scripts/e2e.mjs (DATABASE_URL trỏ 127.0.0.1:25432)
$C up -d --wait --no-build identity-service student-service class-service schedule-service billing-service api-gateway
docker exec tms-e2e-identity-service-1 node dist/seed.js        # admin@tms.local / Admin@123

# frontend trỏ vào stack demo, cổng 5175
cd frontend && NEXT_DIST_DIR=.next-demo NEXT_PUBLIC_API_URL=http://127.0.0.1:28080/api \
  NEXT_PUBLIC_FIREBASE_API_KEY=demo-key NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=demo-tms.firebaseapp.com \
  NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-tms NEXT_PUBLIC_FIREBASE_APP_ID=demo-app \
  NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:29099 pnpm exec next build
NEXT_DIST_DIR=.next-demo pnpm exec next start -p 5175 &   # cd .. sau đó

# quay (tất cả, hoặc -g "05-" cho một luồng)
NODE_PATH=frontend/node_modules node frontend/node_modules/@playwright/test/cli.js \
  test -c tools/demo-recorder/playwright.config.ts
# webm → mp4
for f in recordings/*.webm; do ffmpeg -y -i "$f" -c:v libx264 -crf 22 -pix_fmt yuv420p "${f%.webm}.mp4"; done
```

Dọn: `$C down -v`, xóa `frontend/.next-demo`.
