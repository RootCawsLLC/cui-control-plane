# syntax=docker/dockerfile:1
#
# Build context is the cui-control-plane repo ROOT (so both the tool at / and the
# web app at /web are available). Referenced from CodeBuild as:
#   docker build -f web/Dockerfile -t <repo>:<tag> .

# ---- build: install the tool's deps, then build the web app ----
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS build
WORKDIR /repo
# python3/make/g++ so the tool's `duckdb` dependency can build its native addon
# from source if no prebuilt binary matches this Node ABI. The web demo itself
# never touches duckdb (it only reads fixtures), but `npm ci` still installs it.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*

# The tool first — its src/ and data dirs are what the web app's child process runs.
# No build step: the tool is pure ESM. `npm ci` also runs the tool's `prepare`
# hook, which is a clean no-op outside a git checkout.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY controls ./controls
COPY reference ./reference
COPY fixtures ./fixtures
COPY schemas ./schemas
COPY models ./models
# scripts/ must be present before the web npm ci: installing the file:.. tool
# dependency runs the tool's `prepare` hook (scripts/setup-git.mjs), which
# --ignore-scripts does not suppress for a linked dep. The hook exits 0 cleanly
# outside a git checkout, so it just needs to exist.
COPY scripts ./scripts

# The web app. Install with the tool already present so the file:.. dependency
# resolves to /repo, then build.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --ignore-scripts
COPY web ./web
RUN cd web && npm run build

# ---- runner: run `next start` with the full tree in place ----
FROM public.ecr.aws/docker/library/node:22-bookworm-slim AS runner
WORKDIR /repo
ENV NODE_ENV=production
ENV PORT=3230
# The child reads the fixtures bundled into web/, which travel with the container.
ENV CCP_ASSERTIONS_DIR=/repo/web/fixtures/assertions
# No toolchain here: unlike the build, the runtime never compiles anything and the
# demo never contacts a real system — it only spawns node to read bundled fixtures.

# Bring the whole built tree (tool src + node_modules, web .next + node_modules,
# scripts, fixtures). The web/node_modules/cui-control-plane symlink points at
# /repo, which exists at the same path here, so it resolves.
COPY --from=build /repo /repo

WORKDIR /repo/web
EXPOSE 3230
CMD ["npx", "next", "start", "-p", "3230", "-H", "0.0.0.0"]
