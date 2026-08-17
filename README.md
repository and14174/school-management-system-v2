# School Management System

A multi-tenant Student Information System, built as a **modular monolith**: one deployable API, one Postgres, split internally into modules with hard boundaries.

Architecture, module map and delivery plan: [docs/phase-1-architecture.html](docs/phase-1-architecture.html) — open it in a browser.

**Before changing anything load-bearing, read [docs/decisions.md](docs/decisions.md).** It records the non-obvious calls (RLS session scoping, privilege levels of the three transaction helpers, fail-closed permission scopes, CORS gotchas that curl cannot see) and what breaks if they are undone.

## Status

| Milestone | State |
| --- | --- |
| **M0** foundation — kernel, db, API, design system, app shell | done |
| **M1a** audit + tenancy — history trigger, scope triple, RLS | done |
| **M1b** identity — Better Auth, memberships, sign-in, 2FA | done |
| **M1c** access — roles, scoped permissions, field masking, impersonation | done |
| **M2** people + academic structure + directory UI | done |
| **M3** enrollment lifecycle, CSV import, import wizard | done |
| **M4** scheduling/timetabling, transactional outbox, attendance | in progress |
| M5+ | not started |

Sign in locally with `admin@greenwood.test` / `Passw0rd!demo` (created by `pnpm db:seed`).

`teacher@greenwood.test` / `Passw0rd!demo` signs in as a teacher and sees only
their own sections, students and timetable — `section` scope resolving through
the port `@sms/academic` implements for `@sms/access`.

## Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| Node.js | >= 24 | |
| pnpm | 11.x | `npm i -g pnpm` |
| Docker Desktop | 29.x | WSL2 backend, daemon must be running |
| Git | 2.x | |

## Getting started

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # postgres, redis, minio, mailpit
pnpm db:migrate        # every module's migrations, in order
pnpm db:seed           # Greenwood International + the demo admin
pnpm dev               # api :3333 · web :3000
```

Then open http://localhost:3000 and sign in.

## Checks

```bash
pnpm check             # lint + typecheck + test + check:db
pnpm check:db          # architecture checks against the live database
```

`check:db` is not optional tooling — it is what stops tenant isolation and audit
coverage silently regressing. See [docs/decisions.md](docs/decisions.md).

## Local services

| URL | What |
| --- | --- |
| `localhost:5432` | Postgres 18 — `sms` database |
| `localhost:6379` | Redis 8 — BullMQ queues, ability cache, rate limits |
| `localhost:9001` | MinIO console — `minioadmin` / `minioadmin` |
| `localhost:8025` | Mailpit — catches every outbound email |

Once the apps exist they will run on `localhost:3000` (web), `localhost:3333` (API) and `localhost:3333/docs` (OpenAPI).

## Database roles

Two roles, deliberately:

- **`sms_owner`** owns the schemas and runs migrations.
- **`sms_app`** is what the API connects as — no table ownership, no `BYPASSRLS`.

Row-level security does not apply to superusers or table owners. If the API connects as the owner, every RLS policy silently does nothing. Keep the split.

## Workspace layout

```
apps/
  api/      NestJS modular monolith
  web/      Next.js — admin, teacher, parent, student, applicant portals
  worker/   BullMQ processors + transactional outbox dispatcher
libs/
  platform/ tenancy, identity, access, audit, files, notifications, …
  domain/   people, enrollment, attendance, gradebook, …
  shared/   kernel, db, ui
infra/      docker-compose + Postgres init
docs/       architecture plan
```

## Commands

```bash
pnpm infra:up        # start local services
pnpm infra:down      # stop them
pnpm infra:reset     # stop and destroy volumes (wipes local data)
```

## Windows notes

- Keep the repo on the Windows filesystem; don't split it half into WSL.
- `git config --global core.autocrlf input` before committing.
- Add this folder to Windows Defender exclusions — `node_modules` scanning roughly doubles install and build times.
