# Handoff to the operator agent (Hermes)

Everything that could be built and verified without live accounts is on `main`. What is left needs the open
internet, the owner's accounts and their keys, which the build environment did not have. This is the list, in
order. Each step says how to tell it worked. Stop and report at the first step that does not.

Read first: `CLAUDE.md`, `docs/CLAUDE-CODE-HANDOFF.md`. The rules there stand: never commit a key, keep every
purchase, message, send and delete behind the owner's approval, never claim something works without running it.

## What is already done and verified (no action needed)

| Area | Where | Verified by |
|---|---|---|
| Connected apps through Composio (Gmail, Slack, Calendar, Notion, Sheets, Docs, Outlook, Teams, Discord, Instagram, YouTube), approvals on every send/change/delete | `gateway/src/employee/composio.ts`, `docs/COMPOSIO.md` | gateway tests, browser round trip |
| Routines (daily, weekdays, weekly) and Ideas templates | `schedule.ts`, `web/src/ui/routines.ts` | tests, browser |
| Fast routing, head start (live browser + quick search at once), steps and early findings on the phone | `route.ts`, `headstart.ts`, `docs/FAST-WEB.md` | tests, end-to-end suite |
| `browser_do` (Jev deciding each step on the live Browserbase page, under purchase/secret/upload guards) | `browserbase.ts`, `docs/FIELD-WORKFLOWS.md` | real Chromium tests |
| Guest and signed-in browsers; retailer cookies encrypted on `/data` | `signins.ts` | real Chromium tests |
| Parts run: Gemini part ID, SKU matching, aisle/bay, walking route | `parts.ts` | tests |
| Damage inspection (phone mode, voice agent tool, employee tool) | `inspect.ts`, `web/src/ui/inspect.ts`, `agent/main.py` | tests; agent tool with the real LiveKit SDK |
| Hermes in the Fly image; `shared-cpu-2x`, 2 GB, 5 GB `/data` | `Dockerfile`, `gateway/fly.toml` | image built; a Hermes task ran inside it with a mounted volume |

Last full run: gateway 171 passed, 0 failed, 1 skipped (Claude Code binary, needs a network); web 189/189;
demo browser checks 31/31; end-to-end 129/129 (with Hermes `hermes-agent==0.19.0`).

## 1. Rotate the two keys that were pasted into chat

The Browserbase key and the TypeSafe (Jev) key were pasted into a chat. Create new ones in the Browserbase and
TypeSafe dashboards and revoke the old ones. Use only the new ones below. Never print a key to a log or a chat.

Done when: the old keys are revoked in both dashboards.

## 2. Settings on the server

The server's settings file is `gateway/.env` (installed with `deploy/local.sh`) or the repository's `.env`
(installed with `deploy/install.sh`, service `fieldagent`). Add or update, without removing other lines:

| Setting | Value | Needed for |
|---|---|---|
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | the new key; project id from the Browserbase dashboard | live browser |
| `TYPESAFE_API_KEY` | the new key | Jev routing and `browser_do` |
| `SEARCH_API_KEY`, `SEARCH_PROVIDER=tavily` (or `serper`) | a Tavily or Serper key | quick search in about a second |
| `GEMINI_API_KEY` | Google AI Studio key, with credit | part ID, inspection, Google search |
| `SIGNIN_VAULT_KEY` | `openssl rand -hex 32`, once; never change it after | saved Pro Xtra / Lowe's Pro sign-ins |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | from the LiveKit Cloud project (`wss://<project>.livekit.cloud`) | voice and camera |
| `COMPOSIO_API_KEY` | Composio project key | connected apps |

Then: `cd /opt/data/repos/Vision-Bot-Pro && git pull origin main && cd gateway && npm ci && cd ../web && npm ci && npm run build`,
and restart the gateway (`sudo systemctl restart fieldagent` for an install.sh server; otherwise however it runs).

Done when: `curl -s localhost:8788/health` answers, and the phone's Settings shows Quick search, Live browser and
Fast routing (Rules + Jev) as ready.

