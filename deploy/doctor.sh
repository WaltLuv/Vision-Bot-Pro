#!/usr/bin/env bash
# Tells you what is working and what is not, in plain words.
#
#     bash deploy/doctor.sh          (checks only; uses nothing from any plan)
#     bash deploy/doctor.sh --live   (also tries the things that cost a little:
#                                     one tiny task, one Gemini answer, one search)
#
# It works for a server install (deploy/install.sh) and for one on your own
# computer (deploy/local.sh). Run it before you show the app to anyone.
set -uo pipefail
LIVE=0; [ "${1:-}" = "--live" ] && LIVE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"; LOCAL=0
# deploy/local.sh keeps its settings beside the gateway instead.
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT/gateway/.env" ]; then ENV_FILE="$ROOT/gateway/.env"; LOCAL=1; fi
PROBLEMS=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no()   { printf '  \033[31m✗\033[0m %s\n' "$*"; PROBLEMS=$((PROBLEMS+1)); }
meh()  { printf '  \033[33m–\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$*"; }
# A quiet request that only says whether it worked. Never prints a key.
probe() { curl -fsS --max-time 15 -o /dev/null "$@" 2>/dev/null; }

[ -f "$ENV_FILE" ] || { printf '\nNo settings yet. On this computer run: bash deploy/local.sh\nOn a server run: sudo bash deploy/install.sh\n\n'; exit 1; }
# Read it the way systemd reads it for the services: literally, one KEY=value
# per line. Running it as shell would expand any "$" in a key or password.
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in [A-Za-z_]*=*) ;; *) continue ;; esac
  key="${line%%=*}"; val="${line#*=}"
  case "$key" in *[!A-Za-z0-9_]*) continue ;; esac
  case "$val" in \"*\") val="${val#\"}"; val="${val%\"}" ;; \'*\') val="${val#\'}"; val="${val%\'}" ;; esac
  export "$key=$val"
done < "$ENV_FILE"
GEMINI_KEY="${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}"
APP="http://127.0.0.1:${PORT:-8788}"
CODE="${GATEWAY_TOKENS:-}"; CODE="${CODE%%,*}"; CODE="${CODE%%:*}"

head_ "Your agent"
if [ "$LOCAL" = 1 ]; then
  if probe --noproxy "127.0.0.1,localhost" "$APP/health"; then ok "running on this computer"
  else no "not running — start it with: bash deploy/local.sh"; fi
else
  if systemctl is-active --quiet fieldagent 2>/dev/null; then ok "running"
  else no "not running — start it with: sudo systemctl start fieldagent"; fi
  if probe --noproxy "127.0.0.1,localhost" "$APP/health"; then ok "answering"
  else no "not answering — see what went wrong with: sudo journalctl -u fieldagent -n 40"; fi
fi

head_ "The app on your phone"
if [ -f "$ROOT/web/dist/index.html" ]; then ok "built"
else no "not built — run: cd web && npm ci && npm run build"; fi
case "${PUBLIC_BASE_URL:-}" in
  https://*)
    if probe "$PUBLIC_BASE_URL/health"; then ok "reachable at $PUBLIC_BASE_URL"
    else no "cannot reach $PUBLIC_BASE_URL from here — check https and your domain"; fi
    ok "https on (the camera and microphone need this)" ;;
  "") [ "$LOCAL" = 1 ] || no "PUBLIC_BASE_URL is not set" ;;
  *)
    if [ "$LOCAL" = 1 ]; then meh "on your phone, open a private https address such as Tailscale Serve (README: \"From your phone\"); the camera and microphone need https"
    else no "not https — phones will refuse the camera and microphone"; fi ;;
esac

head_ "The brain, which does the work"
# Only the selected one has to be working. Reporting a missing Hermes as a
# problem on a machine that runs Claude sends the owner off fixing nothing.
if [ "${AGENT_RUNTIME:-anthropic}" = "hermes" ]; then
  if [ -n "${HERMES_CHECKOUT:-}" ] && [ -f "$HERMES_CHECKOUT/run_agent.py" ]; then
    ok "set to Hermes, found at $HERMES_CHECKOUT"
    if "${HERMES_PYTHON:-python3}" -c "import sys; sys.path.insert(0,'$HERMES_CHECKOUT'); import run_agent" 2>/dev/null; then ok "it loads"
    else no "it will not load with ${HERMES_PYTHON:-python3} — set HERMES_PYTHON to the right interpreter"; fi
    # Hermes gets its own home per owner here, so its settings elsewhere on this machine do not apply.
    if [ -n "${HERMES_PROVIDER:-}" ]; then ok "model provider: $HERMES_PROVIDER${HERMES_MODEL:+, model $HERMES_MODEL}"
    else meh "no model provider named — set HERMES_PROVIDER and HERMES_MODEL in .env, or Hermes picks one from the keys it is given"; fi
    [ "${HERMES_PROVIDER:-}" = "gemini" ] && meh "it thinks with Gemini, so it needs the Gemini credit checked below"
  else
    no "set to Hermes, but it is not on this machine — set HERMES_CHECKOUT to the folder holding run_agent.py"
  fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] && meh "Claude is set up too — switch with AGENT_RUNTIME=anthropic in .env"
