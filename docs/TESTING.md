# Testing

Everything below was run in this checkout. Where a result depends on a
credential this environment does not have, that is stated rather than implied.

## What runs without any credential

```bash
cd gateway && npm ci && npx tsc --noEmit && npm test     # 129 tests
cd web     && npm ci && npm run verify                   # build + 107 tests
```

`npm run verify` in `web/` builds first on purpose: the packaging tests read the
real `web/dist` output rather than a description of it.

Two gateway tests drive a real runtime binary and skip, saying why, when it is
not available: the Hermes subprocess test (needs `HERMES_CHECKOUT`) and the
real Claude Code test (needs `claude` installed; see below). Everything else
needs no credential, including the Anthropic and Claude Code runtime tests.

## Running the Hermes tests

The Hermes tests drive the official runtime in a real subprocess. Install it and
point the two variables at the installation:

```bash
python3 -m venv .hermes-venv
./.hermes-venv/bin/pip install hermes-agent==0.19.0
export HERMES_CHECKOUT="$(./.hermes-venv/bin/python -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])')"
export HERMES_PYTHON="$PWD/.hermes-venv/bin/python"
cd gateway && npm test                                   # 128 passed, 1 skipped (Claude Code, below)
```

`HERMES_CHECKOUT` must be the directory containing `run_agent.py`; for a pip
install that is the environment's `site-packages`. The runtime talks to a local
OpenAI-compatible fixture, so no model credential is used.

Version under test: **hermes-agent 0.19.0**.

## Verifying the Anthropic runtime

`tests/managed.test.ts` drives the preserved Anthropic Managed Agents path end
to end. The gateway uses the real `@anthropic-ai/sdk`; only the far end is a
fixture that speaks the Managed Agents wire protocol over loopback, selected
with `ANTHROPIC_BASE_URL`. Provisioning, the session tool slate, the SSE event
drain, the custom-tool round trip, approvals and cancellation all run for real.

```bash
cd gateway && npm test -- tests/managed.test.ts           # 7 passed
```

No credential is used and nothing leaves the machine. What it establishes:

- one shared agent and environment, one vault and session per owner, and the
  model, system prompt and toolsets living on the **agent** -- a session that
  carried its own model would silently diverge from it;
- an unchanged app surface does not bump the agent version on every task;
- the hosted agent's own toolsets are forced to `always_ask`, the gateway's
  capabilities are added as custom tools, and the employee's standing
  instructions travel as the one `system.message` the API allows;
- a governed read runs and its result is returned on the tool channel, with a
  receipt stored against the run;
- a financial action stops the run at `needs_user`, tells the hosted agent
  nothing until the owner decides, and is charged only after approval;
- a declined action is never executed and the refusal is returned to the model,
  so it reports the refusal instead of inventing a delivered result;
- built-in and MCP tool confirmations are answered by policy, not by the model:
  a shell and an unlisted MCP write are denied, a listed read is allowed, and
  every decision is recorded against the run;
- an action left pending by a previous process is answered as an error and
  never replayed under a new run;
- cancelling interrupts the hosted session and closes the stream rather than
  leaving it draining;
- a missing `ANTHROPIC_API_KEY` refuses before any hosted call is made.

These tests were checked by mutation: weakening the `always_ask` policy,
removing the approval gate, auto-allowing hosted built-ins and dropping the
stale-action error flag each fail exactly the test that covers them.

What this does **not** establish: that Anthropic's own service behaves as
documented, or that a real key works. That is one `deploy/doctor.sh` run away
on a machine that has one.

## Verifying the Claude Code runtime

`tests/claude.test.ts`. Claude Code runs on the owner's own Claude
subscription, so the rules under test are Anthropic's as much as ours: the
gateway never handles the login and never runs anyone else's task on it.

All but one of its checks drive a stand-in CLI
(`tests/fixtures/fake-claude.mjs`) that speaks Claude Code's stream-json
protocol and is the MCP client of the gateway's **real** bridge, socket channel
and ToolGateway. They establish:

