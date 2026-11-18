# Build from the repo root: docker build -f frontend/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @tms/frontend...
# NEXT_PUBLIC_* values are inlined at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8080/api
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @tms/frontend build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=5173 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/frontend/.next/standalone ./
COPY --from=build --chown=node:node /repo/frontend/.next/static ./frontend/.next/static
COPY --from=build --chown=node:node /repo/frontend/public ./frontend/public
USER node
EXPOSE 5173
CMD ["node", "frontend/server.js"]
