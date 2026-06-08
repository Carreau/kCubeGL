# kCube — container image for Coolify (or any Docker host).
#
# The app has NO runtime npm dependencies and no build step: it serves raw ES
# modules and uses only Node built-ins (node:http, node:sqlite, node:crypto).
# node:sqlite requires Node >= 22.5, so we pin a modern Node 22 base.
FROM node:22-alpine

# Small init so Node receives SIGTERM/SIGINT cleanly (graceful container stop).
RUN apk add --no-cache tini

WORKDIR /app

# Copy only what the server needs to run (see .dockerignore for exclusions).
# There is nothing to `npm install` — the only npm package (playwright) is a
# devDependency used by the test suite, not by the running server.
COPY package.json ./
COPY src ./src
COPY server ./server
COPY index.html play.html ./

# SQLite lives on a persistent volume so scores/accounts survive redeploys.
# Coolify should mount a volume at /data and this is where the DB file goes.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    KCUBE_DB=/data/kcube.sqlite

RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
USER node

EXPOSE 8080

# Container-level health check hitting the API's /api/health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.mjs"]
