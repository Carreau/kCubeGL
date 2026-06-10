# Deploying kCube on Coolify

kCube runs as a single Node process that serves both the static game and the
JSON API. Today it needs no build step and no runtime npm dependency — the
container just runs `node server/server.mjs` on Node 22 (required for
`node:sqlite`). If you add dependencies or a build step, run `npm ci` (and any
build script) in the image before launching.

## Quick start (Coolify)

1. **New Resource → Application** and point it at this Git repository / branch.
2. **Build Pack:** choose **Dockerfile** (recommended) — Coolify will build the
   included [`Dockerfile`](./Dockerfile). Alternatively choose **Docker Compose**
   and it will use [`docker-compose.yml`](./docker-compose.yml).
3. **Port:** set the exposed/ports value to **8080** (the app listens on
   `PORT`, default `8080`). Coolify's proxy terminates TLS and maps your domain
   to this port.
4. **Persistent storage:** add a volume mounted at **`/data`**. The SQLite
   database (`/data/kcube.sqlite`) holds accounts, attempts and leaderboards,
   so this must survive redeploys.
5. **Environment variables** (the Dockerfile already sets sensible defaults, but
   you can override them in the UI):

   | Variable    | Default               | Notes                                  |
   | ----------- | --------------------- | -------------------------------------- |
   | `PORT`      | `8080`                | Port the server binds.                 |
   | `HOST`      | `0.0.0.0`             | Bind address (keep `0.0.0.0` in Docker).|
   | `KCUBE_DB`  | `/data/kcube.sqlite`  | SQLite file path (on the volume).      |
   | `NODE_ENV`  | `production`          | —                                      |
   | `KCUBE_ADMIN_TOKEN` | *(unset)*     | Bootstrap secret to mint an admin (see below). |
   | `KCUBE_TRUST_PROXY` | *(unset)*     | Set to `1`/`true` behind a TLS-terminating proxy (see below). |

6. **Health check:** the app exposes `GET /api/health` → `{ "ok": true }`. The
   Dockerfile already declares a container `HEALTHCHECK` against it; you can also
   point Coolify's health check at `/api/health`.
7. **Deploy.** Once healthy, the landing page is at `/` and a puzzle is at
   `/play.html?puzzle=<name>` (named catalogue — there are no level numbers).

## Notes

- **Backend is optional.** If you ever want a static-only deploy, the game runs
  purely on `localStorage` — but the Docker image runs the full backend so
  accounts and leaderboards work.
- **Data persistence.** Only the `/data` volume matters. Redeploying rebuilds
  the image but leaves the volume (and therefore all scores) intact.
- **Bootstrapping an admin.** Admin is granted only when `POST /api/users`
  includes an `adminToken` matching `KCUBE_ADMIN_TOKEN`. Set that env var to a
  secret of your choice and use it once to create the admin account; if it's
  unset, no new admins can be minted via the API.
- **Passkeys behind a proxy.** WebAuthn/passkey login needs a stable HTTPS
  origin. Coolify's proxy terminates TLS and forwards `X-Forwarded-Host`/
  `X-Forwarded-Proto`, so set **`KCUBE_TRUST_PROXY=1`** for the server to trust
  those headers when deriving the WebAuthn origin/RP-ID — otherwise the origin
  (and passkeys) will be wrong.
- **Env config.** Neither env var is strictly required to just run the game, but
  `KCUBE_ADMIN_TOKEN` (to create an admin) and `KCUBE_TRUST_PROXY` (behind a
  proxy) are the two settings worth configuring. The per-user bearer tokens the
  app mints are stored in the DB and need no configuration.

## Run it locally with Docker

```bash
docker compose up --build        # http://localhost:8080
# or, plain Docker:
docker build -t kcube .
docker run --rm -p 8080:8080 -v kcube-data:/data kcube
```
