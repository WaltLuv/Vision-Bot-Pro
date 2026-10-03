#!/usr/bin/env bash
# Run Vision-Bot-Pro on this computer.
#
#     bash deploy/local.sh            (sets up on the first run, then just starts it)
#     bash deploy/local.sh --setup    (offers the optional extras again)
#
# The first run asks for what it needs and sets everything up; later runs just
# start it, asking only for something required that is missing. Nothing here needs root. Written for macOS and Linux.
#
# Who does the work -- whichever this computer has:
#   Claude Code, signed in with your own Claude subscription. You sign in
#     through Anthropic's own flow; Vision-Bot-Pro never sees, stores or
#     forwards the login, and only your own account's tasks are sent to it.
#   Hermes, installed on this computer, with the model you choose.
#   Hosted Claude, with an Anthropic API key.
# Everything else it can do -- talk and see, texts, calls, a browser you can
# watch -- is set up when you give it the keys, and skipped when you don't.
# Without a terminal (a script or an agent), put the answers in gateway/.env or
# the environment first; nothing is asked.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/gateway/.env"
DATA="$ROOT/data"
# The optional extras are offered on the first run, or when asked for. A later
# start that asked them all again, because some were skipped, was not "just start it".
OFFER_EXTRAS=false
if ! grep -q '^GATEWAY_TOKENS=' "$ENV_FILE" 2>/dev/null || [ "${1:-}" = "--setup" ]; then OFFER_EXTRAS=true; fi

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
bad()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; }
interactive() { [ -t 0 ]; }

# A setting's value: from gateway/.env if it is there, else from this shell.
keep() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
setting() { local v; v="$(keep "$1")"; [ -n "$v" ] || v="$(printenv "$1" 2>/dev/null || true)"; printf '%s' "$v"; }
# ask VAR "Question" [secret]: a value already known is kept; otherwise asked, in a terminal only.
ask() {
  local v; v="$(setting "$1")"
  if [ -z "$v" ] && interactive; then
    printf '  %s: ' "$2" >&2
    if [ -n "${3:-}" ]; then read -r -s v || v=""; printf '\n' >&2; else read -r v || v=""; fi
  fi
  printf '%s' "$v"
}
# offer VAR "Question" [secret]: like ask, for something optional -- asked only when extras are being offered.
offer() { if [ "$OFFER_EXTRAS" = true ]; then ask "$@"; else setting "$1"; fi; }
random() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('hex'))"; }

# --- what must already be here -------------------------------------------

say "Checking this computer"
command -v node >/dev/null || { bad "Node is not installed. Install Node 22 or newer (https://nodejs.org), then run this again."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { bad "Node $NODE_MAJOR is too old. Install Node 22 or newer, then run this again."; exit 1; }
command -v curl >/dev/null || { bad "curl is not installed. Install it, then run this again."; exit 1; }
info "Node $(node -v)"
mkdir -p "$DATA"; chmod 700 "$DATA"

# --- who does the work ------------------------------------------------------

# Claude Code, asked with the environment the app will give it: an API key in
# your shell must not make it look signed in when the app's copy would not be.
CLAUDE_BIN="$(setting CLAUDE_CODE_BIN)"
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then CLAUDE_BIN="$(command -v claude || true)"; fi
claude_env=(PATH="$PATH" HOME="$HOME")
for k in USER CLAUDE_CONFIG_DIR SSL_CERT_FILE SSL_CERT_DIR NODE_EXTRA_CA_CERTS HTTPS_PROXY HTTP_PROXY NO_PROXY; do
  v="$(printenv "$k" 2>/dev/null || true)"
  if [ -n "$v" ]; then claude_env+=("$k=$v"); fi
done
# Read the whole answer first: grep -q in a pipe can make a signed-in answer look
# like a failure under pipefail.
signed_in() {
  local out; out="$(env -i "${claude_env[@]}" "$CLAUDE_BIN" auth status --json 2>/dev/null || true)"
  case "$out" in *'"loggedIn": true'*|*'"loggedIn":true'*) return 0 ;; *) return 1 ;; esac
}

