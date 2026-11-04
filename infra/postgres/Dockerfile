# Postgres 18 for Railway. Build from the repo root:
#   docker build -f infra/postgres/Dockerfile .
# The migrations need 18 (native uuidv7()), and the init scripts create the
# sms_app role that the API connects as - local dev mounts the same scripts
# through docker-compose instead.
FROM postgres:18-alpine
COPY infra/postgres/init/ /docker-entrypoint-initdb.d/
COPY --chmod=755 infra/postgres/production/02-app-role-password.sh /docker-entrypoint-initdb.d/
