# EM Battery Monitor

Live dashboard and history for Exergi Murphy battery packs. The ESP32 on each
pack publishes JSON over MQTT. An ingest worker stores every reading in
Postgres + TimescaleDB, and a Next.js app shows it.

```
ESP32 ──publish──► broker.emqx.io:1883  (topic emspl/a7f3c2/+/data)
                          │
                          ▼  QoS 1, persistent session
                 ingest (Node worker) ── validate, parse, batch once per second
                          │
                          ▼
                 Postgres + TimescaleDB
                   readings      every reading, compressed after 2 days, kept 90 days
                   readings_1h   hourly roll-up, kept forever
                   readings_1d   daily roll-up, kept forever
                   pack_latest   newest reading per pack
                          ▲
                          │  reads only
                 web (Next.js) ── /api/...  ──► Dashboard (/), polls every 3 s
```

Ingest is the only process that talks to the broker. The web app never
holds an MQTT connection, so it can be restarted or redeployed without
losing data. While ingest itself is down, the broker keeps its messages
(persistent session) and delivers them when it reconnects. While the
database is down, ingest buffers readings in memory.

Plan and reasoning: [PLAN.md](PLAN.md). What's left: [TODO.md](TODO.md).

## Run it

Needs Docker (with Compose) and, for development, Node 24 (`node -v`).

```bash
cp .env.example .env.local        # then edit: ALLOWED_DEVICES at least
```

**Everything in Docker:**

```bash
docker compose up -d --build      # db + web -> http://localhost:3100 (no ingest, see below)
docker compose down               # stop (data is kept in the dbdata volume)
```

**Development** (hot reload; only the database in Docker):

```bash
npm install
docker compose up -d db
npm run dev                       # dashboard on http://localhost:3100
```

**Ingest runs only on the server.** It shares `MQTT_CLIENT_ID` with any
local ingest, and two of them keep kicking each other off the broker (and
would store everything twice). Locally, ingest is behind a Compose profile,
so it only starts when asked. If you need one locally, stop the server's
first (`docker compose stop ingest` on the droplet), or give yours a
different `MQTT_CLIENT_ID` and accept a second copy of the data:

```bash
docker compose --profile ingest up -d --build   # or: npm run ingest:dev
docker compose logs -f ingest                   # see messages arriving
```

A local database without ingest gets no new readings. On a new one, run
`npm run migrate` once to create the tables.

Port 3100 because Grafana from the old Docker stack used 3000. The database
is on `localhost:5433` (user `bms`, password `bms_local`, database `bms`):

```bash
docker compose exec db psql -U bms -d bms
```

Other commands:

| Command | Does |
|---|---|
| `npm test` | Unit tests (payload parsing, time rules, row conversion) |
| `npm run lint` | Type check everything |
| `npm run migrate` | Apply database migrations without starting ingest (ingest also does it at startup) |
| `npm run build:ingest` | Bundle ingest into `dist/ingest.mjs` (what the Docker image runs) |

## Deploy

Production runs on a DigitalOcean droplet (`159.89.160.225`, `/opt/battery-iot`)
from [`deploy/docker-compose.yml`](deploy/docker-compose.yml): db, ingest, web,
and Caddy for HTTPS on https://159-89-160-225.sslip.io (basic auth).

1. Push to `main`. GitHub Actions ([`.github/workflows/docker.yml`](.github/workflows/docker.yml))
   builds both images and pushes them to GHCR, tagged `latest` and `sha-<commit>`.
   Images are never built on the droplet: `next build` needs more than its 1 GB.
2. When the workflow is green: `./deploy/deploy.sh` (needs `~/.ssh/battery_iot_droplet`).
   Rollback: `TAG=sha-abc1234 ./deploy/deploy.sh`.

Server settings and secrets live in `/opt/battery-iot/.env` on the droplet
only (template: [`deploy/.env.example`](deploy/.env.example)). After editing it,
run `docker compose up -d` there.

```bash
ssh -i ~/.ssh/battery_iot_droplet deploy@159.89.160.225
cd /opt/battery-iot
docker compose ps                    # health
docker compose logs -f ingest        # messages arriving
docker compose exec db psql -U bms -d bms
docker stats --no-stream             # memory against the mem_limits
```

## Configuration (`.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://broker.emqx.io:1883` | Broker the device publishes to |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | empty | Not needed on the public broker |
| `MQTT_TOPIC` | `emspl/a7f3c2/+/data` | `+` matches one level |
| `MQTT_CLIENT_ID` | `bms-ingest-<hostname>` | Fixed, so the broker can keep the session. Unique on a public broker |
| `ALLOWED_DEVICES` | empty | `device_id`s added to the `packs` table at startup. **Only enabled packs are stored** |
| `AUTO_REGISTER_DEVICES` | `false` | Store any new `device_id`. Only on a private broker |
| `STALE_AFTER_S` | 60 | No message for this long = offline |
| `CLOCK_TOLERANCE_S` | 300 | How close a synced device clock must be to arrival time to be used |
| `DATABASE_URL` | `postgres://bms:bms_local@localhost:5433/bms` | Set by Compose inside Docker |