elif [ "${AGENT_RUNTIME:-anthropic}" = "claude" ]; then
  # Claude Code keeps its own login in the service user's home, so ask it as
  # that user. The app never reads the login; neither does this script.
  SVC=""; [ "$LOCAL" = 1 ] || SVC="$(systemctl show -p User --value fieldagent 2>/dev/null)"; SVC="${SVC:-$(id -un)}"
  as_svc() { if [ "$(id -un)" = "$SVC" ]; then "$@"; else sudo -u "$SVC" -H "$@"; fi; }
  BIN="${CLAUDE_CODE_BIN:-claude}"
  if ! as_svc "$BIN" --version >/dev/null 2>&1; then
    no "set to Claude Code, but it is not installed for $SVC — see https://code.claude.com/docs/en/quickstart"
  elif ! as_svc "$BIN" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
    if [ "$LOCAL" = 1 ]; then no "set to Claude Code, but it is not signed in — run: $BIN auth login"
    else no "set to Claude Code, but it is not signed in — run: sudo -u $SVC -H $BIN auth login"; fi
  else
    ok "set to Claude Code, signed in with your Claude subscription"
    if [ -n "${CLAUDE_CODE_OWNER:-}" ]; then ok "only $CLAUDE_CODE_OWNER's tasks run on it (a subscription is for one person)"
    else no "CLAUDE_CODE_OWNER is not set, so no task can use it — add CLAUDE_CODE_OWNER=owner to .env"; fi
    if [ "$LIVE" = 1 ]; then
      if (cd /tmp && as_svc "$BIN" -p 'Reply with exactly: OK' --tools '' --strict-mcp-config --no-session-persistence --output-format json 2>/dev/null) | grep -q '"result": *"OK'; then ok "answered a live test"
      else no "did not answer a live test — try: $BIN -p hello"; fi
    else
      meh "to try it for real (uses a little of your plan): bash deploy/doctor.sh --live"
    fi
  fi
  [ -n "${ANTHROPIC_API_KEY:-}" ] && meh "hosted Claude is set up too — switch with AGENT_RUNTIME=anthropic in .env"
else
  # A key that is merely present is not a key that works. This asks Anthropic.
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    no "set to Claude, but there is no key — add ANTHROPIC_API_KEY to .env, or set AGENT_RUNTIME=hermes"
  elif probe -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01" "${ANTHROPIC_BASE_URL:-https://api.anthropic.com}/v1/models"; then
    ok "set to Claude, hosted by Anthropic"
    ok "the key works"
  else
    no "set to Claude, but the key was refused or Anthropic cannot be reached from this machine"
  fi
  [ -n "${HERMES_CHECKOUT:-}" ] && meh "Hermes is set up too — switch with AGENT_RUNTIME=hermes in .env"
fi

head_ "Gemini, which lets it see and talk"
GEMINI_API="${GEMINI_API_BASE:-https://generativelanguage.googleapis.com/v1beta}"
if [ -z "$GEMINI_KEY" ]; then
  if [ -n "${LIVEKIT_URL:-}" ]; then no "no key — add GOOGLE_API_KEY to .env"; else meh "no key — voice, Google search and store prices need one"; fi
elif ! probe -H "x-goog-api-key: $GEMINI_KEY" "$GEMINI_API/models?pageSize=1"; then
  no "Gemini refused the key, or cannot be reached from this machine"
else
  ok "the key works"
  if [ "$LIVE" = 1 ]; then
    # Listing models is free even with no credit left; one tiny answer is what shows whether there is any.
    status="$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST -H "x-goog-api-key: $GEMINI_KEY" -H 'content-type: application/json' \
      -d '{"contents":[{"role":"user","parts":[{"text":"Reply with OK."}]}]}' "$GEMINI_API/models/${SEARCH_MODEL:-gemini-3.5-flash}:generateContent" 2>/dev/null)"
    case "$status" in
      200) ok "it answered a live test (it has credit)" ;;
      402) no "out of credit — top up the Gemini project in Google AI Studio (https://aistudio.google.com), or voice, search and prices stop" ;;
      429) no "over its rate limit or quota right now — try again shortly, or raise the project's quota" ;;
      *)   no "did not answer a live test (HTTP $status)" ;;
    esac
  else
    meh "to check it has credit (costs a fraction of a cent): bash deploy/doctor.sh --live"
  fi
