#!/usr/bin/env bash
# Release to the droplet: copy the compose files, pull the newest images, restart.
# Push to main first and wait for the "Build & push images" workflow.
#
#   ./deploy/deploy.sh                 latest
#   TAG=sha-abc1234 ./deploy/deploy.sh   a specific build (rollback)

set -euo pipefail

HOST="${DEPLOY_HOST:-deploy@159.89.160.225}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/battery_iot_droplet}"
DIR=/opt/battery-iot
TAG="${TAG:-latest}"

cd "$(dirname "$0")"
scp -i "$KEY" docker-compose.yml Caddyfile "$HOST:$DIR/"
ssh -i "$KEY" "$HOST" "cd $DIR && export TAG=$TAG && docker compose pull && docker compose up -d --remove-orphans && docker image prune -f && docker compose ps"
