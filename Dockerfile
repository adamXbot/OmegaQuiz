# Minimal production image for omegaquiz.
# Node 24 LTS Alpine. pnpm is installed via npm, not Corepack — Corepack is
# no longer bundled with Node 25+.
FROM node:24-alpine AS deps
WORKDIR /app

# Install only production deps for a leaner final image. pnpm-workspace.yaml
# holds the pnpm overrides the lockfile was resolved with; --frozen-lockfile
# refuses to run without it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# The pnpm version has one source of truth: "packageManager" in package.json.
# Resolve it here instead of hard-coding it (see the header for why not
# Corepack). A "+sha512.…" integrity suffix is stripped; an empty result fails
# the build rather than silently installing whatever "latest" is.
RUN PNPM_VERSION="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]")" \
  && test -n "$PNPM_VERSION" \
  && npm install -g "pnpm@${PNPM_VERSION}" \
  && pnpm install --prod --frozen-lockfile

# ---- Runtime stage ----
FROM node:24-alpine AS runtime

# Pick up Alpine security patches released since the base image was built —
# CI's Trivy scan fails on any fixed HIGH/CRITICAL OS CVE — then add a tiny
# init so signals propagate correctly to Node.
RUN apk upgrade --no-cache && apk add --no-cache tini

# The runtime never runs a package manager: pnpm installed everything in the
# deps stage and the CLI is `node server.js …` (plus its `links` / `remint`
# subcommands). Dropping npm, npx, corepack and yarn removes their bundled
# dependencies (tar, brace-expansion, ip-address, …) from the container scan
# and shrinks the attack surface. The app's own deps live in /app/node_modules.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*

# Run as an unprivileged user.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app server.js questions.js package.json ./
COPY --chown=app:app public ./public
# Bundled sample question packs. The admin "Browse sample packs" flow reads
# the default SAMPLE_PACKS_URL (bundled:samples/manifest.json) from disk, so
# the image must ship this directory. CI runs the built image to check.
COPY --chown=app:app samples ./samples

# Branding config and the question bank are written at runtime — mount a
# volume here for persistence across container restarts.
RUN mkdir -p /app/data && chown -R app:app /app/data
VOLUME ["/app/data"]

USER app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# -s: register as child subreaper — Fly's init runs as PID 1, not tini.
ENTRYPOINT ["/sbin/tini", "-s", "--"]
CMD ["node", "server.js"]