Restart ingest after editing `.env.local` (`docker compose up -d` or the
`npm run ingest:dev` terminal).

**Packs:** the `packs` table is the allowlist. To stop storing a pack
without deleting its history:

```sql
update packs set enabled = false where device_id = 'EM_PACK_16S_03';
```

Ingest re-reads the table every 30 s. A device page for this is in TODO.md.

## API

| Route | Returns |
|---|---|
| `GET /api/status` | Ingest (broker link, message counters, rejections, write buffer), database health and size |
| `GET /api/packs` | Every enabled pack that has sent data, with summary figures |
| `GET /api/packs/:id` | Latest full reading for one pack |
| `GET /api/packs/:id/recent?limit=360` | The last N raw readings, for the live charts |
| `GET /api/packs/:id/history?from=&to=` | Chart points for any range (epoch ms or ISO 8601; default last 24 h) |

`/history` returns at most ~800 points whatever the range:

| Range | Source |
|---|---|
| up to ~1 h | every raw reading |
| up to 3 days | raw readings averaged into 30 s – 5 min buckets, with min/max |
| up to ~2 years | hourly roll-up, re-bucketed |
| longer | daily roll-up |

The response says which (`source`, `bucketS`). The dashboard's range buttons
use it; `/?range=7d` opens a range directly.

## Payload

The device's JSON, schema 2:

```json
{
  "device_id": "EM_PACK_16S_03",
  "schema": 2,
  "unix_timestamp": 1790501119,
  "system_status": "ONLINE",
  "telemetry": {
    "total_voltage_v": 52.7, "total_current_a": 6.1, "soc_percent": 94.8,
    "remaining_capacity_ah": 9.4, "host_temp_c": 0,
    "cell_voltages_v": [3.299, 3.3, "...", 0, 0],
    "module_temps_c": [29.2, 28.7, 0, 0]
  },
  "alarms": { "over_current": false, "over_discharge": false,
              "over_charge": false, "over_temperature": false,
              "cell_string_error": false }
}
```

- The series count is detected from the data: trailing zero cells are padding.
  A zero *inside* the string is flagged as a sense-lead fault.
- Temperature channels reading exactly 0 are treated as not fitted.
- Cells are stored as whole millivolts (the device sends 3 decimals, so
  nothing is lost). A cell above 10 V or more than 256 cells rejects the
  message.
- Optional fields for the next firmware: `time_ok` (clock is NTP-synced),
  `replay` (sent from the offline buffer), `seq` (per-boot counter).

**Time.** Readings are filed under **arrival time** unless the firmware sends
`time_ok: true` and the device clock is plausible. Then device time is used,
which keeps replayed readings in the right place. Both times are always
stored. The current firmware's clock is 3.7 h behind, so today everything
uses arrival time and the dashboard shows the skew.

## No data showing?

The dashboard's empty state names the cause. The usual ones:

| Symptom | Cause |
|---|---|
| "Cannot reach the database" | `docker compose up -d db` |
| "The ingest service is not running" | `npm run ingest:dev`, or `docker compose up -d` |
| "Not connected to the MQTT broker", error `ENOTFOUND` | DNS. The mobile carrier's DNS blocks `broker.emqx.io`. Set DNS to `1.1.1.1` for that network, then restart ingest. Test with `nslookup broker.emqx.io` |
| "Messages are arriving but all were rejected" | The `device_id` is not an enabled pack: add it to `ALLOWED_DEVICES`. The rejected ids are listed in `/api/status` under `ingest.packs.unknown` |
| Connected, nothing arriving | Device off, or publishing to a different topic. Check in MQTTX |

`curl -s localhost:3100/api/status` shows the raw counters.

## Layout

```
ingest/main.ts            MQTT subscriber, validation, /status endpoint
ingest/writer.ts          batched inserts (once per second), buffer while the DB is down
ingest/packs.ts           packs table as allowlist, cached
db/migrations/*.sql       schema: hypertable, roll-ups, compression, retention
db/migrate.ts             migration runner (ingest runs it at startup)
lib/telemetry.ts          payload -> Reading, shared by ingest and web
lib/data.ts               database queries for the API routes
lib/ingest-status.ts      status types shared by ingest and web
app/api/...               route handlers
components/Dashboard.tsx  the page
components/CellBars.tsx   per-cell voltage bars
components/Sparkline.tsx  trend charts (plain SVG, min/max band)
docker/                   Dockerfiles for web and ingest
docker-compose.yml        db + ingest + web, memory caps match the 1 GB droplet
tests/                    node:test unit tests
```
