#!/bin/sh
# Runs once, after 01-roles-and-extensions.sql, on a fresh volume. That script
# creates sms_app with the local-dev password; a deployed database replaces it
# with SMS_APP_PASSWORD and refuses to initialise without one.
set -eu

if [ -z "${SMS_APP_PASSWORD:-}" ]; then
  echo 'SMS_APP_PASSWORD must be set to initialise a deployed database.' >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -v app_password="$SMS_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
ALTER ROLE sms_app WITH PASSWORD :'app_password';
SQL