- the command line switches off every built-in tool (`--tools ""`), loads no MCP
  server but the gateway's (`--strict-mcp-config`), refuses rather than asks
  (`--permission-mode dontAsk`, `--permission-prompts none`), and never uses
  `--dangerously-skip-permissions` or `--bare`;
- a Claude Code that reports any tool the gateway does not govern is stopped,
  and a tool call that races that startup report is refused, not run;
- a purchase waits for the owner and is charged once, after approval; a
  declined message is never sent and the refusal is returned to the model;
- only `CLAUDE_CODE_OWNER` can have tasks run on it; anyone else's task is
  refused before Claude Code starts;
- no service key, no `ANTHROPIC_API_KEY` and no `CLAUDE_CODE_OAUTH_TOKEN`
  reaches it; `HOME` does, which is how Claude Code finds its own login;
- the tool channel is a Unix socket in a 0700 directory, needs the run's
  256-bit token, and is gone when the run ends;
- Claude Code's own error text (paths, keys) never reaches the phone;
- a camera still reaches it as an image block;
- the phone is told it is ready only when it is the owner's and signed in, and
  a slow sign-in check never holds up the phone's refresh.

The remaining check runs the real, unmodified `claude` binary against a fixture
Messages API on loopback, with an empty `HOME` and a fixture key:

```bash
cd gateway && npm test -- tests/claude.test.ts   # with claude on PATH, or CLAUDE_CODE_BIN set
```

It checks the startup contract (only the governed tools, the bridge
connected), then a full governed tool call through the fixture model. It skips
inside a Claude Code cloud session that has a network, because there the CLI
is bound to that session's own account and does not honour
`ANTHROPIC_BASE_URL`. **What was run here**: Claude Code 2.1.282 offline
(`unshare -rn`); the startup contract passed and the model half skipped for
that reason. The full model loop against the real binary has not been run
anywhere yet; it runs on an ordinary machine, such as the server.

Removing `--tools ""` makes the real binary start with `Task`, `Bash`, `Edit`,
`Read`, `NotebookEdit`, `CronCreate`, `SendMessage` and more; the test fails and
the runtime's own startup check stops the run.

To try the owner's real login once it is signed in, `bash deploy/doctor.sh
--live` sends one tiny task. That uses a little of the plan, so plain
`doctor.sh` never does.

## Live browser and take-over

`tests/browser.test.ts` (14 checks) against a stand-in Browser Use service,
and end-to-end checks in a real browser (below). The stand-in behaves like
Browser Use's v4 API as its official SDK defines it (below): runs are created,
polled and cancelled, never paused; each belongs to a session; a follow-up run
in the session reuses its live browser. Established:

- taking over stops the employee's current run at the provider **before** the
  phone says you are in control, and that stop is not mistaken for the end of
  the task; handing back starts a follow-up run in the same session, told to
  carry on from the page as it is, with the same guard rails as the first run;
- a refused stop leaves the employee in control and says so, a refused
  follow-up leaves the browser with you, and a browser with no Browser Use
  session is never taken over, since it could not be handed back;
- stopping while you hold the browser ends the job cleanly, and stopping a run
  that had already finished is not left holding the only browser slot;
- if a follow-up run is given a different browser, the phone switches to its
  live view;
- time with the owner does not count against the employee's 15 minutes, but a
  take-over left open is ended after 45;
- the live link is dropped from the record when the job ends or is stopped;
- after a restart, every browser left open is stopped at its provider (a
  Browserbase session released, a Browser Use run cancelled) and its slot
  freed, so a new request is not held up; one the provider will not confirm
  stopped is tried once more and then let go, and a browser started since is
  never touched. The gateway does this itself on boot (mutation-checked: each
  of these fails without the code for it);
- the phone only frames https pages from Browser Use's hosts (or ones an owner
  adds with `BROWSER_LIVE_VIEW_HOSTS`, validated because they become part of
  the page policy); any other live view is named on screen, not framed, and is
  still kept for the glasses apps that already show it;
- take-over and hand-back need the session and CSRF token, and another owner's
  browser answers 404 with nothing sent to the provider;
- in the real browser: the live page loads under the app's policy with no
  violation; while the employee drives, taps on it go nowhere; once you are in
  control, taps and typing reach it; the page is loaded **once** however often
  the app re-renders; Stop cancels at the provider and lets go of the view.

**Checked against Browser Use itself** (its documentation site is blocked from
here, so through its official SDK, `browser-use-sdk` 3.11.3 on npm and PyPI,
which is generated from its API definition, and its docs as quoted by search):

- v4 is `https://api.browser-use.com/api/v4`, authenticated with
  `X-Browser-Use-API-Key`; runs are `POST /runs`, `GET /runs/{id}`,
  `/status`, `/events` and `POST /runs/{id}/cancel` -- all as the gateway
  already used them.