# Hermes: where it is installed and the Python it runs with.
HERMES_DIR="$(setting HERMES_CHECKOUT)"; HERMES_PY="$(setting HERMES_PYTHON)"
hermes_loads() { [ -n "$HERMES_DIR" ] && [ -n "$HERMES_PY" ] && "$HERMES_PY" -c "import sys; sys.path.insert(0, '$HERMES_DIR'); import run_agent" >/dev/null 2>&1; }
if ! hermes_loads && command -v hermes >/dev/null; then
  # The hermes command's own interpreter knows where Hermes is installed.
  shebang="$(head -1 "$(command -v hermes)" 2>/dev/null | sed 's/^#![[:space:]]*//')"
  case "$shebang" in */env\ *) HERMES_PY="$(command -v "${shebang##* }" || true)" ;; *) HERMES_PY="${shebang%% *}" ;; esac
  HERMES_DIR="$("$HERMES_PY" -c 'import os, run_agent; print(os.path.dirname(os.path.abspath(run_agent.__file__)))' 2>/dev/null || true)"
fi
if ! hermes_loads; then
  # Not into the folders macOS asks permission for, which would put a dialog up for each.
  found="$(find "$HOME" /opt -maxdepth 6 \( -path "$HOME/Library" -o -path "$HOME/Desktop" -o -path "$HOME/Documents" -o -path "$HOME/Downloads" \
    -o -path "$HOME/Pictures" -o -path "$HOME/Movies" -o -path "$HOME/Music" -o -name node_modules \) -prune -o -name run_agent.py -print 2>/dev/null | head -1 || true)"
  if [ -n "$found" ]; then
    HERMES_DIR="$(dirname "$found")"
    for candidate in "$HERMES_DIR/../../../bin/python" "$HERMES_DIR/.venv/bin/python" "$(command -v python3 || true)"; do
      if [ -x "$candidate" ]; then HERMES_PY="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"; if hermes_loads; then break; fi; fi
    done
  fi
fi
HERMES_OK=false; if hermes_loads; then HERMES_OK=true; fi

CHOICES=""
if [ -n "$CLAUDE_BIN" ]; then CHOICES="$CHOICES claude"; fi
if [ "$HERMES_OK" = true ]; then CHOICES="$CHOICES hermes"; fi
if [ -n "$(setting ANTHROPIC_API_KEY)" ]; then CHOICES="$CHOICES anthropic"; fi
CHOICES="${CHOICES# }"
RUNTIME="$(setting AGENT_RUNTIME)"
if [ -z "$RUNTIME" ]; then
  case "$CHOICES" in
    "")
      bad "Nothing on this computer can do the work yet. Any one of these will do:"
      info "- Claude Code, signed in with your Claude subscription (https://code.claude.com/docs/en/quickstart)"
      info "- Hermes installed on this computer (if it is somewhere unusual, set HERMES_CHECKOUT and HERMES_PYTHON)"
      info "- an Anthropic API key in ANTHROPIC_API_KEY"
      exit 1 ;;
    *" "*)
      RUNTIME="${CHOICES%% *}"
      if interactive; then printf '  Who should do the work -- type one of: %s [%s]: ' "$CHOICES" "$RUNTIME" >&2; read -r answer || answer=""; RUNTIME="${answer:-$RUNTIME}"; fi ;;
    *) RUNTIME="$CHOICES" ;;
  esac
fi

