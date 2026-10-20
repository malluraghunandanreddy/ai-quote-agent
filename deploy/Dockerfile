# Quote agent: one image for every client (settings come from each client's .env, data from a mounted folder).
# Build from the project root:   docker build -f deploy/Dockerfile -t quote-agent:1.0.0 .
# (or use deploy/build.sh, which also tags latest and can write a file to copy to a server)

# ---- build: compile TypeScript, keep only production dependencies ---------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
# better-sqlite3 is a native module; these let it compile if no ready-made binary exists for the platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npx tsc -p tsconfig.build.json \
 && npm prune --omit=dev

# ---- runtime: no compiler, no tests, no secrets, not root ----------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json schema.sql ./
# /data holds the database, backups and (for a bind mount) must be writable by the "node" user (uid 1000).
RUN mkdir -p /data /app/branding && chown node:node /data /app/branding
USER node
EXPOSE 3000
VOLUME ["/data"]
# Healthy = the mailbox is being checked (see /healthz). The grace period covers start-up and the first poll.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.DASHBOARD_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
