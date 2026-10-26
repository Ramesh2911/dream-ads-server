#!/usr/bin/env bash
set -euo pipefail

# cPanel HTTPS deploy for dream-ads-server (backend, Express).
# Required env: CPANEL_SSO_EMAIL, CPANEL_SSO_PASSWORD (WHMCS client credentials)
# Artifacts expected in cwd: package.json, package-lock.json, dist/ (tsc build)
#
# NOTE: run-script `tar` extracts land in the CageFS-cached view and are NOT
# visible to the live lsnode worker — code MUST be pushed via the Fileman API
# (cPanel's own writes), then the app restarted. Verified empirically 2026-10-27.

CPANEL_HOST="${CPANEL_HOST:-server.shodns.in:2083}"
WHMCS_URL="${WHMCS_URL:-https://manage.shohost.com}"
WHMCS_PRODUCT_ID="${WHMCS_PRODUCT_ID:-2942}"
CPANEL_HOME="${CPANEL_HOME:-/home/dreamads}"
APP_ROOT="${APP_ROOT:-backend}"
REMOTE_DIR="${CPANEL_HOME}/${APP_ROOT}"
DIST="${DIST:-dist}"
VERIFY_URL="${VERIFY_URL:-https://dreamads.in/api/health}"
VERIFY_GREP="${VERIFY_GREP:-\"status\": *\"ok\"}"
MARKER_URL="${MARKER_URL:-https://dreamads.in/api/deploy-marker}"

: "${CPANEL_SSO_EMAIL:?CPANEL_SSO_EMAIL is required}"
: "${CPANEL_SSO_PASSWORD:?CPANEL_SSO_PASSWORD is required}"

JAR="$(mktemp)"
BODY="$(mktemp)"
trap 'rm -f "$JAR" "$BODY"' EXIT

log() { echo "[deploy] $*"; }
die() { echo "::error::$*"; exit 1; }

login() {
  local token url cpsess
  token=$(curl -fsS -c "$JAR" -b "$JAR" "$WHMCS_URL/index.php/login" \
    | grep -o 'name="token" value="[^"]*"' | head -1 | sed 's/.*value="//; s/"$//' || true)
  [ -n "$token" ] || die "WHMCS CSRF token not found"
  curl -fsS -c "$JAR" -b "$JAR" -X POST "$WHMCS_URL/index.php/login" \
    --data-urlencode "username=$CPANEL_SSO_EMAIL" \
    --data-urlencode "password=$CPANEL_SSO_PASSWORD" \
    --data "token=${token}&submit=+" -o /dev/null
  url=$(curl -sL -c "$JAR" -b "$JAR" \
    "$WHMCS_URL/clientarea.php?action=productdetails&id=${WHMCS_PRODUCT_ID}&dosinglesignon=1&app=FileManager_Home" \
    -o /dev/null -w '%{url_effective}')
  cpsess=$(grep -o 'cpsess[0-9]*' <<<"$url" | head -1 || true)
  [ -n "$cpsess" ] || die "cPanel SSO did not yield a session (final url: $url)"
  BASE="https://${CPANEL_HOST}/${cpsess}"
  curl -fsS -b "$JAR" "$BASE/execute/Fileman/list_files?dir=${CPANEL_HOME}" | grep -q '"status": *1' \
    || die "cPanel API auth check failed"
  log "cPanel session: $cpsess"
}

upload() { # <local-path> <remote-filename> <remote-dir>
  local resp reason
  # plain in-place overwrite. NEVER delete first: cPanel's delete is async (trash
  # queue) and can eat the freshly re-uploaded file moments later. Overwrite is
  # reliable for these paths (verified live via deploy-marker).
  resp=$(curl -fsS --retry 3 --retry-delay 2 -b "$JAR" -X POST "$BASE/execute/Fileman/upload_files" \
    -F "dir=$3" -F "file=@$1;filename=$2" -F overwrite=1)
  jq -e '.data.succeeded >= 1 and .data.failed == 0' <<<"$resp" >/dev/null \
    || die "upload of $2 failed: $resp"
  reason=$(jq -r '.data.uploads[0].reason // "no-reason"' <<<"$resp")
  log "uploaded $3/$2 ($reason)"
}

