#!/usr/bin/env bash
# Build the image, run it, and check /health, a real transform, and the container healthcheck.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=image-api:smoke
NAME=image-api-smoke
PORT=${PORT:-3998}
SAMPLE='https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png'

docker build -q -t "$IMAGE" . >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "$PORT:3000" "$IMAGE" >/dev/null
trap 'docker rm -f "$NAME" >/dev/null' EXIT

for _ in $(seq 20); do curl -sf "localhost:$PORT/health" >/dev/null && break; sleep 0.5; done
echo "health:  $(curl -s "localhost:$PORT/health")"
curl -s -o /dev/null -w "process: %{http_code} %{content_type} %{size_download}B\n" \
  "localhost:$PORT/process?url=$SAMPLE&width=200&format=webp"
echo "blocked: $(curl -s "localhost:$PORT/process?url=http://169.254.169.254/")"

for _ in $(seq 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' "$NAME")
  [ "$status" != starting ] && break; sleep 1
done
echo "docker healthcheck: $status"
docker images "$IMAGE" --format 'image size: {{.Size}}'
