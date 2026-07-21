# Minimal production image for omegaquiz.
# Node 24 LTS Alpine. pnpm is installed via npm, not Corepack — Corepack is
# no longer bundled with Node 25+.
FROM node:24-alpine AS deps
WORKDIR /app

# Install only production deps for a leaner final image.
COPY package.json pnpm-lock.yaml ./
RUN npm install -g pnpm@11.0.6 \
  && pnpm install --prod --frozen-lockfile

# ---- Runtime stage ----
FROM node:24-alpine AS runtime

# Tiny init so signals propagate correctly to Node.
RUN apk add --no-cache tini

# Run as an unprivileged user.
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app server.js questions.js package.json pnpm-lock.yaml ./
COPY --chown=app:app public ./public

# Branding config and the question bank are written at runtime — mount a
# volume here for persistence across container restarts.
RUN mkdir -p /app/data && chown -R app:app /app/data
VOLUME ["/app/data"]

USER app

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
