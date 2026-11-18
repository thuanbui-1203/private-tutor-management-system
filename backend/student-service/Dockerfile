# Build from the repo root: docker build -f backend/student-service/Dockerfile .
FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @tms/student-service...
RUN pnpm --filter @tms/student-service... build
RUN pnpm --filter @tms/student-service deploy --prod /out

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out .
USER node
EXPOSE 3002
CMD ["node", "dist/main.js"]
