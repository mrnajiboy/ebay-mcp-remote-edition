#!/usr/bin/env bash
set -euo pipefail

if [[ "${ENABLE_NOVNC:-false}" != "true" && "${ENABLE_NOVNC:-false}" != "1" ]]; then
  exec pnpm run start:http
fi

DISPLAY_NUMBER="${NOVNC_DISPLAY:-99}"
export DISPLAY="${DISPLAY:-:${DISPLAY_NUMBER}}"
SCREEN_GEOMETRY="${NOVNC_SCREEN_GEOMETRY:-1440x1000x24}"
VNC_HOST="${NOVNC_VNC_HOST:-127.0.0.1}"
VNC_PORT="${NOVNC_VNC_PORT:-5900}"
NOVNC_HOST="${NOVNC_HOST:-0.0.0.0}"
NOVNC_PORT="${NOVNC_PORT:-6081}"
PASSWORD_FILE="${NOVNC_PASSWORD_FILE:-/tmp/novnc-vnc-password}"
NOVNC_WEB_DIR="${NOVNC_WEB_DIR:-/usr/share/novnc}"

mkdir -p "$(dirname "$PASSWORD_FILE")"
if [[ -n "${NOVNC_VNC_PASSWORD:-}" ]]; then
  printf '%s' "${NOVNC_VNC_PASSWORD}" > "$PASSWORD_FILE"
elif [[ ! -s "$PASSWORD_FILE" ]]; then
  # Generate a per-container password when one is not injected. The admin API can
  # read this file and show it only behind x-admin-api-key.
  python3 - <<'PY' > "$PASSWORD_FILE"
import secrets, string
alphabet = string.ascii_letters + string.digits
print(''.join(secrets.choice(alphabet) for _ in range(18)), end='')
PY
fi
chmod 600 "$PASSWORD_FILE"

Xvfb "$DISPLAY" -screen 0 "$SCREEN_GEOMETRY" -nolisten tcp &
XVFB_PID=$!

x11vnc -display "$DISPLAY" -listen "$VNC_HOST" -rfbport "$VNC_PORT" -passwdfile "$PASSWORD_FILE" -forever -shared -noxdamage -quiet &
X11VNC_PID=$!

websockify --web "$NOVNC_WEB_DIR" "${NOVNC_HOST}:${NOVNC_PORT}" "${VNC_HOST}:${VNC_PORT}" &
WEBSOCKIFY_PID=$!

cleanup() {
  kill "$WEBSOCKIFY_PID" "$X11VNC_PID" "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[novnc] DISPLAY=$DISPLAY geometry=$SCREEN_GEOMETRY vnc=${VNC_HOST}:${VNC_PORT} novnc=${NOVNC_HOST}:${NOVNC_PORT} passwordFile=$PASSWORD_FILE"
exec pnpm run start:http