- **v4 has no pause or resume for a run.** The first version of take-over
  called `/pause` and `/resume`; against the real service it would have
  failed every time (safely: the employee kept the browser and the phone said
  so). It now uses what v4 does have: a session "can reuse its live browser",
  and a follow-up run with the session's id resumes work "in the same browser".
- The live view is served from `live.browser-use.com`, is meant to be framed,
  and Browser Use tells apps with a Content-Security-Policy to add it to
  `frame-src` -- which is what the app does.

**Still unconfirmed**: that the session's browser stays open between the
employee's run being stopped and the follow-up. Browser Use's session design
implies it (the browser belongs to the session, and interrupting a run is
built to continue in the same browser), but no document says it outright. If
it does not, the owner's view would lose its connection, and hand-back would
continue in a fresh browser. Whether a phone's keyboard opens inside Browser
Use's viewer is up to that viewer.

## Browserbase browser

`tests/browserbase.test.ts` runs the employee's step-by-step browser tools
against a **real headless Chromium** reached over CDP, exactly as a Browserbase
session is reached, with a stand-in for Browserbase's session API and a local
shop site. The stand-in follows Browserbase's API as its official SDK
(`@browserbasehq/sdk` 2.21.0) defines it: `POST /v1/sessions` with
`X-BB-API-Key`, `GET /v1/sessions/{id}/debug` for the live view, and
`POST /v1/sessions/{id}` with `REQUEST_RELEASE` to end it. Established:

- no browser is started until the owner approves opening one (it is a
  `computer` action), and the approval card says what for;
- the employee opens a browser, goes to a page, reads its text and controls,
  clicks, types, submits and screenshots it; the screenshot becomes an owned
  artifact; the live view is recorded for the phone but never returned to the
  model, and the API key goes to Browserbase only -- it is in no receipt,
  action or event;
- it refuses to press a button that places an order or pays, judged both by
  what it was asked to press and by the element actually hit (visible text,
  value, label, title), so a "Place order" submit input is refused too;
- it refuses to type into password fields (by type, even with an innocent
  label), one-time-code and payment autocomplete fields, and fields labelled as
  passwords, card numbers, security codes, expiry, PINs or account numbers;
- while the owner has taken the browser over, the employee's next step waits
  and sends nothing; it continues after hand-back;
- another owner's task cannot use the browser;
- stopping the task, or its finishing, releases the session at the provider
  and drops the live link;
- mutation-checked: removing the element-name check, the password-type check
  or the owner wait each makes a test fail.

End to end (below, 8 checks): opening the browser asks first; taking it over
is immediate; while the owner drives, the shop receives no requests from the
employee and its task waits rather than failing; handing back lets it finish;
every step is on the record; the answer came from the page it read; and the
session is released as soon as the task is done.

`tests/suppliers.test.ts` also covers `offer_record`: an offer read on a
website joins the supplier comparison marked as read from a website and
unverified, and checkout refuses it, since no supplier connection stands behind
it.

