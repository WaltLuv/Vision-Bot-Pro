# Owner actions

Only genuine external prerequisites are listed here — things no amount of code
in this repository can supply. Everything else is either done or tracked in
`docs/BUILD-STATUS.md`.

Each item says what stays unavailable until it is done, so nothing here reads as
blocking more than it does.

## Required for the phone to hold a conversation

- **LiveKit project**: set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
  on the gateway. Until then `/livekit-token` returns 503 and the PWA hides the
  conversation control and says voice is not set up. Typing, photos and tasks all
  still work.
- **Realtime model credential** for the voice worker (`agent/`), per its own
  configuration. Without it a room is created but nothing joins it.
- **A physical phone on HTTPS.** `getUserMedia` does not exist in an insecure
  context, so camera and microphone cannot be tested over plain HTTP on a LAN
  address. The PWA detects this and says so rather than reporting a permission
  error.

## Required for tasks to run at all

One of these, chosen with `AGENT_RUNTIME` (`anthropic`, `hermes` or `claude`).
Changing it in `.env` and restarting moves every owner who was not given a
different engine on purpose.

- **Hosted runtime**: `ANTHROPIC_API_KEY`. This is the preserved default.
- **Claude Code on your own Claude subscription** (`AGENT_RUNTIME=claude`):
  install Claude Code for the user the gateway runs as
  (https://code.claude.com/docs/en/quickstart), then sign it in once, yourself:
  `sudo -u <service user> -H claude auth login`. `deploy/install.sh` offers to
  do this. On your own computer, `bash deploy/local.sh` sets all of it up in
  one step. Set `CLAUDE_CODE_OWNER` to your own account (`owner` for an
  access-code install) — only that account's tasks run on it.

  Why it is built this way: Anthropic allows "an end user signing in to the
  unmodified Claude Code binary with their own Claude subscription", and does
  not allow an app to "collect, store, or intermediate Claude.ai credentials" or
  to route other people's requests through a Free, Pro or Max plan
  (https://code.claude.com/docs/en/legal-and-compliance). So the gateway never
  asks for, reads, stores or forwards your Claude login or any API key — Claude
  Code signs in through Anthropic's own flow and keeps its own login — and it
  refuses to run anyone else's task on it. It is for one person. If more people
  will use your VisionClaw, use the hosted runtime with an API key instead.
  `bash deploy/doctor.sh` checks it is installed and signed in;
  `bash deploy/doctor.sh --live` also sends one tiny real task.
- **Hermes runtime**: install the official runtime on the server and set
  `HERMES_CHECKOUT` (the directory containing `run_agent.py`) and
  `HERMES_PYTHON`, plus the model it should use: `HERMES_PROVIDER`,
  `HERMES_MODEL` and that provider's key. The gateway runs Hermes with a home
  of its own per owner, so Hermes settings and logins made elsewhere on the
  machine do not apply. Codex through Hermes (`openai-codex`) signs in with a
  ChatGPT account rather than a key; that sign-in has to be made inside the
  owner's Hermes home (`docs/SETUP-ON-YOUR-VM.md` shows how). The gateway
  forwards only model-provider keys into the runtime (`OPENAI_API_KEY`,
  `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`,
  `GEMINI_API_KEY`), never a service credential such as Twilio, Retell, a
  supplier or a browser key.

With neither, a submitted task is recorded and then fails with a message saying
the employee is not connected.

## Required per capability

Each is independent; the rest of the product works without it, and the Settings
screen shows the capability as "Not set up" rather than offering a control that
cannot work.

- **Text messages**: Twilio `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
  `TWILIO_FROM`. Point your number's "a message comes in" webhook (HTTP POST)
  at `${PUBLIC_BASE_URL}/webhooks/sms/inbound`, so replies reach you; delivery
  updates need no setup, because each message tells Twilio where to report
  (`/webhooks/sms/status`). Replies are routed to an account by
  `COMMUNICATION_ROUTES` (`{"+1555...":"owner"}`), which `deploy/local.sh`
  writes for you. Both webhooks need `PUBLIC_BASE_URL` to be a public https
  address.
- **Connected apps** (Gmail, Outlook, Google Calendar, Slack, Microsoft Teams,
  Discord, Notion, Google Sheets, Google Docs, Instagram, YouTube): a Composio
  project key in `COMPOSIO_API_KEY` (server only). In the Composio dashboard,
  create an auth config for each app you want offered; the gateway uses the
  first enabled one per app, or the one named in `COMPOSIO_<APP>_AUTH_CONFIG_ID`
  (for example `COMPOSIO_GMAIL_AUTH_CONFIG_ID`). Add
  `${PUBLIC_BASE_URL}/?connected=*` as an allowed redirect if your auth configs
  restrict them. Each person then connects their own accounts from Settings,
  under Connected apps. Not verified against a live Composio project from this
  repository; see `docs/COMPOSIO.md`.
- **Phone calls**: Retell `RETELL_API_KEY`, `RETELL_FROM`, `RETELL_AGENT_ID`,
  with its webhook pointed at `${PUBLIC_BASE_URL}/webhooks/voice`.
- **Fast web tasks**: set `SEARCH_API_KEY` with `SEARCH_PROVIDER` (`tavily`,
  `serper`, `exa` or `brave`). This is what makes early findings appear in
  seconds; without it the head start still opens the live browser, but has no
  quick search. Browserbase (`BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`) is
  the live browser. Optional: `TYPESAFE_API_KEY` for Jev routing (see
  `docs/FAST-WEB.md`).
- **Web search**: a Gemini key (`GEMINI_API_KEY` or `GOOGLE_API_KEY`) is
  enough: the employee searches Google through Gemini and gets the pages behind
  each answer. Or `SEARCH_API_KEY` (Brave Search by default; `SEARCH_ENDPOINT`
  for another provider), which is used instead when set. Without either the
  employee can still read any web address it is given. The Gemini project needs
  credit: `bash deploy/doctor.sh --live` says when it has run out.
- **Suppliers**: each is independent, and a search asks every connected one at
  once. Connect as few or as many as you want; the phone always says which were
  searched and which were not.

  With a Gemini key and nothing else, The Home Depot, Lowe's, Amazon and
  Walmart are still compared: Gemini searches Google for the item at each
  store, and a price is kept only when Google ties it to a product page on that
  store's own site. Such a price is labelled **Web search**, with the page's
  link, unconfirmed stock, and no shipping or tax. It cannot be quoted or bought
  in the app; the owner buys it on the store's site. A store's partner
  connection, when set, replaces its web search. `WEB_PRICE_CHECK=off` turns
  web search pricing off.

  | Supplier | Variables |
  |---|---|
  | Home Depot | `HOME_DEPOT_ENDPOINT`, `HOME_DEPOT_API_KEY` |
  | Lowe's | `LOWES_ENDPOINT`, `LOWES_API_KEY` |
  | Amazon | `AMAZON_ENDPOINT`, `AMAZON_API_KEY` |
  | Walmart | `WALMART_ENDPOINT`, `WALMART_API_KEY` |
  | Local and specialty | `SUPPLIER_CONFIG_PATH` plus each supplier's own credential variable |
  | eBay (optional) | `EBAY_ENABLED=true`, `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` |

  These catalogs are reached through partner entitlements rather than an open
  URL, so the endpoint is yours to supply. Amazon's Product Advertising API and
  Walmart I/O require signed requests; point their endpoint at the gateway you
  are entitled to or at your own signing proxy, which may run on loopback beside
  the gateway. The built-in field mappings for Home Depot and Lowe's are
  defaults — confirm them against the endpoint you are granted, and override any
  field through `SUPPLIER_CONFIG_PATH`.

  eBay stays off unless `EBAY_ENABLED=true`; its credentials alone do not
  connect it.

  Local yards and specialty vendors are defined entirely in
  `SUPPLIER_CONFIG_PATH`: an id, a display name, an https (or loopback)
  endpoint, an auth variable, and where each normalized field lives in the
  response. Nothing is hardcoded to a particular vendor.
- **A browser the employee drives itself**: `BROWSERBASE_API_KEY`
  (`BROWSERBASE_PROJECT_ID` is optional; set it to choose a project). The
  employee opens a browser once you approve it, works in it step by step, and
  you can watch it and take it over from the phone; while you drive it takes no
  steps. It will not press a button that places an order or pays, or type
  passwords or payment details: you can take over and do those yourself. The
  server must be able to reach `api.browserbase.com` and the
  `*.browserbase.com` address each browser session connects on;
  `bash deploy/doctor.sh` checks the key against Browserbase. If Browserbase
  serves its live view from a host outside `browserbase.com`, the phone names
  that host instead of showing it; add it to `BROWSER_LIVE_VIEW_HOSTS`.
- **Browser use**: `BROWSER_USE_API_KEY`. While the employee browses, Today
  shows **Watch it browse**: a full-screen live view you can **Take over** (the
  employee's current run is stopped at Browser Use first; the browser stays
  open for you) and **Hand back** (the employee carries on in the same browser,
  from the page as you left it). The phone only
  frames live views from Browser Use's own https hosts; a live view served from
  anywhere else is named on screen instead, and can be allowed with
  `BROWSER_LIVE_VIEW_HOSTS` (host names, comma-separated).
- **Connected tools (MCP)**: per-server configuration and its credentials.
- **Google sign-in on the phone app**: a Clerk application with Google turned
  on (https://dashboard.clerk.com). Set `CLERK_PUBLISHABLE_KEY`,
  `CLERK_SECRET_KEY`, `CLERK_OWNER_EMAIL` (your own Google email) and, for
  anyone else, `CLERK_ALLOWED_EMAILS`; `bash deploy/local.sh --setup` asks for
  all four. A development instance uses Clerk's shared Google credentials, so
  there is nothing to set up at Google. A production instance needs a domain of
  your own and your own Google OAuth client, set in Clerk's dashboard. Until
  the keys are set the sign-in screen offers access codes only.
- **Google sign-in in the native iOS and Android apps**: `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, and `PUBLIC_BASE_URL` registered as an authorised
  redirect URI on that OAuth client.

## Required before anyone is messaged or called

- **Consent and real destinations.** A test number you control, and permission
  from anyone who will receive a message or call. The gateway requires a
  matching contact and an explicit approval per action, but it cannot obtain
  consent on your behalf.

## Required for production hosting

- **A domain with HTTPS** and `PUBLIC_BASE_URL` set to it. The gateway refuses to
  start in production with a non-HTTPS `PUBLIC_BASE_URL`, and session cookies are
  only marked `secure` when `NODE_ENV=production`.
- **A persistent volume** mounted at `/data`. It holds the store file, the SQLite
  database, uploaded artifacts and the per-owner Hermes homes. Losing it strands
  hosted sessions and silently re-provisions empty ones.
- **`STATE_SECRET`** and **`GATEWAY_TOKENS`** (or approved self-registered
  accounts) set as secrets, never committed.