fi

head_ "Talking out loud"
if [ -n "${LIVEKIT_URL:-}" ] && [ -n "${LIVEKIT_API_KEY:-}" ] && [ -n "${LIVEKIT_API_SECRET:-}" ]; then
  ok "LiveKit set up"
  case "$LIVEKIT_URL" in
    wss://*)
      # A short-lived token signed with the key and secret: LiveKit lists rooms only if they belong together.
      lk_token="$(node -e "const c=require('crypto'),b=o=>Buffer.from(JSON.stringify(o)).toString('base64url'),now=Math.floor(Date.now()/1000),h=b({alg:'HS256',typ:'JWT'}),p=b({iss:process.env.LIVEKIT_API_KEY,nbf:now-10,exp:now+60,video:{roomList:true}});process.stdout.write(h+'.'+p+'.'+c.createHmac('sha256',process.env.LIVEKIT_API_SECRET).update(h+'.'+p).digest('base64url'))" 2>/dev/null)"
      if [ -n "$lk_token" ] && probe -X POST -H "Authorization: Bearer $lk_token" -H 'content-type: application/json' -d '{}' "https://${LIVEKIT_URL#wss://}/twirp/livekit.RoomService/ListRooms"; then ok "LiveKit accepted the key and secret"
      else no "LiveKit refused the key and secret, or cannot be reached from this machine"; fi ;;
    ws://127.0.0.1*|ws://localhost*) meh "LiveKit runs on this computer: voice works in this computer's browser only. For your phone, use LiveKit Cloud (wss://...)" ;;
  esac
  if [ "$LOCAL" = 1 ]; then
    if ps ax -o command= 2>/dev/null | grep -F "$ROOT/agent/.venv/bin/python main.py start" | grep -v grep >/dev/null; then ok "voice worker running"
    else no "voice worker not running — bash deploy/local.sh starts it (see data/voice-worker.log)"; fi
  elif systemctl is-active --quiet fieldagent-voice 2>/dev/null; then ok "voice worker running"
  else no "voice worker not running — sudo systemctl start fieldagent-voice"; fi
else
  meh "not set up yet — typing and photos still work without it"
fi

head_ "Searching the web"
if [ -n "${SEARCH_API_KEY:-}" ]; then
  if [ "$LIVE" = 1 ]; then
    if probe -H "X-Subscription-Token: $SEARCH_API_KEY" -H "Authorization: Bearer $SEARCH_API_KEY" "${SEARCH_ENDPOINT:-https://api.search.brave.com/res/v1/web/search}?q=moen+1222&count=1"; then ok "the search key works"
    else no "the search provider refused the key, or cannot be reached from this machine"; fi
  else ok "search key set (bash deploy/doctor.sh --live tries one search)"; fi
elif [ -n "$GEMINI_KEY" ]; then ok "through Google, with your Gemini key"
else meh "not set up — it can still read any web address you give it"; fi

head_ "Comparing store prices"
partner=""; web=""
for pair in "HOME_DEPOT:The Home Depot" "LOWES:Lowe's" "AMAZON:Amazon" "WALMART:Walmart"; do
  var="${pair%%:*}_ENDPOINT"; name="${pair#*:}"
  if [ -n "${!var:-}" ]; then partner="$partner${partner:+, }$name"; else web="$web${web:+, }$name"; fi
done
[ -n "$partner" ] && ok "through your partner connections: $partner"
case "${WEB_PRICE_CHECK:-}" in off|false|0|no) web="" ;; esac
if [ -n "$web" ] && [ -n "$GEMINI_KEY" ]; then ok "$web: prices from the stores' own pages, through Google with your Gemini key (confirm on the page; bought on the store's site)"
elif [ -n "$web" ] && [ -z "$partner" ]; then meh "no store connected — a Gemini key lets it compare The Home Depot, Lowe's, Amazon and Walmart"; fi
if [ -n "${SUPPLIER_CONFIG_PATH:-}" ]; then
  if [ -f "$SUPPLIER_CONFIG_PATH" ]; then ok "your own suppliers: $SUPPLIER_CONFIG_PATH"; else no "SUPPLIER_CONFIG_PATH names a file that is not there: $SUPPLIER_CONFIG_PATH"; fi
fi