**Not verified here**: a live Browserbase session. This environment's network
policy blocks `api.browserbase.com`; on the server, `bash deploy/doctor.sh`
checks the key against Browserbase itself.

## Local run (`deploy/local.sh`)

Run for real on Linux, from a fresh clone, with no terminal attached, with a
stand-in `claude` on the PATH: the same stand-in the Claude Code tests use,
which speaks Claude Code's protocol to the gateway's real bridge. This
session's own Claude Code login was never used. Established:

- one command checks Node and Claude Code, confirms Claude Code is signed in
  (asking it with the same environment the app will give it), writes
  `gateway/.env` (mode 600) with a generated access code and secrets,
  `AGENT_RUNTIME=claude`, `CLAUDE_CODE_OWNER` and `HOST=127.0.0.1`, keeps
  `data/` private (700), builds, starts the gateway and waits for it to answer;
- the gateway listens on 127.0.0.1 only (checked in `/proc/net/tcp`);
- in Chromium at phone size, the page carries the Vision-Bot-Pro name, the printed code
  signs in, and a typed task runs on the Claude Code runtime: Claude Code was
  started headless with the gateway's MCP config, and its two tool calls went
  through the governed tools, leaving receipts, a document and a saved memory.
  Settings says "Ready: Claude Code, signed in with your Claude subscription";
  there were no page errors;
- Ctrl-C (SIGTERM) stops it and frees the port; the next start skips
  reinstalling, takes seconds and keeps the same access code;
- when Claude Code is not signed in and there is no terminal to sign in from,
  it says what to run and starts nothing.

With the real binary (Claude Code 2.1.283), `tests/claude.test.ts` run offline
(`unshare -rn`) passes its startup contract, as above.

**Not verified here**: a real subscription login doing a real task (it runs on
the owner's machine), macOS (written for its stock bash 3.2 and BSD tools, not
run), and reaching it from a phone.

## The whole app, used like its owner (2026-09-28)

The app was set up the way its owner would -- a fresh clone, `bash
deploy/local.sh` in a real terminal on a PATH with Hermes and no Claude Code,
every question answered by typing -- and then used from an iPhone-sized
Chromium, one tap at a time, looking at each screen before the next.

**Real**: the gateway, the phone app, Hermes 0.19 driven by Gemini
(gemini-2.5-flash), Gemini Live for voice and camera through a LiveKit server
(v1.13.7, dev mode) on the same machine, the voice worker, and Chromium with a
camera fed a video of a part (a Moen 1222 box) and a microphone fed speech
made with Gemini's text-to-speech. Until the owner's Gemini credit was topped
up, a scripted OpenAI-compatible model stood in for Gemini behind Hermes.

**Stood in for**, because this environment cannot reach them or has no account:
Twilio (its Messages API, with delivery updates and replies signed by Twilio's
own library), Retell (create-phone-call, with call started / ended / analyzed
webhooks signed by retell-sdk), Browserbase (its session API, a real Chromium
per session driven over CDP, and an https live view streaming that browser's
screen and passing taps and typing back), the Home Depot, Lowe's, Amazon and
Walmart catalogs in the shapes their adapters map plus a local yard and a
specialty vendor, a supplier's MCP server with stock and exact-quote checkout
tools, and a hardware store website. Each checks its credential the way the
real service does.

Used, and working after the fixes below: every Settings capability shows
Ready; adding people; a text approved, delivered, replied to and reviewed; a
call declined, then approved, placed, transcribed and summarized; a stranger's
scam text left alone; the employee's browser watched, taken over (typing into
the store's search box from the phone), handed back, and refused at "Place
order"; six suppliers compared at once; a quote whose price rose after it was
shown refused, then a fresh quote approved and ordered with its receipt shown;
a question from the employee answered; a memory added and forgotten; the
employee renamed; a spoken question about what the camera sees answered from
the picture; a spoken request turned into a task and an approval; photos sent
and described; a task stopped; a task waiting for approval surviving a restart
and sending once after Resume; sign out, a wrong code, sign in.

