# Build status

In progress. Not production complete and not deployed.

The phone client now exists and is served by the gateway; three runtimes work --
Hermes against the official runtime in a subprocess, Anthropic Managed Agents
against a protocol fixture over loopback, and Claude Code on the owner's own
subscription against a stand-in CLI and, for its startup contract, the real
binary -- and deployment builds and ships them. Nothing here has run against live commercial providers or a physical
phone.

Exact commands, results and per-criterion labels are in `docs/TESTING.md`.

## Verified in this checkout

- Gateway typecheck clean; **142 of 143 tests pass, 1 skipped**. The skip is the real-binary Claude Code test, which refuses to run
  inside a Claude Code cloud session with a network; offline it ran, and its
  startup contract passed.
- Web client typechecks and builds; **166/166 tests pass** across 19 files.
- **119/119 end-to-end checks pass** against a real gateway in a real browser at a
  phone viewport, with a synthetic camera and microphone and two configured
  suppliers, one of which is deliberately down.

What the end-to-end run establishes on the real path:

- the built bundle boots under the gateway's CSP with no violation;
- sign-in, an HttpOnly `SameSite=Strict` cookie, and no access code left in
  browser storage;
- a task running through the gateway to Hermes and a governed tool, with
  evidence stored and shown;
- watching the employee browse with Browser Use: the live page loads under the
  app's policy, taps do nothing while the employee drives, taking over stops
  the employee's run at the provider before the phone says you are in control,
  your taps and typing then reach the page, handing back continues in the same
  browser session, the page is loaded once however often the app re-renders,
  and Stop cancels and lets go of it;
- a browser the employee drives itself (Browserbase, with a real Chromium
  standing in for the remote browser): opening it asks first, taking it over
  is immediate, the employee sends the website nothing while you drive and its
  task waits, handing back lets it finish from the page it read, and the
  browser is released when the task is done;
- the Anthropic Managed Agents path carrying the same governance: its own
  toolsets forced to ask, the gateway's capabilities added as custom tools, a
  purchase held at `needs_user` until the owner decides, a declined action
  refused to the model and never executed, hosted tool confirmations answered
  by policy, and cancellation interrupting the hosted session;
- the camera opening, showing live frames, freezing by muting the outgoing
  track, capturing a still that becomes owned evidence attached to a task, and
  releasing the device on stop;
- with no realtime credentials, a 503 and an honest "not set up" rather than a
  dead control, with typing still working;
- a sensitive tool stopping the run to ask, the exact question on screen, and
  the answer releasing it;
- stopping a task ending the work, not just the view — still cancelled, with no
  result, after the model would have finished;
- a long task surviving its page and context being closed mid-flight and
  completing with no client attached;
- a second signed-in owner seeing none of the first's records and getting 404
  rather than a detailed refusal;
- a multi-supplier price comparison where one supplier fails: the working
  supplier's offers survive, the failed one is named on screen, the phone says
  "1 of 2 suppliers answered" and warns there may be better prices, and eBay
  stays out of the search even with its credentials present;
- idempotent resubmission, CSRF rejection, and server-side sign-out.

## Fixed since the last checkpoint

- **The Hermes path could not have worked.** The bridge passed
  `skip_background_review=True` to `AIAgent()`, which is not a parameter of the
  official runtime, so every Hermes run died with a `TypeError`. The test that
  would have caught it skips unless `HERMES_CHECKOUT` is set, so the previous
  "all 12 tests pass including a real Hermes subprocess" could not be reproduced
  here. Runtime under test is now pinned and named: **hermes-agent 0.19.0**.
- **The phone client did not exist.** `server.ts` had always served
  `web/dist`, but `web/` was absent from this checkout and from the entire branch
  history. It is rebuilt from the gateway's own route contracts.
- **The client could never have shipped.** The Dockerfile did not include
  `web/` in its build context, and the static path resolved outside the image
  root, so a deployed gateway answered `/` with 404 while its API worked.
- **Secrets were not redacted anywhere.** No redaction existed in the gateway;
  provider error text reached API clients verbatim.
- Runtime selection was inline and untestable, and an unrecognised value would
  fail a run with a `TypeError` instead of falling back.

## Acceptance table

Labels are the handoff's: **IMPLEMENTED + VERIFIED**, **IMPLEMENTED + BLOCKED ON
OWNER CREDENTIAL**, **SCAFFOLDED**, **NOT IMPLEMENTED**. "Verified" means a test
in this repository exercises the real path; it never means a live account was
used. Per-criterion detail and how to reproduce each suite is in
`docs/TESTING.md`.

