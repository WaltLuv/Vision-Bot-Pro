# Setup

Two packages run the phone-first employee: `gateway/` (the server and its API)
and `web/` (the phone client the gateway serves). `agent/` is the existing
realtime voice worker and `samples/` the native glasses apps; neither is
required to run the phone.

## Local

```bash
cd gateway && npm ci
cp .env.example .env          # then fill in at least GATEWAY_TOKENS
cd ../web && npm ci && npm run build
cd ../gateway && npm start
```

Open the gateway's URL. The client is served from `/`.

`GATEWAY_TOKENS` takes `token:userId` pairs; the token is the access code typed
into the sign-in screen. With it empty, nothing can authenticate and the gateway
says so at startup.

For client development with hot reload, run `npm run dev` in `web/` instead; it
proxies `/api`, `/livekit-token` and `/health` to `http://127.0.0.1:8788`.

## Node version

The tree is developed and tested on **Node 22**, and the image is built on
`node:22-alpine`. `gateway/package.json` still declares `engines: >=24`, so
`npm ci` prints an `EBADENGINE` warning on 22. It is a warning only and nothing
here depends on a Node 24 feature; aligning the two is a maintainer decision
rather than something to change silently.

The gateway uses `node:sqlite`, which prints an experimental-feature warning.

## The web build is not optional

The gateway serves the client from the build output, resolved relative to its
own source (`../../web/dist`), overridable with `WEB_DIST_DIR`. If that
directory has no `index.html`, startup logs:

```json
{"event":"web.missing","dir":"…","hint":"Run `npm ci && npm run build` in web/ …"}
```

and `/` returns 404 while the API and `/health` keep working. A 404 on `/` with
a healthy API means the client was not built, not that routing is broken.

## Container

The repository-root `Dockerfile` builds both packages into one image and
reproduces the repository layout inside it (`/app/gateway` and `/app/web/dist`),
so the same static path is correct in development and production. Build from the
repository root, not from `gateway/`:

```bash
docker build -t visionclaw .
```

The web stage runs the client's typecheck and build, so a client that does not
compile fails the image instead of producing a gateway that serves nothing.

## Deployment

`gateway/fly.toml` points at the root Dockerfile and expects a repository-root
context:

```bash
fly deploy --config gateway/fly.toml --dockerfile Dockerfile .
```

It mounts a volume at `/data` for `STORE_PATH`, `EMPLOYEE_DATA_DIR`, uploaded
artifacts and per-owner Hermes homes, and checks `/health` for readiness.

## Environment

Required to do anything:

| Variable | Purpose |
|---|---|
| `GATEWAY_TOKENS` | `token:userId` pairs; the access code for sign-in |
| `STATE_SECRET` | Signing secret for OAuth state |
| `PUBLIC_BASE_URL` | Public origin; must be HTTPS when `NODE_ENV=production` |
| `STORE_PATH` | Store file; its directory is the default data directory |

One runtime is required: `ANTHROPIC_API_KEY`; or `HERMES_CHECKOUT` plus
`HERMES_PYTHON` and a model provider credential; or Claude Code installed for
the service user and signed in with your own Claude subscription, with
`CLAUDE_CODE_OWNER` naming your account (see `docs/OWNER-ACTIONS.md` for why
only one account may use it). Several may be configured at once;
`AGENT_RUNTIME` (`anthropic`, `hermes` or `claude`) decides which carries out
tasks, and changing it and restarting moves every owner who was not given a
different engine on purpose. `deploy/install.sh` asks for whichever you have
and writes them all; `deploy/doctor.sh` reports on the selected one, checks an
Anthropic key against Anthropic, and asks Claude Code whether it is signed in. Optional
capability credentials, and what stays unavailable without each, are listed in
`docs/OWNER-ACTIONS.md`.

On your own computer, `bash deploy/local.sh` does all of this for whichever
runtime the computer has -- Hermes (it asks for the model provider, model and
key), Claude Code signed in with your subscription, or an Anthropic key. It
writes `gateway/.env` (mode 600) with generated secrets and `HOST=127.0.0.1`,
offers the optional extras (voice, browser, web search, texts, calls) on the
first run or with `--setup`, builds the app, starts the gateway and, with a
Gemini key and LiveKit, the voice worker. Settings it does not manage are kept
as they were.

Useful extras: `HOST` (address to listen on), `EMPLOYEE_DATA_DIR`, `WEB_DIST_DIR`, `RUN_CAPACITY` (1-99,
default 2), `AGENT_RUNTIME` (`anthropic`, `hermes` or `claude`),
`MANAGED_READ_TOOLS`, `CLAUDE_CODE_BIN`, `CLAUDE_CODE_MODEL`,
`BROWSERBASE_API_KEY` (a browser the employee drives and you can take over),
`BROWSER_USE_API_KEY`, `COMPUTER_CAPACITY` (browsers open at once, default 1),
`BROWSER_LIVE_VIEW_HOSTS`.

Every variable the code reads is listed by category, with what it does, in
the repository-root `.env.example`.

Invalid values for `AGENT_RUNTIME`, `RUN_CAPACITY`, `COMPUTER_CAPACITY`,
`BROWSER_LIVE_VIEW_HOSTS` (it becomes part of the page's Content-Security-Policy),
a non-HTTPS production `PUBLIC_BASE_URL` and a missing or short (under 32
characters) production `STATE_SECRET` are rejected at startup rather than
surfacing later as a confusing failure.
