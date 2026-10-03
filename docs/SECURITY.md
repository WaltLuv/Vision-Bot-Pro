# Security

The model is replaceable and is assumed to be influenced by whatever it reads: a
web page, an attachment, an incoming message. Authority therefore lives outside
the model — in the gateway's records, permissions and approvals — and every
external effect passes through a typed tool the gateway governs.

Each boundary below names the test that holds it, so a regression fails a suite
rather than being noticed in production.

## Identity and sessions

Browser sessions are an HttpOnly, `SameSite=Strict` cookie, `secure` when
`NODE_ENV=production`, hashed at rest with a 7-day expiry. The access code is
exchanged for that cookie and is never stored by the client — not in
`localStorage`, not in `sessionStorage` (verified in the e2e run).

A session is bound to the grant that created it: if the underlying token is
revoked, `session()` deletes the session on its next use rather than letting it
outlive the credential. Sign-out deletes the row server-side, so the cookie is
useless afterwards (verified in the e2e run).

Google sign-in (through Clerk) ends in the same session. The gateway accepts a
Clerk session token only after Clerk's library verifies its signature, expiry
and issuer, and only when its `azp` names the page origin the request comes
from. It then asks Clerk for the account's primary email, which must be
verified and on the owner's list (`CLERK_OWNER_EMAIL`, `CLERK_ALLOWED_EMAILS`).
The exchange must carry the sign-in page's own header, which a page on another
site cannot send without this server's permission, and the server never gives
it. So no other site can sign a visitor in or out. The list is checked again on
every request, so removing an email ends its sessions, and turning Google
sign-in off ends them all (`clerk.test.ts`: forged, expired, wrong-site,
unverified and unlisted sign-ins are all refused). The sign-in page runs
Clerk's script under a policy of its own; the app's page never loads it.

Every mutating request from a cookie session must carry a matching
`x-csrf-token`; without it the gateway answers 403 and does no work (verified in
the e2e run). Sign-in is rate limited to 10 attempts a minute, the rest of the
API to 240.

## Ownership

Every record carries its owner, and reads and writes are scoped by it. Re-keying
an existing record to a different owner is refused at the store layer rather than
being caught per route, so a missed check in a new route cannot become a
cross-tenant read (`security.test.ts`, `http.test.ts`, `permissions.test.ts`).
An unknown id and someone else's id are indistinguishable to the caller.

Task attachments are checked at submission: an artifact the caller does not own
cannot be attached as context (verified in the e2e run).

## Approvals

Read and write effects are allowed by default. Communication, destructive,
financial, sensitive and computer effects require an explicit decision, and
financial always does regardless of policy.

- A decision is bound to one action, identified by a hash of its exact
  arguments. If the details change, the old approval does not carry over and a
  fresh request is required — approving one amount cannot authorise another.
- Approvals expire after 30 minutes, and an expired one cannot be decided or
  replayed. The client does not render an expired approval as actionable.
- "Always allow" is refused for financial effects by the gateway, and the client
  does not offer it for financial, destructive or communication effects at all.
- Cancelling a run denies its pending approvals in the same transaction.

Covered by `permissions.test.ts` and `store.test.ts`.

## External effects and replay

An external action that started but whose outcome is unknown is recorded as
`uncertain` and is never retried automatically. The run stops at `needs_user`,
and resuming is refused until a person records what actually happened. This is
what keeps a reconnect or a restart from sending a second message or placing a
second order (`core.test.ts`, `permissions.test.ts`, `store.test.ts`).

Submissions carry an idempotency key: re-sending one resolves to the existing run
rather than doing the work twice, and reusing a key for different work is an
error (verified in the e2e run). Inbound provider webhooks verify their
signature and the account they claim to come from, are deduplicated by provider
message id, and accept a status only if it moves forward — a replayed older
callback cannot walk a delivered message back to queued.

## The model runtime

