# Movies Made Easy

A clean, day-at-a-glance view of what's showing across selected
[Event Cinemas](https://www.eventcinemas.com.au/) locations — built to quickly
decide **which film and which session to book** for a given day, then jump
straight to the booking page.

Live at **https://movies.slothic.dev**.

## Features

- **Movie-first grid** — box art, rating, runtime, genre.
- **Sessions per cinema** — time (am/pm), seats, and type (Gold Class, V-Max,
  ScreenX, Boutique, Original), each a one-click link to Event Cinemas booking.
- **Day picker** — today + the next 10 days.
- **Cinema selector** — searchable, state-grouped multi-select (defaults to
  Campbelltown & Ed Square); remembers your choice.
- **Movie filter** — narrow to specific titles; persists as you change dates.
- **Coming up later this week** — a strip of films starting later in the
  window; click to jump to their first session date.
- **Niceties** — collapse-all, low-seat highlighting, session-type filter
  chips, and a "Soon" badge for imminent sessions.

## How it works

The browser can't call `eventcinemas.com.au` directly (cross-origin, and it
can't set a non-bot `User-Agent`). So a tiny **zero-dependency Node proxy**
([`server.js`](server.js)) fetches the live `GetSessions` endpoint with
browser-like headers and serves the front-end ([`public/`](public/)) from the
same origin. Upstream responses are cached briefly (see `CACHE_TTL_MS`) so
multiple viewers share one fetch.

The cinema roster ([`public/cinemas.json`](public/cinemas.json)) is a static
list extracted from the Event Cinemas site; regenerate it if the roster ever
changes.

## Run locally

Requires Node 18+ (uses the built-in `fetch`). No dependencies to install.

```bash
node server.js
# → http://localhost:3000
```

### With Docker

```bash
docker compose up -d --build
# → http://localhost:3000
```

## Configuration

| Env var        | Default | Description                                            |
| -------------- | ------- | ------------------------------------------------------ |
| `PORT`         | `3000`  | Port the server listens on inside the container.       |
| `CACHE_TTL_MS` | `60000` | How long upstream responses are cached (ms).           |
| `HOST_PORT`    | `3000`  | Host port published by Compose. Set in `.env` if 3000 is taken (e.g. `HOST_PORT=3001`). |

## Deploy to the homelab

On the homelab machine (Docker + Compose installed):

```bash
git clone git@github.com:pauldamiani/movies-made-easy.git
cd movies-made-easy
# Optional: if host port 3000 is taken, pick another:
echo "HOST_PORT=3001" > .env
docker compose up -d --build
```

The container now serves on the host port (default `3000`, or your `HOST_PORT`).
To update after pushing changes:

```bash
git pull && docker compose up -d --build
```

## Expose publicly (Cloudflare Tunnel)

No open ports, no exposed home IP, automatic SSL — `cloudflared` makes an
outbound connection to Cloudflare and routes the public hostname to the app
over Docker's internal network.

1. **Cloudflare Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared
   connector). Copy the tunnel **token** (the long string after `--token`).
2. On the homelab, add it to `.env`:
   ```bash
   echo "TUNNEL_TOKEN=eyJ...your-token..." >> .env
   ```
3. Start the app **with the tunnel profile**:
   ```bash
   docker compose --profile tunnel up -d --build
   ```
4. Back in the tunnel, add a **Public Hostname**:
   - Subdomain `movies`, Domain `slothic.dev`
   - Service: **HTTP** → `movies-made-easy:3000`
   - Save — Cloudflare auto-creates the proxied DNS record.
5. Visit **https://movies.slothic.dev**.

> Alternative: front it with Nginx Proxy Manager + an `A` record to your public
> IP and 80/443 port-forwarding — but that opens inbound ports to your network.

## Note

Unofficial, personal project. Session and seat data come from Event Cinemas'
public endpoints and may be a short time stale due to caching.
