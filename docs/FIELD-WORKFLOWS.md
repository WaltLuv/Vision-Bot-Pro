# Field workflows: hybrid browser, parts run, Fly.io, inspection

## 1. Jev on the live browser (`browser_do`)

`jev-browser` 0.1.1 (an unofficial library around TypeSafe's Jev, reviewed and pinned) decides each click and
keystroke toward one stated outcome, about 300 ms per decision, on the same Browserbase page the owner watches.
The employee calls `browser_do` with one outcome ("set my store to the one nearest ZIP 78701", "add 12 to the
cart"); the step tools (`browser_read`, `browser_click`...) are still there for anything finer.

It is a library inside the gateway, never its own MCP server. As a server it would launch a second browser the
owner cannot see, take passwords as values, and upload any file path it is handed. Inside the gateway:

| Guard | Where |
|---|---|
| Stops before anything Jev judges irreversible, dismisses confirm dialogs (`allowIrreversible` is never passed) | jev-browser |
| No button that orders or pays, checked on the element about to be used | `GuardedJev.act` |
| No password, payment or one-time-code field | `GuardedJev.act` |
| No file upload (a path from the model would read this server's disk) | `GuardedJev.act` |
| No secret-named value or card-number-shaped value, before the page is touched | `browser_do` |
| Waits while the owner has taken the browser over | `GuardedJev.act` |

Offered only when `TYPESAFE_API_KEY` is set (`JEV_BROWSER=off` turns it off). Code: `gateway/src/employee/browserbase.ts`.

`gateway/src/cma.ts` is the Anthropic client and nothing else; the routing and session code lives with the
browser it drives rather than there.

## 2. Two browser sessions

| | Guest | Account |
|---|---|---|
| For | ZIP-targeted lookups at Home Depot and Lowe's | Pro Xtra and Lowe's Pro volume (VPP) pricing, staging a cart |
| Holds | nothing of the owner's | the owner's retailer cookies from the vault |
| Chosen by | default | tasks about the owner's account, Pro pricing or the cart; `browser_open` with `session: account` (approved) |
| Checkout | refused | refused: checkout goes through the approval-gated purchase path |

The owner signs in themselves (Take over in the live browser); the employee never types a password. When an
account browser is handed back or closes, its cookies for `SIGNIN_DOMAINS` (default `homedepot.com,lowes.com`)
are encrypted with AES-256-GCM under `SIGNIN_VAULT_KEY` and written to `/data/signins/<hash>.json.enc`. Other
sites' cookies are dropped; a tampered file is refused; "Forget saved sign-ins" in Settings and "Delete
everything" remove it. The head start only uses an account browser if the owner has said "always allow" to
opening one. The owner's ZIP is on the Employee screen and goes into the employee's instructions.

Code: `gateway/src/employee/signins.ts`, `browserbase.ts`.

## 3. The parts run

1. `part_identify`: Gemini looks at a photo (an attachment) and returns the part's parameters, each marked
   required or not with a confidence, plus a store search query. Observations only.
2. `sku_match`: candidates (the browser's reads, or a `products_search`'s offers) are compared attribute by
   attribute with units converted (1/2 in = 12.7 mm, M6, 12-gauge, 120 V); each is exact, candidate, unverified
   or mismatch, with what matched, conflicted or was not stated. Offers are relabelled so the comparison on the
   phone says which fit. Deterministic.
3. `store_location`: the aisle and bay from the product page in the browser ("Aisle 23, Bay 004", "Aisle 45 |
   Bay 6"), added to the task's pick list.
4. `store_route`: the pick list in walking order (aisle by aisle, up one and down the next, lettered areas last,
   unknown locations "ask at the service desk"), saved as a document.

Code: `gateway/src/employee/parts.ts`.

## 4. Fly.io

The image (repository-root `Dockerfile`) is Python 3.11 with Node 22 copied in from the official image, so it
needs no `apt` at build time. Hermes (`hermes-agent==0.19.0`) is installed in `/opt/hermes`, and
`HERMES_CHECKOUT`/`HERMES_PYTHON` point at it; `hermes/bridge.py` is at `/app/hermes`. `gateway/fly.toml` runs a
`shared-cpu-2x` machine with 2 GB and mounts the 5 GB `gateway_data` volume at `/data`.

Verified here: the image builds, and a container with a `/data` mount ran a task on Hermes to completion, with
the database, store and Hermes home on the volume. Not deployed to Fly from here.

## 5. LiveKit Cloud and inspection

The phone joins LiveKit with a room ticket the gateway mints from the owner's `LIVEKIT_URL`, `LIVEKIT_API_KEY`
and `LIVEKIT_API_SECRET`; for a `*.livekit.cloud` URL the page policy also allows the https check LiveKit makes
against regional hosts when a connection fails.

Structural anomaly detection: `POST /api/inspect` takes a camera frame, asks Gemini (`INSPECT_MODEL`, else
`VISION_MODEL`) for findings in a fixed schema (type, severity, confidence, location, box, next step), and keeps
the frame and findings as evidence. A high structural, electrical or fire finding always says to get a
professional, whatever the model said. Sources: the phone's Inspect for damage mode on Today (a frame every
3, 4 or 8 seconds, boxes drawn over the preview, one frame in flight at a time), the voice agent's
`inspect_structure` tool, and the employee's `structure_inspect` on an attached photo. Rate limited per person
(`INSPECT_RATE_LIMIT`, 30 a minute).

Audio is unchanged: the voice agent already streams it to Gemini Live.