HP=""; HM=""; HB=""; HK=""; ANTHROPIC_KEY=""; OPENAI_KEY=""; OPENROUTER_KEY=""; GEMINI_KEY=""
case "$RUNTIME" in
  claude)
    [ -n "$CLAUDE_BIN" ] || { bad "AGENT_RUNTIME is claude, but Claude Code is not installed. Install it (https://code.claude.com/docs/en/quickstart) or set AGENT_RUNTIME in gateway/.env."; exit 1; }
    if ! signed_in; then
      say "Sign in to Claude Code with your Claude subscription"
      info "This opens Anthropic's own sign-in. Vision-Bot-Pro never sees your login."
      if interactive; then "$CLAUDE_BIN" auth login || true; fi
      signed_in || { bad "Claude Code is not signed in yet."; info "Run: claude auth login"; info "Then run this again."; exit 1; }
    fi
    WORK="Claude Code, with your own login" ;;
  hermes)
    [ "$HERMES_OK" = true ] || { bad "AGENT_RUNTIME is hermes, but Hermes was not found. Set HERMES_CHECKOUT (the folder holding run_agent.py) and HERMES_PYTHON, then run this again."; exit 1; }
    info "Hermes: $HERMES_DIR"
    # Hermes gets a home of its own here, so its model settings elsewhere on this computer do not apply.
    HP="$(ask HERMES_PROVIDER 'Model provider for Hermes (for example anthropic, gemini, openai-api, openrouter, or custom for a local model)')"
    HM="$(ask HERMES_MODEL 'Model name (for example claude-sonnet-5 or gemini-2.5-flash)')"
    case "$HP" in
      custom) HB="$(ask HERMES_BASE_URL 'Model endpoint (Ollama: http://127.0.0.1:11434/v1)')"; HK="$(ask HERMES_API_KEY 'Its key (any value if it takes none)' secret)" ;;
      anthropic) ANTHROPIC_KEY="$(ask ANTHROPIC_API_KEY 'Anthropic API key' secret)" ;;
      # One Gemini key serves both: already given for talking and seeing, it is not asked for again.
      gemini) GEMINI_KEY="$(setting GEMINI_API_KEY)"; [ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(setting GOOGLE_API_KEY)"
              [ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(ask GEMINI_API_KEY 'Gemini API key' secret)" ;;
      openai-api|openai) OPENAI_KEY="$(ask OPENAI_API_KEY 'OpenAI API key' secret)" ;;
      openrouter) OPENROUTER_KEY="$(ask OPENROUTER_API_KEY 'OpenRouter API key' secret)" ;;
      "") ;;
      *) HK="$(ask HERMES_API_KEY "API key for $HP" secret)" ;;
    esac
    [ -n "$HP" ] || info "No model provider named: Hermes picks one from the keys it is given."
    WORK="Hermes${HP:+ ($HP${HM:+, $HM})}" ;;
  anthropic)
    ANTHROPIC_KEY="$(ask ANTHROPIC_API_KEY 'Anthropic API key' secret)"
    [ -n "$ANTHROPIC_KEY" ] || { bad "AGENT_RUNTIME is anthropic, but there is no ANTHROPIC_API_KEY."; exit 1; }
    WORK="hosted Claude" ;;
  *) bad "AGENT_RUNTIME must be claude, hermes or anthropic, not \"$RUNTIME\"."; exit 1 ;;
esac
info "Work runs on: $WORK"

# --- everything else it can do ----------------------------------------------

if [ "$OFFER_EXTRAS" = true ]; then
  say "What else it can do"
  if interactive; then info "Leave any of these blank to skip it. Run this again with --setup to be asked again, or add it to gateway/.env."; fi
fi
[ -n "$GEMINI_KEY" ] || GEMINI_KEY="$(setting GEMINI_API_KEY)"
GOOGLE_KEY="$(setting GOOGLE_API_KEY)"
[ -n "$GOOGLE_KEY" ] || GOOGLE_KEY="$GEMINI_KEY"
[ -n "$GOOGLE_KEY" ] || GOOGLE_KEY="$(offer GOOGLE_API_KEY 'Gemini API key, so it can talk and see' secret)"
LK_URL="$(offer LIVEKIT_URL 'LiveKit URL, for the live voice and camera (wss://...)')"
LK_KEY=""; LK_SECRET=""
if [ -n "$LK_URL" ]; then LK_KEY="$(offer LIVEKIT_API_KEY 'LiveKit API key')"; LK_SECRET="$(offer LIVEKIT_API_SECRET 'LiveKit API secret' secret)"; fi
BB_KEY="$(offer BROWSERBASE_API_KEY 'Browserbase API key, for a browser you can watch and take over' secret)"
SEARCH_KEY="$(offer SEARCH_API_KEY 'Brave Search API key, so it can search the web' secret)"
TW_SID="$(offer TWILIO_ACCOUNT_SID 'Twilio account SID, for text messages')"
TW_TOKEN=""; TW_FROM=""
if [ -n "$TW_SID" ]; then TW_TOKEN="$(offer TWILIO_AUTH_TOKEN 'Twilio auth token' secret)"; TW_FROM="$(offer TWILIO_FROM 'Twilio number to send from (+1...)')"; fi
RT_KEY="$(offer RETELL_API_KEY 'Retell API key, for phone calls' secret)"
RT_FROM=""; RT_AGENT=""
if [ -n "$RT_KEY" ]; then RT_FROM="$(offer RETELL_FROM 'Retell number to call from (+1...)')"; RT_AGENT="$(offer RETELL_AGENT_ID 'Retell agent ID')"; fi
CK_PUB="$(offer CLERK_PUBLISHABLE_KEY 'Clerk publishable key, so people can sign in with Google (pk_...)')"
CK_SECRET=""; CK_OWNER=""; CK_ALLOWED=""
if [ -n "$CK_PUB" ]; then
  CK_SECRET="$(offer CLERK_SECRET_KEY 'Clerk secret key (sk_...)' secret)"
  CK_OWNER="$(offer CLERK_OWNER_EMAIL 'Your Google email (it signs in to this same employee)')"
  CK_ALLOWED="$(offer CLERK_ALLOWED_EMAILS 'Other Google accounts allowed in, comma-separated, each with an employee of its own (blank for none)')"