Found and fixed along the way (each with a test): no way to add a contact from
the phone; typing lost on every screen when the gateway reported a change;
approvals showing internal ids, raw JSON and model-facing descriptions;
follow-up work titled with the employee's instructions; answers hidden on
Today; Hermes silently dropping the gateway's browser_type, browser_click and
web_search (its own tools have those names); refusals and never-made clicks
reported as "result unknown"; a click landing on a hidden label; a reconnect
replaying the whole event history until the rate limit locked the owner out;
the app's page policy blocking a LiveKit on the same computer; a conversation
showing "live" with no one there; ending a call stopping the camera (black
photos, frozen viewfinder); the Camera tab never showing its camera, and
sending questions without the photo; placed orders not shown; call outcomes
served as escaped JSON; markdown shown as symbols; the local setup not routing
replies, asking for the Gemini key twice, and asking every skipped extra again
on every start.

**Not verified here**: real Twilio, Retell and Browserbase accounts, the
suppliers' real partner APIs, LiveKit Cloud, and the app on a real phone over
https.

## Google sign-in (Clerk)

`gateway/tests/clerk.test.ts` signs session tokens the way Clerk does (RS256,
with Clerk's claims) and has Clerk's own library verify them through the real
routes, with a stand-in answering Clerk's user lookup. It checks who gets in
and as whom (the owner's email, a listed client, a listed `@domain`), and that
the server refuses a stranger, an unverified email, a token issued to another
site, a forged token, an expired token, and a request without the sign-in
page's header or origin. It also checks that taking an email off the list ends
its session, and that with the keys removed nothing is offered and Google
sessions end.

In a browser: the running gateway, with Clerk's script and API stood in on
Clerk's own host name (the browser resolves it to a local https stand-in with
a lab certificate), at a phone viewport. The sign-in screen offers Google and
the preview. Google sign-in lands in the app as the owner, and signing out and
in again works. A listed client gets an employee of their own with no tasks.
A stranger is refused with a clear message and offered a different account,
and switching works. "Start a preview" opens the preview on sample data. No
console errors and no blocked loads: all 11 checks pass.

**Not verified here**: Clerk's real servers and script, and Google's own
account screens. This environment cannot reach them. They need real Clerk keys
on the owner's computer.

## The published preview (`web/demo`)

The preview is the real phone app built with an in-page stand-in for the
gateway, as one self-contained page (`npm run build:demo` writes
`web/demo-dist/vision-bot-pro.html`) published as a claude.ai artifact. The
screens, their rules and their styles are the app's own. The stand-in answers
every route the app calls with the gateway's shapes and announces changes on
the event stream, and anything that texts, calls, browses or spends money
waits on an approval the owner decides in the app, as on the gateway.

Inside a claude.ai viewer, Claude does the tasks through the page's `sample`
capability, on the viewer's own account and after the viewer allows it. It gets
what a runtime gets from the gateway (the employee, its skills, memory,
contacts, recent results and the latest comparison) plus tools that raise the
app's own approvals: send a text, place a call, compare prices, buy against an
exact quote, use the browser, ask the owner, remember. Anywhere else, or when
the viewer declines, a scripted employee runs the same tools for a fixed set of
tasks and says so.

Simulated, and labelled on the page: texts and calls reach nobody, supplier
prices come from sample catalogs, orders buy nothing, and the browser is a
sample shop site drawn in the app's live view (a published page cannot frame
another site), which can be watched, taken over, typed into and handed back.
The camera is a drawn scene or a photo the viewer picks ("Use my photo"),
because a published page cannot open a camera. Voice conversation is not in
the preview: it needs LiveKit and Gemini Live on a server.