### Core criteria

| # | Criterion | Status |
|---|---|---|
| 1 | Phone visual question through the realtime layer, spoken result | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL |
| 2 | Visual context → execute → gateway → runtime → governed tool → evidence | IMPLEMENTED + VERIFIED |
| 3 | Long task acknowledged fast, survives disconnect, completes later | IMPLEMENTED + VERIFIED |
| 4 | Cancellation prevents hidden continuation | IMPLEMENTED + VERIFIED |
| 5 | Hermes selection through the official runtime | IMPLEMENTED + VERIFIED |
| 5a | Anthropic Managed Agents runtime, same governance | IMPLEMENTED + VERIFIED against a protocol fixture; live Anthropic account BLOCKED ON OWNER CREDENTIAL |
| 5c | Claude Code on the owner's own subscription, same governance | IMPLEMENTED + VERIFIED against a stand-in CLI through the real bridge; startup contract VERIFIED with the real binary offline; the full loop with the real binary and a real login is for the server (`npm test -- tests/claude.test.ts`, then `deploy/doctor.sh --live`) |
| 5d | Run it on your own computer (`deploy/local.sh`), with Hermes, Claude Code on your subscription, or an Anthropic key | IMPLEMENTED + VERIFIED on Linux from a fresh clone in a real terminal with Hermes 0.19 and no Claude Code: it asks for the model provider, model and key, offers voice, browser, web search, texts and calls, writes `gateway/.env` (600), builds, starts the gateway and the voice worker, and later starts ask nothing; the whole app was then used from a phone-sized browser with Hermes on Gemini and Gemini Live voice (docs/TESTING.md, "The whole app, used like its owner"). The Claude Code path: VERIFIED with a stand-in CLI and the real binary's startup contract offline; a real subscription login doing a task is for the owner's computer. |
| 13 | Watch the employee browse and take the browser over | IMPLEMENTED + VERIFIED in a real browser against a stand-in shaped like Browser Use's v4 API (confirmed from its official SDK); that a stopped run's browser stays open for the owner is implied by Browser Use's session design but unconfirmed; live account BLOCKED ON OWNER CREDENTIAL |
| 13a | A browser the employee drives step by step, with live view and take-over (Browserbase) | IMPLEMENTED + VERIFIED against a real Chromium over CDP and a stand-in shaped like Browserbase's API (from its official SDK), in gateway tests and end to end; code refuses purchase buttons and password/payment fields; a live Browserbase session BLOCKED ON OWNER NETWORK/CREDENTIAL (this environment cannot reach `api.browserbase.com`) |
| 5b | Codex through a supported server-side provider path | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — only the credential boundary is verified |
| 6 | SMS draft / approval / send / inbound status | IMPLEMENTED + VERIFIED against fixtures; live account BLOCKED ON OWNER CREDENTIAL |
| 7 | Outbound call objective / status / transcript / outcome | IMPLEMENTED + VERIFIED against fixtures; live account BLOCKED ON OWNER CREDENTIAL |
| 8 | Multi-supplier comparison with price and availability timestamps | IMPLEMENTED + VERIFIED against fixtures; live accounts BLOCKED ON OWNER CREDENTIAL |
| 9 | Purchase approval blocks unauthorised checkout | IMPLEMENTED + VERIFIED |
| 10 | Unauthorised access returns 403/404 without leaking | IMPLEMENTED + VERIFIED |
| 11 | Reconnect does not duplicate messages, calls or purchases | IMPLEMENTED + VERIFIED |
| 12 | Phone fully usable without glasses | IMPLEMENTED + VERIFIED |
| 14 | Google sign-in for the phone app (Clerk) | IMPLEMENTED + VERIFIED with Clerk's own library and, in a real browser, a stand-in for Clerk's script and API; real Clerk and Google BLOCKED ON OWNER CREDENTIAL (Clerk keys) |
| 15 | Web search through Google with a Gemini key | IMPLEMENTED + VERIFIED against a stand-in in Gemini's response shape; the owner's key lists models but has no credit (HTTP 402), so no live grounded answer has been seen — BLOCKED ON OWNER CREDENTIAL (top-up) |
| 16 | Damaged fixture → identify → compare four stores → text the contractor for approval | IMPLEMENTED + VERIFIED in the lab on a phone-sized browser against the running app, with Gemini, Twilio and the model stood in (the model scripted); live Gemini BLOCKED ON OWNER CREDENTIAL |
| 17 | Readiness check for a local install (`deploy/doctor.sh --live`) | IMPLEMENTED + VERIFIED against the lab's stand-ins, and against the owner's real Gemini project (it reports the missing credit) |