fi

VOICE=false
if [ -n "$LK_URL" ] && [ -n "$LK_KEY" ] && [ -n "$LK_SECRET" ] && [ -n "$GOOGLE_KEY" ]; then VOICE=true; fi

# --- settings -------------------------------------------------------------

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
# Texts that come in to your Twilio number are yours: without this they are dropped.
ROUTES="$(setting COMMUNICATION_ROUTES)"
if [ -z "$ROUTES" ] && [ -n "$TW_FROM" ]; then ROUTES="{\"$TW_FROM\":\"$OWNER\"}"; fi

# Anything else already in the file is kept exactly as it was.
MANAGED=" PORT HOST PUBLIC_BASE_URL GATEWAY_TOKENS STATE_SECRET GATEWAY_SERVICE_TOKEN REGISTRATION_OPEN STORE_PATH EMPLOYEE_DATA_DIR AGENT_RUNTIME CLAUDE_CODE_OWNER CLAUDE_CODE_BIN HERMES_CHECKOUT HERMES_PYTHON HERMES_PROVIDER HERMES_MODEL HERMES_BASE_URL HERMES_API_KEY ANTHROPIC_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY GEMINI_API_KEY GOOGLE_API_KEY LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET BROWSERBASE_API_KEY SEARCH_API_KEY TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN TWILIO_FROM COMMUNICATION_ROUTES RETELL_API_KEY RETELL_FROM RETELL_AGENT_ID CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY CLERK_OWNER_EMAIL CLERK_ALLOWED_EMAILS "
EXTRA=""
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    case "$MANAGED" in *" ${line%%=*} "*) ;; *) EXTRA="$EXTRA$line"$'\n' ;; esac
  done < "$ENV_FILE"
fi
# A setting is written when it has a value; empty ones are left out.
put() { if [ -n "$2" ]; then printf '%s=%s\n' "$1" "$2"; fi; }
[ -n "$HP" ] || HP="$(setting HERMES_PROVIDER)"; [ -n "$HM" ] || HM="$(setting HERMES_MODEL)"
[ -n "$HB" ] || HB="$(setting HERMES_BASE_URL)"; [ -n "$HK" ] || HK="$(setting HERMES_API_KEY)"
[ -n "$ANTHROPIC_KEY" ] || ANTHROPIC_KEY="$(setting ANTHROPIC_API_KEY)"
[ -n "$OPENAI_KEY" ] || OPENAI_KEY="$(setting OPENAI_API_KEY)"
[ -n "$OPENROUTER_KEY" ] || OPENROUTER_KEY="$(setting OPENROUTER_API_KEY)"

