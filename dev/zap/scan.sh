#!/usr/bin/env bash
# Runs ZAP's passive baseline scan against a disposable ytdl-material container.
#
#   dev/zap/scan.sh <ytdl-material image>
#
# The container starts with the image's default settings, so the scan sees what a
# visitor to a fresh install sees. Rules in rules.tsv beside this script are handled
# as recorded there after review; any other warning fails the scan. Reports go to
# ZAP_REPORT_DIR (default: a new temporary directory). ZAP_IMAGE defaults to the
# image pinned in the ZAP workflow.
set -euo pipefail

image="${1:?usage: dev/zap/scan.sh <ytdl-material image>}"
here="$(cd "$(dirname "$0")" && pwd)"
zap_image="${ZAP_IMAGE:-$(sed -n 's/^ *ZAP_IMAGE: //p' "$here/../../.github/workflows/zap.yml")}"
reports="${ZAP_REPORT_DIR:-$(mktemp -d)}"
id="ytdl-zap-$$"
app="$id-app"

# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  docker rm --force "$app" "$id" >/dev/null 2>&1 || true
  docker volume rm "$id" >/dev/null 2>&1 || true
  docker network rm "$id" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$id" >/dev/null
docker run --detach --name "$app" --network "$id" "$image" >/dev/null

# The server listens only once startup has finished, and /healthz answers from then on.
healthy() {
  docker exec "$app" curl -fsS -o /dev/null http://localhost:17442/healthz >/dev/null 2>&1
}
for _ in $(seq 90); do
  healthy && break
  sleep 2
done
if ! healthy; then
  docker logs "$app" >&2
  echo "ytdl-material did not start." >&2
  exit 1
fi

# ZAP reads its rules from, and writes reports to, /zap/wrk, as its own user.
# Files go in and out through containers, which works with rootless Docker too.
docker volume create "$id" >/dev/null
docker run --rm --interactive --volume "$id:/zap/wrk" --user 0 --entrypoint sh "$zap_image" \
  -c 'cat >/zap/wrk/rules.tsv && chmod 0777 /zap/wrk' <"$here/rules.tsv"
# -silent keeps ZAP to the rules in its pinned image, with no add-on updates.
status=0
docker run --rm --name "$id" --network "$id" --volume "$id:/zap/wrk" "$zap_image" \
  zap-baseline.py -t "http://$app:17442/" -m 1 -z -silent -c rules.tsv -J report.json -r report.html || status=$?
mkdir -p "$reports"
docker run --rm --volume "$id:/zap/wrk:ro" --entrypoint tar "$zap_image" -C /zap/wrk -cf - . | tar -xf - -C "$reports" || true
echo "Reports: $reports"
if [ "$status" -ne 0 ]; then
  echo "ZAP exited with $status: 1 or 2 means findings, 3 an error during the scan." >&2
fi
exit "$status"
