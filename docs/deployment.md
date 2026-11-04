# Deployment: web on Vercel, API on Railway

```
Browser ──► Vercel (apps/web, Next.js)
              │  /api/v1/*  proxied by next.config.ts rewrites
              ▼
            Railway ── api (apps/api, NestJS + Chromium) ──► postgres (Postgres 18)
                                                         └─► redis
            S3-compatible storage (Railway Bucket or Cloudflare R2), SMTP provider
```

The browser only talks to the Vercel domain. The web app proxies every `/api/v1` request to the API, so the Better Auth session cookie is first-party. If the browser called the API's own domain instead, browsers that block cross-site cookies (Safari, Firefox strict mode) would drop the session and sign-in would silently fail.

`apps/worker` has no processors yet, so it is not deployed.

## 1. Railway: Postgres

1. Create a Railway project from the `school-management-system-v2` GitHub repo, then add a service from the same repo and name it `postgres`.
2. **Settings → Config-as-code → Railway config file:** `infra/postgres/railway.json`. Leave the root directory empty (the repo root).
3. **Volumes:** attach a volume mounted at `/var/lib/postgresql`. Postgres 18 keeps its cluster in a versioned subdirectory of that path.
4. **Variables** (generate each password with `openssl rand -base64 24`, or Railway's `${{secret(32)}}`):

   | Variable | Value |
   | --- | --- |
   | `POSTGRES_USER` | `sms_owner` |
   | `POSTGRES_PASSWORD` | a generated password (owner: migrations only) |
   | `POSTGRES_DB` | `sms` |
   | `SMS_APP_PASSWORD` | a different generated password (the API's runtime role) |

On first boot, the init scripts create `sms_app` with `SMS_APP_PASSWORD`, without `BYPASSRLS`, plus the required extensions. The database refuses to initialise if that variable is missing. The init scripts only run on an empty volume, so changing these variables later does not change the existing roles.

Postgres stays on Railway's private network. A TCP proxy is only needed to connect from your own machine.

## 2. Railway: Redis

Add Railway's **Redis** database template. Nothing else is needed.

## 3. Storage and email

- **Files:** create a Railway **Bucket** or a Cloudflare **R2** bucket and keep the endpoint, region, bucket name, access key, and secret key.
- **Email:** any SMTP provider. For Resend, use `SMTP_URL=smtps://resend:<API key>@smtp.resend.com:465`. The sender domain must be verified with the provider.

## 4. Railway: API

1. Add another service from the repo and name it `api`.
2. **Settings → Config-as-code → Railway config file:** `apps/api/railway.json`. Leave the root directory empty.
3. **Networking:** generate a public domain, for example `sms-api-production.up.railway.app`. The Vercel project needs it in step 5.
4. **Variables** (`${{…}}` references resolve inside Railway):

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `postgres://sms_app:${{postgres.SMS_APP_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/sms` |
   | `DATABASE_MIGRATION_URL` | `postgres://sms_owner:${{postgres.POSTGRES_PASSWORD}}@${{postgres.RAILWAY_PRIVATE_DOMAIN}}:5432/sms` |
   | `REDIS_URL` | `${{Redis.REDIS_URL}}?family=0` (`family=0` lets ioredis use Railway's IPv6 private network) |
   | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` | from step 3 |
   | `S3_FORCE_PATH_STYLE` | `true` for R2; follow the provider's guidance otherwise |
   | `SMTP_URL`, `MAIL_FROM` | from step 3, e.g. `MAIL_FROM="Greenwood School <no-reply@yourdomain>"` |
   | `AUTH_SECRET` | `openssl rand -base64 32` |
   | `APP_URL` | the web app's URL, e.g. `https://sms-web.vercel.app` |
   | `API_URL` | **the same web app URL.** Browsers reach auth through the proxy, so the web origin is the auth origin. |
   | `SMS_PROVIDER`, `WHATSAPP_PROVIDER`, `PAYMENTS_PROVIDER` | `console` until real providers are configured |
   | `LOG_LEVEL` | `info` |

The image installs Chromium for PDF rendering. Each start runs the migrations first; they are idempotent. Railway marks a deploy healthy once `/api/v1/health` reports Postgres and Redis up.

## 5. Vercel: web

1. **Add New → Project**, import `school-management-system-v2`.
2. **Root Directory:** `apps/web` (keep "Include files outside the root directory" enabled). The framework is detected as Next.js, and pnpm installs the whole workspace.
3. **Environment variables:**

   | Variable | Value |
   | --- | --- |
   | `API_ORIGIN` | the Railway API domain from step 4, e.g. `https://sms-api-production.up.railway.app` |
   | `ENABLE_EXPERIMENTAL_COREPACK` | `1` (uses the `pnpm@11` pinned in `packageManager`) |

4. Deploy. Node 24 comes from `engines` in `apps/web/package.json`.

After the first deploy, copy the production URL into the API's `APP_URL` and `API_URL` if they differ, then redeploy the API.

`API_ORIGIN` is read at build time. Redeploy the web app whenever it changes.

## 6. Optional: demo data

`pnpm db:seed` loads the demo tenant (`greenwood`) and its demo logins. Run it once, from the API service's shell (`railway ssh --service api`) or locally with the Railway variables (`railway run --service api pnpm db:seed`). Do not seed a database that will hold real school data.

## Checks

- `https://<api domain>/api/v1/health` returns `"status":"ok"`.
- `https://<web domain>/system` shows Postgres and Redis as up. That page calls the API through the proxy.
- Sign in on the web domain. The session cookie belongs to the web domain, not the API domain.
