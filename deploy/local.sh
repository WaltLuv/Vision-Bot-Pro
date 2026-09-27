#!/usr/bin/env bash
# Run Vision-Bot-Pro on this computer, with your own Claude subscription doing the
# work through Claude Code.
#
#     bash deploy/local.sh
#
# The first run sets everything up; later runs just start it. Nothing here
# needs root. Works on macOS and Linux.
#
# Your Claude login stays with Claude Code: you sign in through Anthropic's own
# flow, and Vision-Bot-Pro never sees, stores or forwards it. A subscription is for
# one person, so only your own account's tasks are sent to it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/gateway/.env"
DATA="$ROOT/data"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
bad()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; }

# --- what must already be here -------------------------------------------

say "Checking this computer"
command -v node >/dev/null || { bad "Node is not installed. Install Node 22 or newer (https://nodejs.org), then run this again."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { bad "Node $NODE_MAJOR is too old. Install Node 22 or newer, then run this again."; exit 1; }
command -v curl >/dev/null || { bad "curl is not installed. Install it, then run this again."; exit 1; }
info "Node $(node -v)"

CLAUDE_BIN="${CLAUDE_CODE_BIN:-$(command -v claude || true)}"
if [ -z "$CLAUDE_BIN" ]; then
  bad "Claude Code is not installed."
  info "Install it (https://code.claude.com/docs/en/quickstart), then run this again."
  exit 1
fi
info "Claude Code: $CLAUDE_BIN"

# Ask Claude Code itself, with the same environment the app will give it: an
# API key in your shell must not make this look signed in when the app's
# copy of Claude Code would not be.
claude_env=(PATH="$PATH" HOME="$HOME")
for k in USER CLAUDE_CONFIG_DIR SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTPS_PROXY HTTP_PROXY NO_PROXY; do
  v="$(printenv "$k" 2>/dev/null || true)"
  if [ -n "$v" ]; then claude_env+=("$k=$v"); fi
done
signed_in() { env -i "${claude_env[@]}" "$CLAUDE_BIN" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; }

if ! signed_in; then
  say "Sign in to Claude Code with your Claude subscription"
  info "This opens Anthropic's own sign-in. Vision-Bot-Pro never sees your login."
  if [ -t 0 ]; then "$CLAUDE_BIN" auth login || true; fi
  if ! signed_in; then
    bad "Claude Code is not signed in yet."
    info "Run: claude auth login"
    info "Then run this again."
    exit 1
  fi
fi
info "Signed in: work will run on your Claude subscription"

# --- settings -------------------------------------------------------------

say "Settings"
mkdir -p "$DATA"; chmod 700 "$DATA"
keep() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

PORT="$(keep PORT)"; PORT="${PORT:-8788}"
HOST="$(keep HOST)"; HOST="${HOST:-127.0.0.1}"
BASE="$(keep PUBLIC_BASE_URL)"
case "$BASE" in ""|*example.com*) BASE="http://127.0.0.1:$PORT" ;; esac
TOKENS="$(keep GATEWAY_TOKENS)"
case "$TOKENS" in ""|change-me-token:*) TOKENS="$(random 8):owner" ;; esac
FIRST="${TOKENS%%,*}"; CODE="${FIRST%%:*}"; OWNER="${FIRST#*:}"
STATE_SECRET="$(keep STATE_SECRET)"
case "$STATE_SECRET" in ""|generate-a-random-string) STATE_SECRET="$(random 32)" ;; esac
SERVICE_TOKEN="$(keep GATEWAY_SERVICE_TOKEN)"; SERVICE_TOKEN="${SERVICE_TOKEN:-$(random 32)}"
REGISTRATION="$(keep REGISTRATION_OPEN)"; REGISTRATION="${REGISTRATION:-false}"
STORE="$(keep STORE_PATH)"; STORE="${STORE:-$DATA/store.json}"
EMPLOYEE_DATA="$(keep EMPLOYEE_DATA_DIR)"; EMPLOYEE_DATA="${EMPLOYEE_DATA:-$DATA}"
RUNTIME="$(keep AGENT_RUNTIME)"; RUNTIME="${RUNTIME:-claude}"

