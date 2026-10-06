# Fast web tasks: routing, head start, live browser

Before this, a web task waited on the agent runtime to start, decide to search,
and maybe decide to open a browser. Nothing showed until it had. Now the gateway
does the parts every web task needs the moment the task arrives.

```
task sent
  ├─ route (rules, < 1 ms; Jev when the rules only guess)
  ├─ live browser opens (Browserbase), shown on the phone
  ├─ quick search runs alongside it (Tavily / Serper / Exa / Brave / Gemini)
  │     └─ early findings and sources land on the task
  ├─ browser goes to the named store, else the best result, else a search page
  └─ employee starts (after up to HEADSTART_WAIT_MS) with the open browser
     and the search results, and carries on through the governed tools
```

## Pieces

| Piece | Where |
|---|---|
| Router (rules + Jev) | `gateway/src/employee/route.ts` |
| Head start | `gateway/src/employee/headstart.ts` |
| Search providers | `gateway/src/employee/web.ts` |
| Browserbase: early open, saved sign-ins, keep-open | `gateway/src/employee/browserbase.ts`, `browser.ts` |
| Phone: steps, early findings, live card, auto-open | `web/src/ui/progress.ts`, `web/src/ui/live.ts` |
| Tests | `gateway/tests/headstart.test.ts`, `web/tests/progress.test.ts`, `web/e2e` (`headStart`) |

## Routes

`quick_answer`, `search_then_answer`, `visible_browser`, `procurement_browser`,
`connected_app`, `approval_action`. A route only decides what the gateway starts
early. It grants nothing: every action is still checked by the ToolGateway.

## Governance

- The head start only reads: it opens a browser and goes to one page. It never
  clicks, types, sends or buys.
- It opens a browser without an approval card, because the owner asked for the
  browser to be visible at once. An owner who set browsers to "never" gets none.
- Guest browsers hold nothing of the owner's. The owner's saved sign-ins
  (a persisted Browserbase context) are used only for tasks about their own
  accounts ("my order", "log in"), and only if they have given standing
  permission to open a browser.
- One browser per task, shared by the head start and the employee. A task's own
  browser never blocks its next one; a kept-open one never blocks anyone.

## Jev

Jev is TypeSafe's judgment model: it answers typed multiple-choice questions in
one pass (it claims about 230 ms). It is called directly over HTTP
(`POST https://api.typesafe.ai/v1/systemone`) only for tasks the rules could only
guess at, with a 700 ms limit. Slow, failing, unsure (below 0.6) or unset means
the rules' answer stands, so Jev can never slow a task down by more than its limit.

The `jev-use` npm package (by `shitianfang`, published September 2026) is not
installed: the gateway needs one HTTP call, and adding a three-week-old package
from a single maintainer to the server was not worth it. The
`vlad-terin/jev-use` repository is not public.