(
umask 077
{
  printf '# Written by deploy/local.sh. Private: it holds your access code, secrets and keys.\n\n'
  printf '# Open it at this address on this computer. HOST=127.0.0.1 keeps it off your\n# network; see README for reaching it from your phone.\n'
  put PORT "$PORT"; put HOST "$HOST"; put PUBLIC_BASE_URL "$BASE"
  printf '\n# Your access code is the part before the colon.\n'
  put GATEWAY_TOKENS "$TOKENS"; put REGISTRATION_OPEN "$REGISTRATION"
  put STATE_SECRET "$STATE_SECRET"; put GATEWAY_SERVICE_TOKEN "$SERVICE_TOKEN"
  put STORE_PATH "$STORE"; put EMPLOYEE_DATA_DIR "$EMPLOYEE_DATA"
  printf '\n# Who does the work.\n'
  put AGENT_RUNTIME "$RUNTIME"
  put CLAUDE_CODE_OWNER "$OWNER"; put CLAUDE_CODE_BIN "$CLAUDE_BIN"
  if [ "$HERMES_OK" = true ]; then put HERMES_CHECKOUT "$HERMES_DIR"; put HERMES_PYTHON "$HERMES_PY"; fi
  put HERMES_PROVIDER "$HP"; put HERMES_MODEL "$HM"; put HERMES_BASE_URL "$HB"; put HERMES_API_KEY "$HK"
  put ANTHROPIC_API_KEY "$ANTHROPIC_KEY"; put OPENAI_API_KEY "$OPENAI_KEY"; put OPENROUTER_API_KEY "$OPENROUTER_KEY"
  put GEMINI_API_KEY "$GEMINI_KEY"
  printf '\n# Talking and seeing, a browser, texts and calls.\n'
  put GOOGLE_API_KEY "$GOOGLE_KEY"
  put LIVEKIT_URL "$LK_URL"; put LIVEKIT_API_KEY "$LK_KEY"; put LIVEKIT_API_SECRET "$LK_SECRET"
  put BROWSERBASE_API_KEY "$BB_KEY"; put SEARCH_API_KEY "$SEARCH_KEY"
  put TWILIO_ACCOUNT_SID "$TW_SID"; put TWILIO_AUTH_TOKEN "$TW_TOKEN"; put TWILIO_FROM "$TW_FROM"; put COMMUNICATION_ROUTES "$ROUTES"
  put RETELL_API_KEY "$RT_KEY"; put RETELL_FROM "$RT_FROM"; put RETELL_AGENT_ID "$RT_AGENT"
  printf '\n# Signing in with Google, through Clerk.\n'
  put CLERK_PUBLISHABLE_KEY "$CK_PUB"; put CLERK_SECRET_KEY "$CK_SECRET"; put CLERK_OWNER_EMAIL "$CK_OWNER"; put CLERK_ALLOWED_EMAILS "$CK_ALLOWED"
  if [ -n "$EXTRA" ]; then printf '\n# Your other settings, kept as they were.\n%s' "$EXTRA"; fi
} > "$ENV_FILE"
)
chmod 600 "$ENV_FILE"
info "Saved to gateway/.env"

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
# The preview (the app on sample data, at /preview/) is a convenience: without it, everything else still works.
if (cd "$ROOT/web" && npm run build:demo) >>"$LOG" 2>&1; then info "preview built"; else info "The preview could not be built; everything else still works."; fi
if [ "$VOICE" = true ]; then
  # The voice worker needs Python 3.10 to 3.14. A Mac's own python3 is 3.9, so a newer one is looked for by name first.
  PY3=""
  for name in python3.12 python3.13 python3.11 python3.10 python3.14 python3; do
    candidate="$(command -v "$name" || true)"
    if [ -n "$candidate" ] && "$candidate" -c 'import sys; sys.exit(not (3, 10) <= sys.version_info[:2] < (3, 15))' >/dev/null 2>&1; then PY3="$candidate"; break; fi
  done
  if [ -z "$PY3" ]; then info "Talking needs Python 3.10 or newer (https://www.python.org/downloads/), which is not installed; everything else still works."; VOICE=false
  elif ! cmp -s "$ROOT/agent/requirements.txt" "$ROOT/agent/.venv/.vision-bot-installed" 2>/dev/null; then
    if { "$PY3" -m venv "$ROOT/agent/.venv" && "$ROOT/agent/.venv/bin/pip" install -q -r "$ROOT/agent/requirements.txt" && cp "$ROOT/agent/requirements.txt" "$ROOT/agent/.venv/.vision-bot-installed"; } >"$LOG" 2>&1; then info "voice worker ready"
    else bad "Setting up the voice worker failed; everything else still works:"; tail -n 10 "$LOG" >&2; VOICE=false; fi
  else info "voice worker ready"; fi