# Anything else already in the file is kept exactly as it was.
MANAGED=" PORT HOST PUBLIC_BASE_URL GATEWAY_TOKENS STATE_SECRET GATEWAY_SERVICE_TOKEN REGISTRATION_OPEN STORE_PATH EMPLOYEE_DATA_DIR AGENT_RUNTIME CLAUDE_CODE_OWNER CLAUDE_CODE_BIN "
EXTRA=""
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    case "$MANAGED" in *" ${line%%=*} "*) ;; *) EXTRA="$EXTRA$line"$'\n' ;; esac
  done < "$ENV_FILE"
fi

(
umask 077
cat > "$ENV_FILE" <<ENVEOF
# Written by deploy/local.sh. Private: it holds your access code and secrets.

# Open it at this address on this computer. HOST=127.0.0.1 keeps it off your
# network; see README for reaching it from your phone.
PORT=$PORT
HOST=$HOST
PUBLIC_BASE_URL=$BASE

# Your access code is the part before the colon.
GATEWAY_TOKENS=$TOKENS
REGISTRATION_OPEN=$REGISTRATION
STATE_SECRET=$STATE_SECRET
GATEWAY_SERVICE_TOKEN=$SERVICE_TOKEN
STORE_PATH=$STORE
EMPLOYEE_DATA_DIR=$EMPLOYEE_DATA

# Work runs on Claude Code, signed in with your own Claude subscription. Only
# this account's tasks may use it.
AGENT_RUNTIME=$RUNTIME
CLAUDE_CODE_OWNER=$OWNER
CLAUDE_CODE_BIN=$CLAUDE_BIN
ENVEOF
if [ -n "$EXTRA" ]; then printf '\n# Your other settings, kept as they were.\n%s' "$EXTRA" >> "$ENV_FILE"; fi
)
chmod 600 "$ENV_FILE"
info "Saved to gateway/.env"
[ "$RUNTIME" = claude ] || info "Note: AGENT_RUNTIME is $RUNTIME, so work does not run on your Claude subscription. Set AGENT_RUNTIME=claude in gateway/.env to change that."

# --- build ----------------------------------------------------------------

say "Building"
LOG="$DATA/setup.log"
# Packages are reinstalled only when their lock file changed. Development
# packages are needed to run (tsx, vite); optional ones too: sharp ships its
# platform binary as one, and without it nothing starts.
install_deps() { # install_deps DIR ARGS...
  local dir="$1"; shift
  if cmp -s "$dir/package-lock.json" "$dir/node_modules/.vision-bot-installed" 2>/dev/null; then return 0; fi
  (cd "$dir" && npm ci --include=dev "$@" --no-audit --no-fund && cp package-lock.json node_modules/.vision-bot-installed)
}
if ! install_deps "$ROOT/gateway" --include=optional >"$LOG" 2>&1; then bad "Installing the gateway failed:"; tail -n 20 "$LOG" >&2; exit 1; fi
info "gateway ready"
if ! { install_deps "$ROOT/web" && (cd "$ROOT/web" && npm run build); } >"$LOG" 2>&1; then bad "Building the app failed:"; tail -n 20 "$LOG" >&2; exit 1; fi
info "app built"

# --- start ----------------------------------------------------------------

say "Starting Vision-Bot-Pro"
RUNLOG="$DATA/vision-bot.log"
if curl -fsS --max-time 2 --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  bad "Something is already answering on port $PORT. Stop it (or set PORT in gateway/.env), then run this again."
  exit 1
fi
(cd "$ROOT/gateway" && exec node --import tsx src/server.ts) >>"$RUNLOG" 2>&1 &
PID=$!
stop() {
  kill -TERM "$PID" 2>/dev/null || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$PID" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$PID" 2>/dev/null || true
}
trap 'stop; printf "\nStopped.\n"; exit 0' INT TERM

up=false
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then up=true; break; fi
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if [ "$up" != true ]; then
  bad "Vision-Bot-Pro did not start:"; tail -n 30 "$RUNLOG" >&2; stop; exit 1
fi

say "Vision-Bot-Pro is running"
printf '  Open         http://127.0.0.1:%s\n' "$PORT"
printf '  Access code  %s\n' "$CODE"
printf '  Work runs on your Claude subscription, through Claude Code\n'
printf '  Logs         data/vision-bot.log\n'
printf '  Stop         Ctrl-C\n\n'
info "Voice, a browser you can watch and phone access are optional; README says how."
wait "$PID" || true
bad "Vision-Bot-Pro stopped by itself:"; tail -n 20 "$RUNLOG" >&2; exit 1