Checked with `npm run build:demo && npm run check:demo`: 31 checks in a
phone-sized Chromium, the page wrapped as the artifact host wraps it, under a
content policy that refuses every network request. Three passes: no Claude; a
stand-in for the viewer's `sample` that calls the page's tools the way Claude
does (tool list, size limits, no caching with tools, approvals, answers, tool
errors, a photo passed as an image); and a viewer who declines Claude.

Found and fixed in the app along the way: after switching to a screen without
the camera and back, the preview stayed paused on its old frame, so "Send
photo" and "Ask about this" sent a stale picture (`camera-screen.test.ts`).

**Not verified here**: a real `sample` call inside a claude.ai viewer (its
consent prompt, tool rounds and image limits), and the viewer's own frame
policies beyond what the page contract states.

## Installer and doctor

`deploy/install.sh` and `deploy/doctor.sh` were run for real in a fresh clone,
with no terminal attached (as an agent runs them), against stand-ins for
systemd and Caddy. The systemd stand-in starts each unit's `ExecStart` as its
`User=`, with its `EnvironmentFile` read literally. So "gateway running" means
the gateway actually started from the unit the installer wrote and answered
`/health`. Established:

- a first run with the answers given up front installs, builds, starts the
  gateway (in production mode, with the generated `STATE_SECRET`) and adds
  the site beside an existing Caddy site;
- with the services running as an ordinary user rather than root, the gateway
  can read its own code and the built app, `data/` and `.env` stay private to
  that user, and `doctor.sh` works without sudo;
- a second run keeps the address, the runtime, the access code, the secrets
  and every setting added by hand exactly (including `$` and JSON values),
  restarts the gateway, and does not add the Caddy site twice;
- if Caddy rejects the result, its file is put back byte for byte (or, if there
  was none, none is left) and the lines to add are printed;
- `doctor.sh` reads values as systemd does and reports the Hermes model
  provider, or its absence.

Before these fixes, the same install left a gateway that could not start:
sharp's Linux binary was missing, reproduced with the installer's own `npm ci`
command.

**Not verified here**: a real VPS, real systemd, real Caddy with a real
certificate, and the voice worker's Python install (no LiveKit credentials).

## End-to-end

Drives the built PWA in Chromium against a real gateway process -- real
database, run queue, tool gateway, approval gate and Hermes subprocess. Only the
model is a fixture, so assertions are about system behaviour rather than a live
model's wording.

Chromium supplies a synthetic camera and microphone, so the capture path runs
for real: `getUserMedia`, a live preview, freeze-frame as track mute, and a
still that travels to the gateway as owned evidence. `getUserMedia` exists only
in a secure context, which `http://127.0.0.1` is, so this is the same path a
phone takes over https.

Covered: sign-in and session hardening; a governed task through the runtime;
camera capture to evidence; honest degradation with no realtime credentials;
the approval gate; watching the employee browse and taking over, with Browser
Use and with a Browserbase browser the employee drives itself; cancellation; a task surviving the page being closed
mid-flight; isolation between two signed-in owners; idempotency, CSRF and
sign-out.

```bash
cd web && npm run build
cd web && npm run e2e                                    # 119 checks
```

Needs `HERMES_CHECKOUT` and `HERMES_PYTHON` as above; it exits 2 with
instructions if they are missing. `CHROMIUM_PATH` overrides the browser binary.

The suite is timing-sensitive on a loaded machine. Of three runs here, two
passed 90/90 and one stopped at 52/53, having waited the full 150s for the
Hermes subprocess to return supplier results while other suites were running.
Nothing in the gateway or the client differed between those runs. Treat a
single timeout on a busy machine as a result to reproduce on an idle one, not
as a pass.

It happened again with the restart-recovery change. Of four runs, the two on
an idle machine passed 119/119. The two run under load stopped on a 150s wait:
once for a long task to start, right after the whole gateway suite; once for
supplier search, while installer builds ran alongside.