### Supplier adapters

Every adapter below normalizes into one offer model, is searched in parallel,
reports its own failure without erasing other suppliers' offers, and has fixture
tests. None has run against a live account in this repository.

| Supplier | Access method | Status |
|---|---|---|
| Home Depot | Partner catalog | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — `HOME_DEPOT_ENDPOINT`, `HOME_DEPOT_API_KEY` |
| Lowe's | Partner catalog | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — `LOWES_ENDPOINT`, `LOWES_API_KEY` |
| Amazon | Official API (Product Advertising 5.0 shape) | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — `AMAZON_ENDPOINT`, `AMAZON_API_KEY`; PA-API needs SigV4 signing, so the endpoint points at an entitled gateway or signing proxy |
| Walmart | Official API (product search shape) | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — `WALMART_ENDPOINT`, `WALMART_API_KEY`; Walmart I/O needs signed requests |
| Local suppliers | Owner-configured catalog | IMPLEMENTED + VERIFIED — configured through `SUPPLIER_CONFIG_PATH` and exercised end to end against a live local endpoint |
| Specialty vendors | Owner-configured catalog | IMPLEMENTED + VERIFIED — same connection model; nothing is hardcoded to one vendor |
| eBay | Official API, optional | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — off unless `EBAY_ENABLED=true`; never a default or only supplier |
| MCP-backed supplier | Connected tool | SCAFFOLDED — a connector may expose catalog tools and an exact-quote checkout, but no supplier has been run this way here |
| The Home Depot, Lowe's, Amazon, Walmart without a partner connection | Web search (Google through Gemini) | IMPLEMENTED + VERIFIED against fixtures and in the lab — a price is kept only when Google ties it to a product page on the store's own site; labelled Web search, stock unconfirmed, never quoted or bought here; live Gemini BLOCKED ON OWNER CREDENTIAL (top-up) |
| Any website, read in a browser | Browserbase browser + `offer_record` | IMPLEMENTED + VERIFIED against fixtures — the employee reads a price on a supplier's site and records it; it joins the comparison marked as read from a website and unverified, and checkout refuses it (no supplier connection can quote an exact total), so the owner buys it on the site. Stagehand is not used: the employee drives the browser through the gateway's own governed step tools |

### Fast web tasks (head start)

| Capability | Status |
|---|---|
| Rule router (quick answer, search, website, shopping, connected app, approval) in under a millisecond | IMPLEMENTED + VERIFIED |
| Jev routing for tasks the rules only guess at, with a time limit and fallback | IMPLEMENTED + VERIFIED against a stand-in; live Jev BLOCKED ON OWNER CREDENTIAL (`TYPESAFE_API_KEY`) |
| Live Browserbase browser opened at once for web tasks, before the runtime; shared with the employee; opens on screen by itself | IMPLEMENTED + VERIFIED against a real Chromium and in the end-to-end suite (browser record in 85 ms); live Browserbase BLOCKED ON OWNER CREDENTIAL |
| Quick search in parallel (Tavily, Serper, Exa, Brave, Gemini), early findings and steps on the task as they happen | IMPLEMENTED + VERIFIED against fixtures and end to end; live search BLOCKED ON OWNER CREDENTIAL (`SEARCH_API_KEY`) |
| Guest browser by default; the owner's saved sign-ins (Browserbase context) only for tasks about their own accounts, and only with standing browser permission | IMPLEMENTED + VERIFIED against a stand-in |
| A finished task's browser stays open a few minutes, then closes; a stopped task's closes at once | IMPLEMENTED + VERIFIED |

### Connected apps and routines

| Capability | Status |
|---|---|
| Connect, check and disconnect an app (Composio connect link, status, revoke), owner-scoped, behind cookie auth and CSRF | IMPLEMENTED + VERIFIED against a Composio stand-in, through HTTP and in a real browser round trip; live Composio BLOCKED ON OWNER CREDENTIAL (`COMPOSIO_API_KEY`) |
| Governed app actions (`app_read`, `app_update`, `app_send`, `app_delete`): effect classified from the action, pinned to the owner's account, every non-read approved per call, uncertain outcomes never repeated | IMPLEMENTED + VERIFIED against fixtures |
| Connect prompt when a task needs an app that is not connected | IMPLEMENTED + VERIFIED (unit) |
| Recurring routines (daily, weekdays, weekly; time zone aware), delivery to chat or an app, last-run result, pause and resume, idea templates | IMPLEMENTED + VERIFIED against fixtures and in a real browser |
| Natural-language routine parsing ("every Friday at 4") | NOT IMPLEMENTED: the phone uses a form; delivery is inferred from the wording |

