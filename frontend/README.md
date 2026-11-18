# @tms/frontend

Next.js (App Router) web app for the Tutor Management System. It talks only to the API gateway, never to a backend service directly.

```bash
pnpm --filter @tms/frontend dev     # http://localhost:5173
pnpm --filter @tms/frontend build
```

Set `NEXT_PUBLIC_API_URL` (for example `http://localhost:8080/api`) in `frontend/.env.local`.

Docker: `docker build -f frontend/Dockerfile .` from the repo root.
