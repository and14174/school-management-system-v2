-- Runs once, on first creation of the db volume.
--
-- Two roles, deliberately:
--   sms_owner  owns the schemas and runs migrations (created by the image from POSTGRES_USER)
--   sms_app    is what the API connects as - NO table ownership, NO BYPASSRLS
--
-- Row-level security does not apply to superusers or table owners. If the API
-- connects as the owner, every RLS policy silently does nothing. This split is
-- the whole reason tenant isolation holds.

CREATE ROLE sms_app WITH LOGIN PASSWORD 'dev' NOBYPASSRLS;

GRANT CONNECT ON DATABASE sms TO sms_app;

-- Extensions used by the platform:
--   pg_trgm    fuzzy duplicate detection on people (names, contacts)
--   unaccent   normalised match keys across locales
--   btree_gist temporal exclusion constraints on effective-dated rows
--   pgcrypto   digests for import row hashing and match keys
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
