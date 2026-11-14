# syntax=docker/dockerfile:1
# Otherbridge V1.5 staging-equivalent image: one image for app, Data API, workers and ops exporter.
# Multi-stage, lockfile-frozen, install scripts disabled, production dependencies only at runtime,
# runs as the unprivileged `node` user on a read-only root filesystem (see compose.yaml).
ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 CI=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install -g pnpm@11.25.0 --ignore-scripts --no-audit --no-fund && npm cache clean --force
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY swap-providers ./swap-providers
RUN pnpm --dir swap-providers install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN pnpm build && rm -rf .next/cache

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --prod
COPY swap-providers ./swap-providers
RUN pnpm --dir swap-providers install --frozen-lockfile --ignore-scripts --prod

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/swap-providers ./swap-providers
COPY --from=build /app/.next ./.next
COPY package.json next.config.ts tsconfig.json ./
COPY public ./public
COPY content ./content
COPY src ./src
COPY services ./services
COPY scripts ./scripts
COPY tests ./tests
COPY docs ./docs
COPY release ./release
COPY .env.example AGENTS.md CLAUDE.md GOAL_OTHERBRIDGE_V1_7_G7_CONTROLLED_PILOT_PREP_ONLY.md pnpm-lock.yaml pnpm-workspace.yaml ./
COPY .otherbridge/g7-protected-baseline.txt ./.otherbridge/g7-protected-baseline.txt
COPY evidence/otherbridge-v1-12-1/owner-security-20261014T140240767Z ./evidence/otherbridge-v1-12-1/owner-security-20261014T140240767Z
# Files stay root-owned and read-only for the runtime user.
USER node
EXPOSE 3101 3200
STOPSIGNAL SIGTERM
CMD ["node", "scripts/next-pinned.mjs", "start", "--hostname", "0.0.0.0", "--port", "3101"]
