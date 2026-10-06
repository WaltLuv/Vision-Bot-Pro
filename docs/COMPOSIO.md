# Connected apps (Composio) and routines

Ported from the Muse AI mobile app clone's connector and scheduled-task flows, and
rebuilt on this gateway's own auth, ToolGateway, approvals, run queue and ledger.
No Supabase, no OpenAI Agents runtime and no client-side Composio calls were
brought across.

## Pieces

| Piece | Where |
|---|---|
| Composio REST client, app catalog, connections, governed tools | `gateway/src/employee/composio.ts` |
| Routine repeat rules, next-run computation, delivery inference | `gateway/src/employee/schedule.ts` |
| HTTP routes and the scheduler tick | `gateway/src/employee/routes.ts` |
| Phone: Connected apps card, connect prompt | `web/src/ui/connectors.ts` |
| Phone: Routines tab and idea templates | `web/src/ui/routines.ts` |
| Tests | `gateway/tests/composio.test.ts`, `web/tests/connectors.test.ts`, `web/tests/routines.test.ts` |

## Routes

All owner-scoped, behind the session cookie, and CSRF-checked when they change
something. They answer 503 when `COMPOSIO_API_KEY` is not set.

- `GET /api/composio/tools`: every app with this owner's status
- `GET /api/composio/connections`: only apps this owner has touched
- `POST /api/composio/tools/:toolId/connect`: returns a one-time `connectUrl`
- `GET /api/composio/tools/:toolId/status`: confirms with Composio
- `POST /api/composio/tools/:toolId/disconnect`: deletes the account at Composio
- `POST /api/workflows` takes `repeat` (`frequency`, `time`, `weekday`,
  `timezone`) and `delivery`; `PATCH /api/workflows/:id` pauses or resumes

## Connect flow

1. The phone asks to connect; the gateway finds the app's auth config and asks
   Composio for a link, with `callback_url` set to `/?connected=<app>`.
2. The phone navigates to the link (same tab: an installed PWA loses popups).
3. Composio sends the person back; the phone asks the gateway for the status,
   which asks Composio. The address bar is never trusted on its own.

Composio knows the owner as `vb_` plus a hash, not their email address. Account
ids stay on the server; the phone sees only the status and who it is connected as.

## How an app action is governed

The model gets six tools: `apps_connected`, `app_actions_search`, `app_read`,
`app_update`, `app_send`, `app_delete`. It names an app and an action slug from
search. The gateway then:

1. checks the slug belongs to that app (`GMAIL_` for Gmail);
2. classifies it from its verbs, strongest first: payment words are refused
   outright (purchases go through procurement approvals), then delete, then
   send, then change, then read; an unknown verb counts as a change;
3. refuses it if it came through the wrong tool (a send through `app_read`);
4. refuses with a "connect it in Settings" message, and tells the phone, if the
   app is not connected;
5. for anything but a read, waits for the owner to approve these exact
   arguments. "Always allow" is not offered and is refused server-side, because
   one standing approval would cover every app;
6. runs it against the owner's pinned account, logs a `connector_run` record
   and the usual receipt artifact.

A Composio refusal (`successful: false` or a 4xx) is recorded as failed: nothing
happened. A timeout or 5xx on a send or change is recorded as uncertain and is
never retried automatically; the owner reconciles it from the task.

Why not Composio's Tool Router session: it picks and runs the tool on Composio's
side, which would put the effect decision outside this gateway. Search plus
direct execute keeps the per-action classification and approval here.

## Routines

A routine is a workflow with a repeat rule. Each due time starts one ordinary
queued task, keyed by that time so a restart cannot start it twice; a routine the
server slept through runs once on waking. Delivery to an app is spelled out in
the task text and goes through `app_send` or `app_update`, so every delivery
waits for the owner's approval like any other send. The result also lands in the
app either way.

## Known limitations

- Not run against a live Composio project from this repository.
- Action slugs are Composio's; classification is by verb, so an oddly named
  action may be treated as a change (safe) rather than a read.
- A routine that delivers to an app needs the owner to approve each delivery.
- Routine schedules come from a form, not free text.