ensure_dir() { # <absolute-remote-dir>
  local parent name
  parent=$(dirname "$1")
  name=$(basename "$1")
  curl -s -b "$JAR" \
    "$BASE/json-api/cpanel?api.version=2&cpanel_jsonapi_module=Fileman&cpanel_jsonapi_func=mkdir&dir=$(printf '%s' "$parent" | jq -sRr @uri)&name=$name" \
    -o /dev/null || true
}

cgi() { # <form-body>
  curl -fsS -b "$JAR" -X POST \
    "$BASE/3rdparty/cloudlinux/cloudlinux-selector.cgi?cgiaction=sendRequest" \
    -H 'Content-Type: application/x-www-form-urlencoded' --data "$1"
}

run_script() { # <script-name>
  local resp decoded rc
  resp=$(cgi "command=cloudlinux-selector&method=run-script&params%5Binterpreter%5D=nodejs&params%5Bapp-root%5D=${APP_ROOT}&params%5Bscript-name%5D=$1")
  decoded=$(jq -r '.data // empty' <<<"$resp" | base64 -d 2>/dev/null || true)
  [ -n "$decoded" ] || die "run-script $1 returned no data: $resp"
  printf '%s\n' "$decoded"
  rc=$(grep -oE 'returncode: *[0-9]+' <<<"$decoded" | grep -oE '[0-9]+' | head -1 || true)
  [ "${rc:-1}" = "0" ] || die "run-script $1 returned rc=${rc:-unknown}"
}

restart_app() {
  local resp
  resp=$(cgi "command=cloudlinux-selector&method=restart&params%5Binterpreter%5D=nodejs&params%5Bapp-root%5D=${APP_ROOT}")
  log "restart: $resp"
  case "$resp" in
    *'"result":"error"'*|*Exception*|*Traceback*) die "restart failed: $resp" ;;
  esac
}

verify() {
  local i code body
  for i in $(seq 1 20); do
    code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 30 "$VERIFY_URL" || true)
    body=$(cat "$BODY" 2>/dev/null || true)
    if [ "$code" = "200" ] && grep -q "$VERIFY_GREP" <<<"$body"; then
      log "verify OK: $VERIFY_URL -> $body"
      return 0
    fi
    log "verify attempt $i: http=$code"
    sleep 6
  done
  die "verification failed for $VERIFY_URL"
}

verify_marker() {
  local i code body
  for i in $(seq 1 10); do
    code=$(curl -s -o "$BODY" -w '%{http_code}' --max-time 30 "$MARKER_URL" || true)
    body=$(cat "$BODY" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      log "marker OK: $MARKER_URL -> $body"
      return 0
    fi
    log "marker attempt $i: http=$code (worker respawning...)"
    sleep 6
  done
  die "deploy-marker not live — new code did not reach the worker"
}

main() {
  [ -d "$DIST" ] || die "dist/ not found — run npm run build first"
  login
  ensure_dir "$REMOTE_DIR"
  # configs first (npm install reads package.json/lock)
  upload package.json package.json "$REMOTE_DIR"
  upload package-lock.json package-lock.json "$REMOTE_DIR"
  # every dist file via Fileman (delete -> fresh create)
  while IFS= read -r f; do
    rel="${f#"$DIST"/}"
    reldir=$(dirname "$rel")
    if [ "$reldir" = "." ]; then
      upload "$f" "$rel" "$REMOTE_DIR/$DIST"
    else
      ensure_dir "$REMOTE_DIR/$DIST/$reldir"
      upload "$f" "$(basename "$rel")" "$REMOTE_DIR/$DIST/$reldir"
    fi
  done < <(find "$DIST" -type f | LC_ALL=C sort)
  run_script setup
  sleep 3
  restart_app
  verify
  verify_marker
  log "deploy complete"
}

main "$@"