The Hermes subprocess is given an explicit environment, not the gateway's. Model
provider credentials are forwarded; the gateway's own service credentials —
browser automation, SMS, voice, supplier, and the session secret — are not, and
a test asserts their absence (`parity.test.ts`). The model runs
attacker-influenced text, and those keys buy, send and browse.

Hermes tool search is disabled through its supported per-user configuration, so
the only tools reachable are the gateway's. Each owner gets a separate
`HERMES_HOME`. The hosted runtime's own toolsets are forced to `always_ask`, with
only an explicitly listed set of reads auto-permitted.

## Untrusted content

The client has no `innerHTML` path. Everything — model output, worker cards,
fetched pages, incoming messages — renders through a helper that only ever sets
`textContent`, so injection is impossible by construction rather than by
remembering to escape (`dom.test.ts`).

Uploads are classified by their bytes, never by the declared content type. JPEG
and PNG are re-encoded, which drops anything riding in the original container;
PDF, MP4 and real UTF-8 text are accepted; everything else is refused, including
an SVG or an HTML document posted as `image/png`. Filenames are stripped of path
separators and markup, and stored bytes are `0600` (`security.test.ts`).
Artifacts are served with `Content-Security-Policy: default-src 'none'; sandbox`
and `X-Content-Type-Options: nosniff`, so an uploaded file cannot execute in the
app's origin.

The app itself is served under `script-src 'self'` with no `unsafe-inline`; a
packaging test asserts the build ships no inline script and no cross-origin
asset (`build.test.ts`).

## Secrets

Errors leaving the API are redacted twice over: by field name for nested
structures, and by value against the process's own secrets, which is where
credentials actually appear — an upstream failure quoting a request URL, a stack
trace carrying a header. Cycles and deep nesting are handled rather than hanging
(`security.test.ts`).

No credential is stored in the client or shipped in its bundle. The realtime API
secret stays on the server; the phone receives only a 15-minute room token.

OAuth state for app connections is signed with `STATE_SECRET`. In production
the gateway refuses to start unless it is at least 32 characters; outside
production an unset or empty value falls back to a development-only secret,
and is never used as an empty signing key (`security.test.ts`). The example
environment files carry no placeholder credentials to copy by accident.

## Messages and calls

An outbound message or call is the model acting on the world through a contact
it resolved itself, so the approval is what stands between that and a real
phone. Nothing reaches the provider before a decision, and the approval record
names the exact destination and the exact text or objective being authorised.

The destination is re-checked against the stored contact at send time, so an
approval for one person cannot deliver to another number, and a blocked contact
is never messaged regardless. A send whose outcome is unknown is recorded
`uncertain` and refused on every later attempt: the provider is called once and
never again on its own.

Inbound webhooks are refused without a signature, with a signature from another
secret, and with a valid signature from a different provider account. A replayed
inbound message is stored and queued once. A replayed delivery status cannot
walk a delivered message back to queued, and a call webhook is refused when its
signature's timestamp is stale. An incoming message reaches the employee
explicitly framed as untrusted data carrying no authority to send or spend.

Covered by `communications.test.ts`.

## Connectors

A malformed connector file — unparseable, wrong shape, an unsafe id, an unknown
side-effect class, no owner — disables the connectors and is reported, rather
than failing the gateway to start. A connector reached over plain http is
refused, since its bearer token and every tool argument would travel in clear. A
connector is unusable by an owner it does not list and without its credential.

A connector cannot expose its own checkout tools as ordinary tools: checkout
goes through the exact-quote adapter, which re-prices and requires approval of a
specific total, and a second path would be an ungoverned way to spend money.

Browser work is approval-gated before it is attempted, refuses clearly when not
connected, cancels idempotently, cleans up sessions whose task has finished, and
cannot be cancelled by another owner. Covered by `adapters.test.ts`.

## Known gaps

- Rate limits are per process and keyed by client address. Multiple machines do
  not share a counter.
- Webhook signature verification is exercised against fixtures, not live
  providers.
- The container image is not built or scanned in this environment.