head_ "Texts and calls"
if [ -n "${TWILIO_ACCOUNT_SID:-}" ] && [ -n "${TWILIO_AUTH_TOKEN:-}" ]; then
  TW="${TWILIO_API_BASE:-https://api.twilio.com}/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID"
  if probe -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" "$TW.json"; then
    ok "Twilio accepted the account SID and token"
    if [ -n "${TWILIO_FROM:-}" ]; then
      if curl -fsS --max-time 15 -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN" "$TW/IncomingPhoneNumbers.json?PhoneNumber=$(printf %s "$TWILIO_FROM" | sed 's/+/%2B/')" 2>/dev/null | grep -q '"phone_number"'; then ok "texts go out from $TWILIO_FROM, a number on that account"
      else no "$TWILIO_FROM is not a number on that Twilio account"; fi
    else no "no number to text from — add TWILIO_FROM to .env"; fi
  else no "Twilio refused the account SID and token, or cannot be reached from this machine"; fi
else meh "texts not set up"; fi
if [ -n "${RETELL_API_KEY:-}" ]; then
  if [ -n "${RETELL_AGENT_ID:-}" ] && probe -H "Authorization: Bearer $RETELL_API_KEY" "${RETELL_API_BASE:-https://api.retellai.com}/get-agent/$RETELL_AGENT_ID"; then ok "Retell accepted the key and the agent"
  else no "Retell refused the key or the agent ID (RETELL_AGENT_ID), or cannot be reached from this machine"; fi
else meh "calls not set up"; fi
if [ -n "${TWILIO_ACCOUNT_SID:-}${RETELL_API_KEY:-}" ]; then
  case "${PUBLIC_BASE_URL:-}" in
    https://*) ok "replies and call results come back to $PUBLIC_BASE_URL" ;;
    *) meh "messages go out, but replies and call results come back only to a public https address (README: \"Texts and calls\")" ;;
  esac
fi

head_ "Signing in with Google"
if [ -n "${CLERK_SECRET_KEY:-}" ] && [ -n "${CLERK_PUBLISHABLE_KEY:-}" ]; then
  if probe -H "Authorization: Bearer $CLERK_SECRET_KEY" "${CLERK_API_URL:-https://api.clerk.com}/v1/jwks"; then ok "Clerk accepted the secret key"
  else no "Clerk refused the secret key, or cannot be reached from this machine"; fi
  if [ -n "${CLERK_OWNER_EMAIL:-}" ]; then ok "$CLERK_OWNER_EMAIL signs in to your employee"
  else no "no owner email — add CLERK_OWNER_EMAIL (your Google email) to .env"; fi
  [ -n "${CLERK_ALLOWED_EMAILS:-}" ] && ok "also let in, each with an employee of their own: $CLERK_ALLOWED_EMAILS"
else meh "not set up — access codes work (README: \"Signing in with Google\")"; fi

# What the employee knows, from the running app, with your own access code.
if [ -n "$CODE" ] && probe --noproxy "127.0.0.1,localhost" "$APP/health"; then
  head_ "Your employee"
  state="$(curl -fsS --max-time 15 --noproxy "127.0.0.1,localhost" -H "Authorization: Bearer $CODE" "$APP/api/state" 2>/dev/null)"
  if [ -n "$state" ]; then
    printf '%s' "$state" | node -e '
      let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s),c=st.contact??[],m=st.memory??[];
        const say=(good,t)=>console.log(`  ${good?"\x1b[32m✓\x1b[0m":"\x1b[33m–\x1b[0m"} ${t}`);
        say(c.length,c.length?`${c.length} ${c.length===1?"person":"people"} it can text or call`:"nobody it can text or call yet — add people on the Employee screen");
        const roles=c.filter(x=>/contractor|plumber|handyman|electrician|vendor/i.test(`${x.name} ${x.organization??""} ${x.notes??""}`));
        if(c.length)say(roles.length,roles.length?`it knows who does the work: ${roles.map(x=>x.name).join(", ")}`:"no one is marked as your contractor — add who they are to you on the Employee screen");
        say(m.length,m.length?`${m.length} ${m.length===1?"thing":"things"} it remembers`:"it remembers nothing yet — tell it what to remember");
      });' 2>/dev/null || meh "could not read what it knows"
  else meh "could not read what it knows with the first access code"; fi
fi

head_ "How to get in"
printf '  Open   %s\n' "${PUBLIC_BASE_URL:-$APP}"
printf '  Code   %s\n' "$CODE"

if [ "$PROBLEMS" -eq 0 ]; then printf '\n\033[32mEverything that is set up is working.\033[0m\n\n'
else printf '\n\033[31m%s thing(s) need fixing — see the ✗ marks above.\033[0m\n\n' "$PROBLEMS"; fi
exit 0