**Root cause, found later: a bug in the phone app, not load.** The long-task
timeout recurred on an idle machine, and a failed run now prints every task's
status and the gateway log: the task had never been created. The text box was
rebuilt empty whenever the screen re-rendered, and the first background refresh
after sign-in could land between typing and Send, so Send quietly sent
nothing. Load only made that more likely by slowing the refresh. The supplier
timeout has the same shape, a typed task that never started, and very likely
the same cause. The box now keeps its text, cursor and focus across re-renders,
and Enter while busy keeps the text instead of discarding it
(`tests/today.test.ts`; 3 of its 5 checks fail against the old code).

## Current results

| Suite | Command | Result |
|---|---|---|
| Gateway typecheck | `npx tsc --noEmit` | clean |
| Gateway tests | `npm test` | 128 passed, 0 failed, 1 skipped (129 tests); the skip is the real Claude Code test, for the reason above |
| Web typecheck + build | `npm run build` | clean; entry 38.8 kB, 13.0 kB gzipped |
| Web tests | `npm test` | 107 passed (10 files) |
| End-to-end | `npm run e2e` | 119 passed |

`npm run lint` in `gateway/` (prettier --check) fails on 38 files (the two
Browserbase files are the newest). It already
failed on 20 at the `a62fb16` checkpoint, before any of this work: the
codebase's deliberate dense style does not match its own prettier config.
Reformatting it is a separate decision, so new files follow the surrounding
style and are reported too.

## Acceptance criteria

Labels are the handoff's: **VERIFIED**, **BLOCKED ON OWNER CREDENTIAL**,
**SCAFFOLDED**, **NOT IMPLEMENTED**.

| # | Criterion | Status |
|---|---|---|
| 1 | Phone visual question through the realtime layer, spoken result | IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — camera capture, freeze and upload are verified in a browser; the realtime conversation needs LiveKit and realtime model credentials. With none configured the gateway answers 503 and the app says so instead of offering a dead control (verified) |
| 2 | Visual context → execute → gateway → runtime → governed tool → evidence | IMPLEMENTED + VERIFIED (e2e) — a still captured from a live camera through `getUserMedia` becomes an owned artifact, is attached as authorised context, and the run completes through Hermes with an evidence link |
| 3 | Long task acknowledged fast, survives disconnect, completes later | IMPLEMENTED + VERIFIED (e2e) — acknowledged while still running, the page and its whole context are closed mid-task, the task completes with no client attached, and the result is present and on screen after reconnecting |
| 4 | Cancellation prevents hidden continuation | IMPLEMENTED + VERIFIED (e2e, `core.test.ts`, `permissions.test.ts`) — stopping marks it cancelled at once, and after the model would have finished it is still cancelled with no result and no artifact |
| 5 | Hermes selection, Codex through Hermes, controlled fixture | Hermes: IMPLEMENTED + VERIFIED against the official runtime (hermes-agent 0.19.0) in a real subprocess. Codex: IMPLEMENTED + BLOCKED ON OWNER CREDENTIAL — only the credential boundary is verified (`parity.test.ts`), not the provider path |
| 6 | SMS draft / approval / send / inbound status | Contract IMPLEMENTED + VERIFIED against fixtures (`communications.test.ts`): nothing reaches the provider before approval, the approval names the exact destination and text, a changed destination is refused, an uncertain send is never retried, and inbound webhooks are signature-checked, deduplicated and framed as untrusted. Live Twilio: BLOCKED ON OWNER CREDENTIAL |
| 7 | Outbound call objective / status / transcript / outcome | Contract IMPLEMENTED + VERIFIED against fixtures (`communications.test.ts`): approval names the objective, the webhook is signature-verified, applied once across duplicates and refused when its timestamp is stale. Live Retell: BLOCKED ON OWNER CREDENTIAL |
| 8 | Multi-supplier comparison with timestamped offers | IMPLEMENTED + VERIFIED against fixtures and end to end (`suppliers.test.ts`, `offers.test.ts`, e2e): every connected supplier is searched in parallel, one failing never erases the others, offers normalize into one model, a total is withheld when a component is unquoted, and the phone names who was not included. Live supplier accounts: BLOCKED ON OWNER CREDENTIAL |
| 9 | Purchase approval blocks unauthorised checkout | IMPLEMENTED + VERIFIED (`permissions.test.ts`) — a decision is bound to the exact arguments, "always allow" is refused for financial effects, and cancelling during checkout preflight prevents the order |
| 10 | Unauthorised access returns 403/404 without leaking | IMPLEMENTED + VERIFIED (e2e two-owner run, `http.test.ts`, `security.test.ts`) — a second signed-in owner sees none of the first's records, gets 404 for their task and artifact content, and cannot cancel their task |
| 11 | Reconnect does not duplicate messages, calls or purchases | IMPLEMENTED + VERIFIED for run submission (idempotency key, e2e), for uncertain external effects (`permissions.test.ts`), for message sends (`communications.test.ts`: the provider is called once and never again on its own), and for the event stream (`realtime.test.ts`: reconnect resumes from the last event rather than replaying). Duplicate suppression against a live provider: BLOCKED ON OWNER CREDENTIAL |
| 12 | Phone fully usable without glasses | IMPLEMENTED + VERIFIED — the PWA has no glasses dependency; the whole e2e run is a phone viewport with a phone user agent |