## 3. Live check

```bash
cd gateway && npm run live-check
```

One guest Browserbase session (a few cents), a Home Depot search, one Jev step, session closed. It never signs in,
adds to a cart or buys. Expected: every line `PASS`, ending "All live checks passed." Report the whole output.

If Home Depot shows a block or captcha page, report it: that decides whether Home Depot lookups need Browserbase's
stealth or proxy options (not built), and the rest still works.

## 4. Composio auth configs

In the Composio dashboard, create an auth config for each app to offer (Gmail, Slack, Google Calendar first). If
redirects are restricted, allow `https://<your domain>/?connected=*`. Then on the phone: Settings, Connected apps,
Connect Gmail, sign in, return.

Done when: Gmail shows "Connected as <address>", and a task "summarise my unread email from today" completes
without an approval card, while "send a test email to me" shows an approval card first.

## 5. Store sign-ins (Pro Xtra, Lowe's Pro)

Needs a Pro Xtra or Lowe's Pro account. On the phone: Employee screen, set the store ZIP. Ask "Check my Pro Xtra
price for 1/2 inch drywall". When the live browser shows the sign-in page, tap Take over, sign in by hand, tap
Hand back.

Done when: Settings, Store sign-ins says "Signed in to The Home Depot", and the same request a second time opens
already signed in. The employee never typed the password.

## 6. Field checks on a phone

- Today: "Find prices for 1/2 inch drywall at Home Depot". The live browser opens by itself within a second or
  two, steps appear, early findings show, then the answer.
- Today, camera on, Inspect for damage, point at a wall corner. Findings appear with boxes over the preview.
- Photo of a part plus "find me this replacement and where it is in the store". Expect a part description, ranked
  matches and a pick route document under Tasks.
- Voice (with LiveKit): "check this wall for damage". The agent answers and shows an Inspection card.

## 7. Fly.io (only if moving the gateway to Fly)

```bash
fly volumes create gateway_data --size 5 --region sjc -a visionclaw-gateway
fly secrets set STATE_SECRET=... SIGNIN_VAULT_KEY=... GATEWAY_TOKENS=... BROWSERBASE_API_KEY=... \
  BROWSERBASE_PROJECT_ID=... TYPESAFE_API_KEY=... GEMINI_API_KEY=... SEARCH_API_KEY=... SEARCH_PROVIDER=tavily \
  LIVEKIT_URL=... LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... COMPOSIO_API_KEY=... AGENT_RUNTIME=hermes \
  HERMES_PROVIDER=... HERMES_MODEL=... HERMES_API_KEY=... -a visionclaw-gateway
fly deploy --config gateway/fly.toml --dockerfile Dockerfile .      # from the repository root
fly ssh console -a visionclaw-gateway -C "sh -c 'cd /app/gateway && node --import tsx src/live-check.ts'"
```

Hermes is already in the image (`HERMES_CHECKOUT`, `HERMES_PYTHON` are set by it). Moving existing data: copy the
old server's data directory (database, artifacts, `signins/`) onto the volume before switching DNS, and keep the
same `SIGNIN_VAULT_KEY` or saved sign-ins are lost. The voice worker is a separate app (`agent/fly.toml`) and needs
the same LiveKit settings plus `GATEWAY_URL` and `GATEWAY_SERVICE_TOKEN`.

Done when: `https://<domain>/health` answers from Fly and the live check passes inside the machine.

## Known limitations to keep in mind

- Live accounts were never reachable from the build environment: Browserbase, Jev, Gemini, search, LiveKit Cloud,
  Composio and the retailers are verified against stand-ins only until steps 3 to 6 pass.
- Aisle and bay formats come from public product pages, not a live store session.
- A routine that delivers to Slack, Gmail or another app waits for approval on each delivery.
- The live view opens full screen rather than inline.
- `jev-browser` 0.1.1 is a young, single-maintainer package, pinned and reviewed; review again before upgrading.

## Reporting back

For each step: done or not, and the exact output or screen text for anything that failed. Do not paste keys.
