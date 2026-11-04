# API image for Railway (or any container host). Build from the repo root:
#   docker build -f apps/api/Dockerfile .
# The @sms/* libraries are TypeScript source with Nest decorators, so the API
# runs through tsx in production exactly as in dev - see `start:prod`.
FROM node:24-bookworm-slim

ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Manifests first, so dependency layers are cached until a package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY libs libs
RUN pnpm install --frozen-lockfile

# Chromium (and its system libraries) for PDF rendering in @sms/documents.
RUN pnpm exec playwright install --with-deps chromium

COPY tsconfig.base.json ./
COPY apps/api apps/api

ENV NODE_ENV=production PORT=3333
EXPOSE 3333

# Migrations are idempotent (platform.__migrations), so every start applies
# anything new before the API begins serving.
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @sms/api start:prod"]
