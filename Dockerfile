# Builds the gateway together with the phone client it serves.
#
# The gateway resolves the web build relative to its own source, so the image
# reproduces the repository layout (/app/gateway + /app/web/dist) and the same
# path works in development and in production. Build from the repository root:
#
#   docker build -t visionclaw .
#   fly deploy --config gateway/fly.toml --dockerfile Dockerfile .
#
# Node 22 is what this tree is tested on. gateway/package.json still declares
# engines >= 24, which only makes npm print EBADENGINE; see docs/SETUP.md.

FROM node:22-alpine AS web
WORKDIR /build
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/tsconfig.json web/vite.config.ts web/index.html ./
COPY web/public ./public
COPY web/src ./src
# Fails the image if the client does not typecheck or build, rather than
# shipping a gateway that serves nothing on '/'.
RUN npm run build

# The gateway's dependencies, built on Debian (glibc) to match the runtime below.
FROM node:22-bookworm-slim AS gateway
WORKDIR /app/gateway
COPY gateway/package.json gateway/package-lock.json ./
# tsx is a devDependency and `npm start` runs through it, so dev deps ship too.
RUN npm ci --include=dev

# Runtime: Python 3.11 for Hermes, with Node copied in from the official image.
# No apt step, so the build needs nothing but the two base images, npm and PyPI.
FROM python:3.11-slim-bookworm
COPY --from=gateway /usr/local/bin/node /usr/local/bin/node
WORKDIR /app/gateway
COPY --from=gateway /app/gateway/node_modules ./node_modules
COPY gateway/package.json ./

# Hermes, the self-hosted runtime, in the same image. The gateway starts
# hermes/bridge.py as a child process per task, so Hermes has to be on this
# machine; it is pinned to the release the test suite runs against. Its
# per-owner homes live on the /data volume (EMPLOYEE_DATA_DIR), not in the image.
ARG HERMES_VERSION=0.19.0
RUN python3 -m venv /opt/hermes \
 && /opt/hermes/bin/pip install --no-cache-dir "hermes-agent==${HERMES_VERSION}" \
 && /opt/hermes/bin/python -c "import run_agent" \
 && ln -s "$(/opt/hermes/bin/python -c 'import sysconfig;print(sysconfig.get_paths()["purelib"])')" /opt/hermes-site
ENV HERMES_PYTHON=/opt/hermes/bin/python
# The directory holding run_agent.py: site-packages of that environment.
ENV HERMES_CHECKOUT=/opt/hermes-site
# Playwright only connects to remote browsers (Browserbase) here; it never needs one downloaded.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY gateway/tsconfig.json ./
COPY gateway/src ./src
COPY gateway/public ./public
COPY --from=web /build/dist /app/web/dist
# The JSON-lines bridge into Hermes, at the path the gateway resolves it from (../../../hermes from src/employee).
COPY hermes /app/hermes

ENV NODE_ENV=production
ENV PORT=8788
EXPOSE 8788

# Operational data (store file, SQLite database, artifacts, per-owner Hermes
# homes) belongs on a mounted volume, not in the image layer.
VOLUME ["/data"]

# What `npm start` runs, without needing npm in the runtime image.
CMD ["node", "--import", "tsx", "src/server.ts"]