The field mappings for Home Depot and Lowe's are defaults against partner
catalog shapes and should be confirmed against the endpoint an owner is granted.
Every mapping is overridable per deployment.

## Fixed in this pass

- **Typing could be lost.** The phone's text box was rebuilt empty whenever an
  update arrived, so a task being typed as one landed vanished and Send quietly
  sent nothing; Enter while the app was busy cleared the text unsent. It now
  keeps the text, the cursor and focus. This was the intermittent end-to-end
  failure earlier put down to machine load.
- **The Vision-Bot-Pro name, everywhere in the app.** The rebrand named the app
  and its page; the sign-in screen, home-screen title and new owners' employee
  now carry the name too. Server service names and internal package names keep
  the old one, so existing installs are unaffected.
- **No way to run it on your own computer.** `deploy/local.sh` sets it up and
  starts it on your Claude subscription through Claude Code, with no root and
  no domain. The gateway gained `HOST`, so a laptop install listens on the
  computer only instead of every network it joins.
- **The installer could not produce a working server.** `npm ci
  --omit=optional` dropped sharp's Linux binary, so the gateway crashed on
  start while the installer printed "gateway running". And with its private
  umask left on, everything it built was readable by root alone, so services
  running as the installing user could not have read their own code either.
  It now installs what the app needs to run, leaves the build readable, gives
  `.env` to the service user, and waits for the gateway to answer or stops with
  the reason.
- **Re-running the installer deleted settings.** It rewrote `.env` with only
  its own settings, so a Hermes model provider, Twilio or supplier keys added by
  hand were lost; it asked for the address again; and it did not restart the
  running app, so new settings never loaded. It now keeps everything else as it
  was, reads the address back, and restarts.
- **The installer replaced the whole Caddy config**, so any site the server
  already served would have gone. It now adds this one beside them, keeps the
  old file, and puts it back if Caddy rejects the result.
- **`doctor.sh` read `.env` as a shell script**, so a `$` in a key or password
  stopped it and JSON values lost their quotes. It reads the file literally, as
  systemd does, and now also says which model Hermes will use.
- **A restart during browsing jammed the browser queue.** Records of browsers
  open before a restart were never closed: one held the only slot, and an old
  queued request held up every browser request behind it, for every owner. On
  startup each is now stopped at its provider and its slot freed.
- **App-connection OAuth state could be forged in production.** Without
  `STATE_SECRET` the gateway signed it with a constant that is in this
  repository, and an empty value signed with an empty key, so someone could
  have put their own app credential into another person's account. Production
  now refuses to start without a secret of at least 32 characters, an empty
  value is never used as a key, and `gateway/.env.example` no longer ships
  placeholder values that took effect if copied unchanged: `change-me-token`
  worked as an access code, `generate-a-random-string` as a guessable secret,
  and `sk-ant-...` made the Anthropic runtime look configured.
- **The employee could only hand a whole browsing job away.** With
  `BROWSERBASE_API_KEY` it now drives a real browser one step at a time
  through governed tools, and the owner can watch it live and take it over:
  while the owner drives, the employee takes no steps in it. Pressing a
  button that places an order or pays, and typing into password or payment
  fields, are refused in code, whatever the model asks.
- **A price seen on a website had nowhere to go.** `offer_record` adds it to
  the supplier comparison, marked as read from a website and unverified, and
  checkout refuses it, so the owner buys it on the site.
- **The README described a glasses-first app built on OpenClaw.** The phone app,
  the gateway and the native apps no longer have that path. It is rewritten
  phone-first, with `docs/ARCHITECTURE.md` and a root `.env.example` that lists
  only variables the code reads.
- **Nothing could run on a Claude subscription.** Managed Agents is an API
  product and cannot sign in with one. Claude Code is now a third runtime: the
  unmodified binary, signed in by the owner through Anthropic's own flow, with
  every built-in tool off and only the gateway's governed tools reachable. The
  gateway never handles the login and refuses anyone's task but
  `CLAUDE_CODE_OWNER`'s, which is what Anthropic's terms require.
