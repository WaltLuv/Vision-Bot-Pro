# Claude Code Instructions

The authoritative production branch for VisionClaw is `main`.

Start with:

```bash
git fetch --all --prune
git checkout main
git pull --ff-only origin main
git log -5 --oneline
```

The verified phone-first implementation is already promoted into `main`. The historical branch `feat/phone-first-employee` may be used for comparison, but do not continue development there unless explicitly instructed.

Read `docs/CLAUDE-CODE-HANDOFF.md` before editing.

Do not replace Gemini Live/LiveKit. Preserve the existing Anthropic Managed Agents runtime while adding/verifying the provider-neutral boundary and Hermes target runtime. Reuse the existing gateway, auth, task history, browser automation, realtime events and mobile clients. Do not create a parallel backend.

Run the existing gateway tests and typecheck first. Then verify/build the real phone-first `web/` PWA. Keep all financial, communication, destructive and external side effects behind server-side approvals. Never commit secrets or claim completion without real verification.

All completed work must be committed and pushed to `main`:

```bash
git push origin main
```

At the end, report the exact `main` commit SHA, test results, blocked owner-credential actions, and known limitations.


## Procurement launch requirement

eBay is optional only. It is not the launch procurement strategy.

The launch must support Home Depot, Lowe's, Amazon, Walmart, configurable local suppliers and configurable specialty vendors through a provider-neutral supplier registry. Implement normalized offers, parallel search, price/inventory/fulfillment comparison, cart building, exact quote revalidation and approval-gated checkout. Use official APIs where available and approved Browserbase/Stagehand or MCP adapters where APIs are unavailable. Do not fake availability, checkout or order success. Add fixture tests for each adapter and document the owner credentials required for live verification.


## Field workflows scope

In scope (see `docs/IMPLEMENTATION-PLAN.md` and `docs/FIELD-WORKFLOWS.md`): Jev-driven Browserbase automation through the governed `browser_do` tool; guest (ZIP-targeted) and authenticated (encrypted cookies on `/data`, Pro Xtra and Lowe's Pro pricing, cart staging) browser sessions; part identification, parametric SKU matching and aisle and bay routing; Hermes in the Fly.io image on a `shared-cpu-2x` machine with a 5 GB `/data` volume; LiveKit Cloud with the owner's credentials; Gemini structural anomaly detection on camera frames. Checkout, sending and deleting stay approval-gated in every one of them, and jev-browser is never exposed as its own MCP server.

## Operator handoff

What is left needs live accounts and the open internet: follow `docs/HERMES-AGENT-HANDOFF.md` in order, starting with rotating the two keys that were pasted into chat, then `cd gateway && npm run live-check`.
