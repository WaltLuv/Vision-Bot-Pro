# Implementation plan

Preserve Anthropic Managed Agents as the current default. Hermes becomes default only after live parity acceptance; no silent runtime switching during an active task. Keep Gemini/LiveKit as realtime eyes, ears and voice.

Acceptance order:

1. Durable task submission, owner isolation, replayable events, cancellation and restart recovery.
2. Governed typed tools with exact approvals, idempotency, per-owner connections and evidence.
3. Same employee through Managed and official Hermes Python library, model routing including Hermes openai-codex authentication.
4. Mobile PWA camera switching, explicit capture/upload, microphone/speaker, transcript, text fallback and reconnect. Worker returns completed runs during the same call.
5. Contacts, Twilio SMS, Retell voice, verified/deduplicated webhooks and outcomes.
6. Supplier offers/comparison, carts, exact quote validation and authorized checkout. No fabricated retailer APIs.
7. Browser/MCP/workflows/skills with bounded capacity and controlled external effects.
8. Runtime tests, security tests, PWA build, native environment checks, deployment and docs.

Every claim requires execution evidence. Fixture tests prove contract behavior; live provider success requires actual credentials. No fake successes, no permanently inferred spending authority, no provider secrets in clients.

## Field workflows scope (October 2026)

Three phases added to the scope. Detail, design decisions and status: `docs/FIELD-WORKFLOWS.md`.

1. **High-speed hybrid browser automation.** Jev (through `jev-browser`, used as a library) decides each step on
   the owner's live Browserbase page, under the gateway's own purchase, secret and upload guards. Two browser
   sessions: a stateless guest session for ZIP-targeted Home Depot and Lowe's lookups, and an authenticated
   session whose retailer cookies are kept encrypted on the `/data` volume, for Pro Xtra and Lowe's Pro volume
   (VPP) pricing and cart staging. Checkout stays approval-gated. First worker flow: Gemini identifies a part from
   a photo, parametric SKU matching ranks the replacements, and the aisle and bay of each item become a walking
   route through the store.
2. **Orchestrator on Fly.io.** Hermes (`hermes/bridge.py`, `hermes-agent` pinned) ships in the gateway image;
   `fly.toml` runs a `shared-cpu-2x` machine with a 5 GB `/data` volume for SQLite, artifacts, Hermes homes and
   the sign-in vault.
3. **Real-time streaming and vision.** The phone connects to LiveKit Cloud with the owner's LiveKit credentials
   (server-issued room tickets). Camera frames go to Gemini for structural anomaly detection, from the phone's
   inspection mode and from the voice agent.