### Adapters

| Adapter | Status |
|---|---|
| Hermes runtime | IMPLEMENTED + VERIFIED against the official runtime in a subprocess |
| Claude Code (owner's subscription) | IMPLEMENTED + VERIFIED against a stand-in CLI through the real bridge and gateway (11 checks); startup contract VERIFIED with the real binary offline. Full model loop with the real binary: not yet run anywhere (runs on the server) |
| Anthropic Managed Agents | IMPLEMENTED + VERIFIED end to end against a protocol fixture over loopback (`managed.test.ts`, 7 checks): provisioning shape, governed tool slate, approval gate, refusal, policy-answered confirmations, stale-action handling and cancellation. Live Anthropic account: BLOCKED ON OWNER CREDENTIAL |
| Twilio SMS | Contract VERIFIED against fixtures; live account BLOCKED ON OWNER CREDENTIAL |
| Retell voice | Contract VERIFIED against fixtures; live account BLOCKED ON OWNER CREDENTIAL |
| Home Depot / Lowe's / Amazon / Walmart | Adapter, mapping, fulfillment and failure handling VERIFIED against fixtures; live accounts BLOCKED ON OWNER CREDENTIAL |
| Local and specialty suppliers | VERIFIED — configured through `SUPPLIER_CONFIG_PATH` and exercised end to end against a live local endpoint |
| eBay | Optional only; VERIFIED that it is not constructed unless `EBAY_ENABLED=true`, even with credentials present. Live account BLOCKED ON OWNER CREDENTIAL |
| Browser Use | Approval gate, unconfigured refusal, cancel, cleanup and cross-owner safety VERIFIED; live view and take-over VERIFIED against a stand-in service in a real browser. The v4 pause/resume paths and live-view host are unconfirmed against the live service; live account BLOCKED ON OWNER CREDENTIAL |
| MCP connectors | Config handling, https-only, owner scoping, credential requirement and the checkout-tool prohibition VERIFIED; a live connector BLOCKED ON OWNER CREDENTIAL |
| Deployment packaging | IMPLEMENTED + VERIFIED locally — the gateway serves the built PWA, warns when it is missing, and `/health` stays up. The container image is NOT built here: this sandbox has a docker client but no daemon |

## What no test here can establish

Live camera, microphone and realtime conversation need a real phone and
configured credentials. Every provider integration is exercised against a
fixture, which proves the contract the gateway enforces, not that the provider
behaves as documented. The container image is not built here: this sandbox has a
docker client but no daemon.
