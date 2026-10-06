#!/usr/bin/env bash
# Set up the field agent on your VM.
#
# Run this on your VM, from the repository root:
#
#     sudo bash deploy/install.sh
#
# It is safe to run again: it keeps any answers you have already given and only
# fills in what is missing.
#
# Two things can do the thinking, and you can switch later by editing one line
# in .env:
#   Claude, hosted by Anthropic -- nothing to install, needs an API key.
#   Hermes, running on this machine -- nothing to pay for, needs to be installed.
#   Claude Code, on your own Claude subscription -- needs Claude Code installed
#     for the service user and signed in once.
#
# If you use Hermes it has to be on THIS machine: the gateway starts it as a
# local program, so it has to be able to see Hermes' files. That is also why
# this is not run in Docker -- a container cannot start a program on the host.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"
SERVICE_USER="${SERVICE_USER:-$(logname 2>/dev/null || echo root)}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
bad()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; }

# --- what must already be here -------------------------------------------

say "Checking this machine"

command -v curl >/dev/null || { bad "curl is not installed. Install it (sudo apt install -y curl), then run this again."; exit 1; }
command -v node >/dev/null || { bad "Node is not installed. Install Node 22 or newer, then run this again."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { bad "Node $NODE_MAJOR is too old. Install Node 22 or newer, then run this again."; exit 1; }
info "Node $(node -v)"

PY="${HERMES_PYTHON:-}"
command -v python3 >/dev/null || { bad "Python 3 is not installed."; exit 1; }
info "Python $(python3 -V 2>&1 | cut -d' ' -f2)"

# --- find Hermes ----------------------------------------------------------

say "Looking for a Hermes agent on this machine"

find_hermes() {
  # An installed Hermes has run_agent.py at the root of its package directory.
  for base in "${HERMES_CHECKOUT:-}" "$HOME" /opt /srv /home/*; do
    [ -n "$base" ] && [ -d "$base" ] || continue
    if [ -f "$base/run_agent.py" ]; then echo "$base"; return; fi
    found="$(find "$base" -maxdepth 6 -name run_agent.py -not -path '*/node_modules/*' 2>/dev/null | head -1 || true)"
    [ -n "$found" ] && { dirname "$found"; return; }
  done
}

# Not finding Hermes is not a failure. An owner who wants the hosted Claude
# brain should not have to install a second one to get through this script.
HERMES_DIR="${HERMES_CHECKOUT:-$(find_hermes || true)}"
HERMES_READY=false
if [ -n "$HERMES_DIR" ]; then
  if [ -z "$PY" ]; then
    # Prefer the interpreter of the environment Hermes is installed into.
    for candidate in "$HERMES_DIR/../../../bin/python" "$HERMES_DIR/.venv/bin/python" "$(command -v python3)"; do
      [ -x "$candidate" ] && { PY="$(cd "$(dirname "$candidate")" && pwd)/$(basename "$candidate")"; break; }
    done
  fi
  if "$PY" -c "import sys; sys.path.insert(0, '$HERMES_DIR'); import run_agent" 2>/dev/null; then
    HERMES_READY=true
    info "Hermes: $HERMES_DIR"
    info "It loads with $PY"
  else
    info "Found something at $HERMES_DIR, but it will not load with $PY."
    info "To use it, run again with HERMES_PYTHON set to the right interpreter."
    HERMES_DIR=""
  fi
else
  info "None on this machine. That is fine -- Claude needs nothing installed."
fi

# --- answers only you have ------------------------------------------------

ask() { # ask VAR "Question" [default]
  local var="$1" prompt="$2" default="${3:-}" current existing
  current="$(grep -E "^${var}=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true)"
  if [ -n "$current" ]; then echo "$current"; return; fi
  if [ -n "${!var:-}" ]; then echo "${!var}"; return; fi
  existing="$default"
  printf '  %s' "$prompt" >&2
  [ -n "$existing" ] && printf ' [%s]' "$existing" >&2
  printf ': ' >&2
  # With no terminal (a script or an agent running this), unanswered questions stay blank.
  read -r answer 2>/dev/null < /dev/tty || answer=""
  echo "${answer:-$existing}"
}

say "A few things only you know"
# Saved as PUBLIC_BASE_URL, so a second run reads it back from there.
DOMAIN="$(grep -E '^PUBLIC_BASE_URL=https://' "$ENV_FILE" 2>/dev/null | head -1 | cut -d/ -f3 || true)"
[ -n "$DOMAIN" ] || DOMAIN="$(ask PUBLIC_DOMAIN 'The web address you will open on your phone (e.g. agent.yourcompany.com)')"
[ -n "$DOMAIN" ] || { bad "A web address is required: phones only allow the camera and microphone over https."; exit 1; }
GEMINI_KEY="$(ask GOOGLE_API_KEY 'Your Google Gemini API key (for seeing and talking)')"
# Claude Code, for owners who want to use their own Claude subscription. It
# signs in through Anthropic's own flow and keeps its own login; this script
# and the app never see it.
CLAUDE_BIN="${CLAUDE_CODE_BIN:-$(sudo -u "$SERVICE_USER" -H bash -lc 'command -v claude' 2>/dev/null || true)}"
[ -n "$CLAUDE_BIN" ] && info "Claude Code: $CLAUDE_BIN"

if [ "$HERMES_READY" = true ] || [ -n "$CLAUDE_BIN" ]; then
  ANTHROPIC_KEY="$(ask ANTHROPIC_API_KEY 'Your Anthropic API key, for hosted Claude (blank to skip)')"
else
  ANTHROPIC_KEY="$(ask ANTHROPIC_API_KEY 'Your Anthropic API key, so Claude can do the work')"
fi

# Which brain does the work. Several can be set up; one runs at a time, and
# changing AGENT_RUNTIME in .env (then restarting) switches it.
CHOICES=""
[ -n "$ANTHROPIC_KEY" ] && CHOICES="$CHOICES anthropic"
[ "$HERMES_READY" = true ] && CHOICES="$CHOICES hermes"
[ -n "$CLAUDE_BIN" ] && CHOICES="$CHOICES claude"
CHOICES="${CHOICES# }"
case "$CHOICES" in
  "")
    bad "Nothing can do the work yet."
    info "Any one of these will do:"
    info "  - give an Anthropic API key when asked;"
    info "  - use your Claude subscription: install Claude Code for $SERVICE_USER"
    info "    (https://code.claude.com/docs/en/quickstart), then run this again;"
    info "  - install Hermes on this machine. For a Hermes in an unusual place:"
    info "    sudo HERMES_CHECKOUT=/opt/hermes/.venv/lib/python3.11/site-packages bash deploy/install.sh"
    exit 1 ;;
  *" "*)
    RUNTIME="$(ask AGENT_RUNTIME "Who should do the work -- type one of: $CHOICES" "${CHOICES%% *}")"
    case " $CHOICES " in *" $RUNTIME "*) ;; *) RUNTIME="${CHOICES%% *}"; info "Not one of the choices; using $RUNTIME." ;; esac ;;
  *) RUNTIME="$CHOICES" ;;
esac

if [ "$RUNTIME" = claude ]; then
  # Anthropic allows signing in to the unmodified Claude Code with your own
  # subscription; it does not allow an app to collect that login or to run
  # other people's requests on it. So the owner signs in themselves, here,
  # and only the owner's own tasks are sent to it (CLAUDE_CODE_OWNER).
  if sudo -u "$SERVICE_USER" -H "$CLAUDE_BIN" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    info "Claude Code is signed in."
  else
    info "Claude Code needs to be signed in to your Claude account, once."
    info "It opens Anthropic's own sign-in; this app never sees your login."
    printf '  Sign in now? [Y/n]: ' >&2; read -r yn < /dev/tty || yn=n
    case "$yn" in [nN]*) ;; *) sudo -u "$SERVICE_USER" -H "$CLAUDE_BIN" auth login < /dev/tty || true ;; esac
    sudo -u "$SERVICE_USER" -H "$CLAUDE_BIN" auth status --json 2>/dev/null | grep -q '"loggedIn": *true' \
      && info "Claude Code is signed in." \
      || info "Not signed in yet. Do it any time with: sudo -u $SERVICE_USER -H $CLAUDE_BIN auth login"
  fi
fi
info "Work goes to: $RUNTIME"
LK_URL="$(ask LIVEKIT_URL 'LiveKit URL (leave blank to set up voice later)')"
LK_KEY="$(ask LIVEKIT_API_KEY 'LiveKit API key (blank to skip)')"
LK_SECRET="$(ask LIVEKIT_API_SECRET 'LiveKit API secret (blank to skip)')"
BB_KEY="$(ask BROWSERBASE_API_KEY 'Browserbase API key, so your employee can use a web browser you can watch and take over (blank to skip)')"

# --- write the settings ---------------------------------------------------

say "Writing settings"

keep() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- || true; }
ACCESS_CODE="$(keep GATEWAY_TOKENS)"; ACCESS_CODE="${ACCESS_CODE%%:*}"
[ -n "$ACCESS_CODE" ] || ACCESS_CODE="$(openssl rand -hex 8)"
STATE_SECRET="$(keep STATE_SECRET)"; [ -n "$STATE_SECRET" ] || STATE_SECRET="$(openssl rand -hex 32)"
SERVICE_TOKEN="$(keep GATEWAY_SERVICE_TOKEN)"; [ -n "$SERVICE_TOKEN" ] || SERVICE_TOKEN="$(openssl rand -hex 32)"
# Encrypts saved retailer sign-ins on disk. Kept across runs: a new one forgets them.
VAULT_KEY="$(keep SIGNIN_VAULT_KEY)"; [ -n "$VAULT_KEY" ] || VAULT_KEY="$(openssl rand -hex 32)"

# Anything added by hand -- a model provider for Hermes, text messages,
# suppliers -- is kept as it was. Only the settings below are rewritten.
MANAGED=" GATEWAY_TOKENS PUBLIC_BASE_URL PORT NODE_ENV REGISTRATION_OPEN STATE_SECRET GATEWAY_SERVICE_TOKEN SIGNIN_VAULT_KEY STORE_PATH EMPLOYEE_DATA_DIR AGENT_RUNTIME ANTHROPIC_API_KEY HERMES_CHECKOUT HERMES_PYTHON CLAUDE_CODE_BIN CLAUDE_CODE_OWNER GOOGLE_API_KEY GEMINI_API_KEY LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET BROWSERBASE_API_KEY GATEWAY_URL "
EXTRA=""
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
    case "$MANAGED" in *" ${line%%=*} "*) ;; *) EXTRA="$EXTRA$line"$'\n' ;; esac
  done < "$ENV_FILE"
fi

umask 077
cat > "$ENV_FILE" <<ENVEOF
# Written by deploy/install.sh. Keep this file private: it holds your keys.

# Your access code. This is what you type into the app on your phone.
GATEWAY_TOKENS=$ACCESS_CODE:owner
PUBLIC_BASE_URL=https://$DOMAIN
PORT=8788
NODE_ENV=production

# Nobody else can sign themselves up.
REGISTRATION_OPEN=false

STATE_SECRET=$STATE_SECRET
GATEWAY_SERVICE_TOKEN=$SERVICE_TOKEN
SIGNIN_VAULT_KEY=$VAULT_KEY
STORE_PATH=$ROOT/data/store.json
EMPLOYEE_DATA_DIR=$ROOT/data

# Who does the work: anthropic, hermes or claude. Change this line and
# restart (sudo systemctl restart fieldagent) to switch.
AGENT_RUNTIME=$RUNTIME

# Claude, hosted by Anthropic.
ANTHROPIC_API_KEY=$ANTHROPIC_KEY

# Hermes, running on this machine.
HERMES_CHECKOUT=$HERMES_DIR
HERMES_PYTHON=$PY

# Claude Code, signed in with your own Claude subscription. Only your own
# tasks may run on it: a subscription is for one person.
CLAUDE_CODE_BIN=$CLAUDE_BIN
CLAUDE_CODE_OWNER=owner

# Gemini gives it eyes and a voice.
GOOGLE_API_KEY=$GEMINI_KEY
GEMINI_API_KEY=$GEMINI_KEY

LIVEKIT_URL=$LK_URL
LIVEKIT_API_KEY=$LK_KEY
LIVEKIT_API_SECRET=$LK_SECRET

# A web browser your employee can use, and you can watch and take over.
BROWSERBASE_API_KEY=$BB_KEY

# How the voice worker calls back in.
GATEWAY_URL=http://127.0.0.1:8788
ENVEOF
if [ -n "$EXTRA" ]; then printf '\n# Your other settings, kept as they were.\n%s' "$EXTRA" >> "$ENV_FILE"; fi
chmod 600 "$ENV_FILE"
# Private to the person the services run as, so doctor.sh works without sudo.
chown "$SERVICE_USER" "$ENV_FILE" 2>/dev/null || true
# Only the settings file is private. What is built next has to be readable by
# the services, which do not run as root.
umask 022
info "Saved to $ENV_FILE"

# --- build ----------------------------------------------------------------

say "Building the app"
# Development packages are needed to run: the gateway starts through tsx and
# the phone app is built with vite. Optional ones too: sharp, which checks
# every photo, ships its Linux binary as one, and without it nothing starts.
LOG="$(mktemp)"
if ! (cd "$ROOT/gateway" && npm ci --include=dev --include=optional --no-audit --no-fund) >"$LOG" 2>&1; then
  bad "Installing the gateway failed:"; tail -n 20 "$LOG" >&2; exit 1
fi
info "gateway ready"
if ! (cd "$ROOT/web" && npm ci --include=dev --no-audit --no-fund && npm run build) >"$LOG" 2>&1; then
  bad "Building the phone app failed:"; tail -n 20 "$LOG" >&2; exit 1
fi
info "phone app built"
rm -f "$LOG"
# An earlier run may have left these readable by root alone.
chmod -R a+rX "$ROOT/gateway/node_modules" "$ROOT/web/dist" 2>/dev/null || true

if [ -n "$LK_URL" ]; then
  say "Setting up the voice worker"
  # $PY is Hermes' interpreter, and there may not be a Hermes here. The voice
  # worker only needs a Python 3, so fall back to this machine's own.
  "${PY:-$(command -v python3)}" -m venv "$ROOT/agent/.venv" 2>/dev/null || true
  if [ -x "$ROOT/agent/.venv/bin/pip" ] && "$ROOT/agent/.venv/bin/pip" install -q -r "$ROOT/agent/requirements.txt"; then
    info "voice worker ready"
  else
    bad "Could not set up the voice worker. Talking out loud will not work yet."
    info "Everything else is still being installed. Run deploy/doctor.sh afterwards."
  fi
fi

mkdir -p "$ROOT/data"
chown -R "$SERVICE_USER" "$ROOT/data" 2>/dev/null || true
# Tasks, memory and evidence: for the service alone.
chmod 700 "$ROOT/data"

# --- run it on boot -------------------------------------------------------

say "Installing services"

unit() { # unit NAME DESCRIPTION WORKDIR COMMAND
  cat > "/etc/systemd/system/$1.service" <<UNITEOF
[Unit]
Description=$2
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$3
EnvironmentFile=$ENV_FILE
ExecStart=$4
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNITEOF
}

unit fieldagent "Field agent gateway" "$ROOT/gateway" "$(command -v npm) start"
systemctl daemon-reload
# Restart, not just start: on a second run the new code and settings have to load.
systemctl enable fieldagent >/dev/null 2>&1
systemctl restart fieldagent
# Started is not the same as working: wait until it answers.
for _ in $(seq 1 45); do
  curl -fsS --max-time 2 --noproxy '*' http://127.0.0.1:8788/health >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS --max-time 2 --noproxy '*' http://127.0.0.1:8788/health >/dev/null 2>&1; then info "gateway running"
else bad "The gateway did not start. See why with: sudo journalctl -u fieldagent -n 40"; exit 1; fi

if [ -n "$LK_URL" ]; then
  unit fieldagent-voice "Field agent voice worker" "$ROOT/agent" "$ROOT/agent/.venv/bin/python main.py start"
  systemctl daemon-reload
  systemctl enable fieldagent-voice >/dev/null 2>&1
  systemctl restart fieldagent-voice
  info "voice worker running"
fi

# --- https ----------------------------------------------------------------

CADDYFILE=/etc/caddy/Caddyfile
if command -v caddy >/dev/null; then
  say "Turning on https"
  SITE="$DOMAIN {
  reverse_proxy 127.0.0.1:8788
}"
  if grep -qF "$DOMAIN {" "$CADDYFILE" 2>/dev/null; then
    info "https was already set up for $DOMAIN"
  else
    # Other sites this server already serves are kept: the stock example file
    # is replaced, anything else gets this site added. The old file is kept
    # beside it, and put back if Caddy will not accept the result.
    OTHER="$(grep -vE '^[[:space:]]*(#|$)' "$CADDYFILE" 2>/dev/null | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -vxE ':80 \{|root \* /usr/share/caddy|file_server|\}' || true)"
    mkdir -p "$(dirname "$CADDYFILE")"
    BACKED_UP=false
    if [ -f "$CADDYFILE" ]; then cp -p "$CADDYFILE" "$CADDYFILE.before-visionclaw"; BACKED_UP=true; fi
    if [ -n "$OTHER" ]; then printf '\n%s\n' "$SITE" >> "$CADDYFILE"; else printf '%s\n' "$SITE" > "$CADDYFILE"; fi
    if caddy validate --config "$CADDYFILE" --adapter caddyfile >/dev/null 2>&1; then
      systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true
      info "https on for $DOMAIN"
    else
      if [ "$BACKED_UP" = true ]; then cp -p "$CADDYFILE.before-visionclaw" "$CADDYFILE"; else rm -f "$CADDYFILE"; fi
      bad "Caddy would not accept its settings with this site added, so they were left as they were."
      info "Add this to $CADDYFILE yourself, then: sudo systemctl reload caddy"
      printf '%s\n' "$SITE"
    fi
  fi
else
  say "One thing left: https"
  info "Phones only allow the camera and microphone over https."
  info "Install Caddy and run this again, and it will do the rest:"
  info "  sudo apt install -y caddy"
fi

# --- done -----------------------------------------------------------------

say "Done"
printf '  Open   https://%s on your phone\n' "$DOMAIN"
printf '  Code   %s\n\n' "$ACCESS_CODE"
info "Check everything is connected:  bash deploy/doctor.sh"