- **Changing `AGENT_RUNTIME` never moved an existing owner.** The runtime
  stamped on a profile when it was first created won forever, so an edit to
  `.env` only affected owners created afterwards. It is now the live default
  for every owner who was not given a different engine on purpose, and the
  phone is told which engine will actually run.
- **The browser's live view reached the gateway but never the phone.** Today
  now shows Watch it browse; the live view opens full screen, never reloads on
  re-render, and can be taken over and handed back.
- **The page policy allowed framing any https page.** It now allows only the
  live-view hosts, and nothing else is framed.

- **The hosted runtime could not be reached through the supported install.**
  `deploy/install.sh` required Hermes on the machine and hard-wrote
  `AGENT_RUNTIME=hermes`, so an owner who wanted Claude could not get there.
  Hermes is now optional, the installer asks for an Anthropic key, picks the
  runtime from what is actually configured, and writes both so switching is one
  line in `.env`. `deploy/doctor.sh` reports on the selected runtime and calls
  Anthropic to check the key really works.
- **The phone said "Ready" for an engine nobody had selected.** The settings
  screen treated either runtime's credentials as readiness, so an owner set to
  Anthropic with only Hermes configured was told tasks would work, and found
  out otherwise at task time. Readiness now follows the selected runtime and
  names which engine does the work.
- Procurement was eBay and nothing else, instantiated by default. It is now a
  provider-neutral registry over Home Depot, Lowe's, Amazon, Walmart and any
  number of owner-configured local and specialty suppliers, with eBay demoted to
  an optional connection that is not constructed unless switched on.
- Communications had no test at all — the adapter that messages and calls real
  people. It now has ten, covering the approval gate, a changed destination, a
  blocked contact, the never-retried uncertain send, and webhook signature,
  account, replay and ordering rules.
- MCP and browser use had none either. A malformed connector file now provably
  costs only the connectors, a plaintext connector URL is refused, and a
  connector cannot expose its own checkout tools as a second ungoverned path to
  spending money.

## Still open

- The realtime conversation itself needs LiveKit and realtime model credentials.
  The camera and microphone are verified in a browser against a synthetic
  device; a physical phone is still the only way to confirm real hardware.
- Communications, voice, procurement, browser and MCP adapters are verified
  against fixtures, which proves the contract the gateway enforces, not that
  each provider behaves as documented. None has run against a live account.
- The Codex-through-Hermes provider path is unverified beyond its credential
  boundary.
- Claude Code's full model loop with the real binary has not run anywhere
  yet: in this sandbox the CLI is bound to the session's own account, so the
  test refuses to spend it. It runs on the server.
- Take-over first called `/pause` and `/resume`, which Browser Use's v4 API
  does not have; checked against its official SDK, it now stops the
  employee's run and hands back with a follow-up run in the same session.
  That the session's browser stays open in between is implied by Browser
  Use's design, not stated; if not, hand-back continues in a fresh browser.
- No live Anthropic account has been used. Every hosted-runtime test answers
  from a loopback fixture, which proves the protocol and the governance the
  gateway enforces, not that Anthropic's service behaves as documented.
  `deploy/doctor.sh` now checks a real key against Anthropic, so an owner with
  one can confirm that in a single command.
- The container image is not built here: this sandbox has a docker client but no
  daemon.
- No live Browserbase session has run: this environment's network policy
  blocks `api.browserbase.com`. The API shape comes from Browserbase's official
  SDK. The live view is assumed to be served under `browserbase.com`, which is
  allowlisted; if it is served from another host, the phone names that host
  instead of framing it until it is added to `BROWSER_LIVE_VIEW_HOSTS`.
  `deploy/doctor.sh` checks the key against Browserbase on the server.
- The iOS app still carries upstream's "self-hosted" backend setting and
  `OpenClaw`-named files and settings keys. Renaming the keys would erase
  owners' saved settings, and iOS cannot be built here to prove a rename, so
  they stay; nothing in the phone app, the gateway or Android depends on
  OpenClaw.
- `npm run lint` in `gateway/` fails on 38 files. It already failed on 20 at the
  `a62fb16` checkpoint; the codebase's dense style does not match its own
  prettier config, and reformatting is a separate decision.
- `gateway/package.json` declares `engines: >=24` while the tree is tested and
  imaged on Node 22, so `npm ci` prints `EBADENGINE`.
