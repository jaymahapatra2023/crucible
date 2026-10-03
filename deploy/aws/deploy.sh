#!/usr/bin/env bash
# Deploy or update Crucible on the EC2 host (docs/DEPLOYMENT_AWS.md, "Deploying").
#
#   sudo -u ec2-user /opt/crucible/repo/deploy/aws/deploy.sh <git-ref>
#
# 1. Checks out the requested ref of the repository into /opt/crucible/repo.
# 2. Writes /opt/crucible/.env from the Secrets Manager secret named in CRUCIBLE_SECRET_ID
#    (a JSON object of KEY: value) — the only place secrets ever land on disk, mode 600.
# 3. Builds both images on the host, runs migrations, and restarts the stack.
#
# Idempotent: re-running with the same ref rebuilds from cache and changes nothing.
set -euo pipefail

REF="${1:-main}"
APP_DIR="${APP_DIR:-/opt/crucible}"
REPO_DIR="${APP_DIR}/repo"
REPO_URL="${CRUCIBLE_REPO_URL:?set CRUCIBLE_REPO_URL to the git remote}"
SECRET_ID="${CRUCIBLE_SECRET_ID:?set CRUCIBLE_SECRET_ID to the Secrets Manager secret name}"
REGION="${AWS_REGION:-$(curl -s -H "X-aws-ec2-metadata-token: $(curl -s -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60')" http://169.254.169.254/latest/meta-data/placement/region)}"

echo "== source ${REPO_URL} @ ${REF}"
if [ ! -d "${REPO_DIR}/.git" ]; then
  git clone --quiet "${REPO_URL}" "${REPO_DIR}"
fi
git -C "${REPO_DIR}" fetch --quiet --tags origin
git -C "${REPO_DIR}" checkout --quiet --force "${REF}"
git -C "${REPO_DIR}" pull --quiet --ff-only origin "${REF}" 2>/dev/null || true
SHA="$(git -C "${REPO_DIR}" rev-parse --short HEAD)"

echo "== secrets from ${SECRET_ID} (${REGION})"
umask 077
aws secretsmanager get-secret-value --region "${REGION}" --secret-id "${SECRET_ID}" --query SecretString --output text \
  | jq -r 'to_entries[] | "\(.key)=\(.value)"' > "${APP_DIR}/.env.next"
# Bootstrap-only keys the image sets itself are not expected in the secret; anything else the
# API validates at boot and refuses with the key named.
mv "${APP_DIR}/.env.next" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
umask 022

: "${SITE_ADDRESS:?set SITE_ADDRESS (public hostname) in the environment or the secret}"

echo "== build ${SHA}"
cd "${REPO_DIR}"
export CRUCIBLE_IMAGE_API="crucible-api:${SHA}"
export CRUCIBLE_IMAGE_WEB="crucible-web:${SHA}"
docker build --target api -t "${CRUCIBLE_IMAGE_API}" .
docker build --target web -t "${CRUCIBLE_IMAGE_WEB}" .
docker tag "${CRUCIBLE_IMAGE_API}" crucible-api:current
docker tag "${CRUCIBLE_IMAGE_WEB}" crucible-web:current

echo "== migrate + restart"
cp docker-compose.yml "${APP_DIR}/docker-compose.yml"
cd "${APP_DIR}"
# Migrations run first and alone; the api service waits on their success.
docker compose run --rm migrate
docker compose up -d --remove-orphans
docker compose ps

echo "== health"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1/ready" >/dev/null 2>&1 || curl -fsSk "https://127.0.0.1/ready" -H "Host: ${SITE_ADDRESS}" >/dev/null 2>&1; then
    echo "ready (${SHA})"; exit 0
  fi
  sleep 2
done
echo "API did not become ready; see: docker compose logs api" >&2
exit 1