fi

# --- start ----------------------------------------------------------------

say "Starting Vision-Bot-Pro"
RUNLOG="$DATA/vision-bot.log"; VOICELOG="$DATA/voice-worker.log"
if curl -fsS --max-time 2 --noproxy '*' "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  bad "Something is already answering on port $PORT. Stop it (or set PORT in gateway/.env), then run this again."
  exit 1
fi
(cd "$ROOT/gateway" && exec node --import tsx src/server.ts) >>"$RUNLOG" 2>&1 &
PID=$!; WPID=""
stop_one() {
  kill -TERM "$1" 2>/dev/null || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$1" 2>/dev/null || return 0; sleep 0.5; done
  kill -KILL "$1" 2>/dev/null || true
}
stop() { if [ -n "$WPID" ]; then stop_one "$WPID"; fi; stop_one "$PID"; }
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

TALK="not set up (needs a Gemini key and LiveKit)"
if [ "$VOICE" = true ]; then
  # The worker gets only what it needs, not every key in gateway/.env.
  worker_env=(PATH="$PATH" HOME="$HOME" LIVEKIT_URL="$LK_URL" LIVEKIT_API_KEY="$LK_KEY" LIVEKIT_API_SECRET="$LK_SECRET" GOOGLE_API_KEY="$GOOGLE_KEY" GATEWAY_URL="http://127.0.0.1:$PORT" GATEWAY_SERVICE_TOKEN="$SERVICE_TOKEN")
  for k in GEMINI_MODEL GEMINI_VOICE QUICK_SEARCH_MODEL OPENAI_API_KEY OPENAI_REALTIME_MODEL ATTACH_VIEW_MODE HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy SSL_CERT_FILE REQUESTS_CA_BUNDLE; do
    v="$(setting "$k")"
    if [ -n "$v" ]; then worker_env+=("$k=$v"); fi
  done
  : > "$VOICELOG"
  (cd "$ROOT/agent" && exec env -i "${worker_env[@]}" "$ROOT/agent/.venv/bin/python" main.py start) >>"$VOICELOG" 2>&1 &
  WPID=$!
  TALK="starting..."
  for _ in $(seq 1 45); do
    if grep -q '"registered worker"' "$VOICELOG" 2>/dev/null; then TALK="on"; break; fi
    kill -0 "$WPID" 2>/dev/null || break
    sleep 1
  done
  if [ "$TALK" != on ]; then
    bad "The voice worker did not connect to LiveKit; everything else still works:"; tail -n 8 "$VOICELOG" >&2
    stop_one "$WPID"; WPID=""; TALK="not running (see data/voice-worker.log)"
  fi
fi

on() { if [ -n "$1" ]; then printf 'on'; else printf 'not set up'; fi; }
say "Vision-Bot-Pro is running"
printf '  Open          http://127.0.0.1:%s\n' "$PORT"
printf '  Access code   %s\n' "$CODE"
printf '  Work          %s\n' "$WORK"
printf '  Talk and see  %s\n' "$TALK"
printf '  Browser       %s\n' "$(on "$BB_KEY$(setting BROWSER_USE_API_KEY)")"
printf '  Web search    %s\n' "$(on "$SEARCH_KEY")"
printf '  Texts         %s\n' "$(on "$TW_TOKEN")"
printf '  Calls         %s\n' "$(on "$RT_KEY")"
printf '  Google login  %s\n' "$(on "$CK_SECRET")"
if [ -n "$TW_TOKEN$RT_KEY" ]; then
  case "$BASE" in
    https://*) ;;
    *) info "Texts and calls go out from here. Replies, delivery updates and call results come back only to a"
       info "public https address: set PUBLIC_BASE_URL to one (README: \"Texts and calls\")." ;;
  esac
fi
if [ -n "$WPID" ]; then printf '  Logs          data/vision-bot.log, data/voice-worker.log\n'; else printf '  Logs          data/vision-bot.log\n'; fi
printf '  Stop          Ctrl-C\n\n'
wait "$PID" || true
bad "Vision-Bot-Pro stopped by itself:"; tail -n 20 "$RUNLOG" >&2; stop; exit 1
