# Plan: TODO.md → production on a $6 droplet

Draft for discussion. Section 5 records what has been decided.

Target: one DigitalOcean Basic droplet ($6/mo: 1 vCPU, 1 GB RAM, 25 GB SSD,
1 TB transfer) running everything in Docker Compose.

---

## 1. Should we keep using MQTT? Yes. Change the broker, not the protocol.

What we need from ESP32 to server, and what each option provides:

| Need | MQTT | HTTP POST | WebSocket | CoAP/UDP |
|---|---|---|---|---|
| Continuous telemetry every few seconds | one long-lived connection, ~2 bytes framing | new request each time; TLS handshake on ESP32 costs ~1–2 s and ~40 KB RAM unless kept alive | yes | yes |
| Server → device commands (TODO 8) when the pack is behind NAT, CGNAT or a SIM | **same connection, built in** | device has to poll | yes, but we would write the protocol | poor through NAT |
| Online/offline detection (TODO 9) | **Last Will + retained status, built in** | timeout guess only | we would write it | we would write it |
| Delivery guarantee + reconnect | QoS 1, persistent sessions | write it ourselves | write it ourselves | CON messages |
| ESP32 support | mature (esp-mqtt in ESP-IDF, PubSubClient) | mature | ok | less common |

MQTT is built for this. HTTP only makes sense for occasional uploads.
WebSocket and CoAP would mean rebuilding things MQTT already provides.
LoRa/NB-IoT only matter if site connectivity is the problem, and a
57–192-cell payload every 5 s is too big for LoRa anyway.

**The real problem is the broker.** `broker.emqx.io` is public (TODO 7). Plan:

- **Mosquitto in Docker on the droplet.** It uses under 10 MB RAM and costs
  nothing extra. EMQX self-hosted needs 400 MB+, which won't fit. EMQX Cloud's
  free tier works but puts a session-minutes quota on growth.
- TLS on **8883**, one username/password per device plus one for the server,
  and an **ACL** so device X can only publish to `…/X/…`.
- For MQTT TLS, use a **private CA**: a long-lived server certificate, with
  the CA baked into the firmware (`setCACert`). Only devices connect to this
  port, never browsers, so Let's Encrypt brings nothing but renewal work, and
  pinning our own CA is stricter.
- **Cutover without waiting for a reflash:** a Mosquitto *bridge* pulls our
  topic from `broker.emqx.io` into the private broker until every device is
  reflashed. Then the bridge is removed.
- Turn on QoS 1 + persistent session for the server's subscription. If the
  ingest container restarts, the broker queues messages for it instead of
  dropping them.

## 2. Target architecture

```
ESP32 packs ── MQTT over TLS :8883 (per-device creds, ACL) ──┐
                                                             ▼
┌──────────────────────── droplet (Docker Compose) ───────────────────────────┐
│                                                                             │
│  mosquitto ──► ingest (Node worker) ──writes──► postgres + timescaledb      │
│                  │  validate, store, alerts,        ▲                       │
│                  │  notifications, commands         │ reads                 │
│                  └─► SMTP / webhooks             web (Next.js)              │
│                                                     ▲                       │
│  caddy :80/:443 (auto Let's Encrypt) ───────────────┘                       │
│  backup (nightly pg_dump → off-site object storage)                         │
└─────────────────────────────────────────────────────────────────────────────┘
Browser ── HTTPS ──► caddy
```

**Main change: split MQTT out of Next.js.** Today `instrumentation.ts` keeps
the subscription inside the web server. In production:

- **ingest** is the only service that talks MQTT. It parses messages with the
  existing `lib/telemetry.ts`, writes to the database, runs the alert rules,
  sends notifications, and later publishes commands and checks they took
  effect. It is small (~60 MB) and rarely changes.
- **web** (Next.js) reads only from the database. We will redeploy it often,
  and a redeploy no longer drops data or alerts.
- ingest also runs a small HTTP endpoint visible only inside Docker
  (`/status`, `/raw`). `/api/status` and the "live raw feed" page (TODO 5)
  read from it. Web never connects to the broker.

Both services live in one repo and share `lib/`. Next.js stays at the root so
the current code moves as little as possible.

```
app/ components/ lib/          Next.js, as now
lib/telemetry.ts               shared parser (used by ingest too)
ingest/                        worker entry point, bundled with esbuild
db/migrations/NNN_*.sql        plain SQL; Timescale DDL doesn't suit ORMs
docker/                        Dockerfile.web, Dockerfile.ingest, mosquitto/, caddy/
docker-compose.yml             production
docker-compose.dev.yml         local: db + mosquitto in Docker, `npm run dev` on host
```

## 3. Database: PostgreSQL + TimescaleDB

| | SQLite | **Postgres + TimescaleDB** | InfluxDB | DO Managed Postgres |
|---|---|---|---|---|
| RAM | ~0 | 150–250 MB tuned | 200 MB+ | none on droplet |
| Retention + roll-ups (TODO 2) | write it ourselves | **built in**: retention policy, continuous aggregates | built in | write it ourselves |
| Compression | none | **built in, ~5–10× on old chunks** | yes | none |
| Users, sessions, alerts, audit (TODO 3, 4, 8) | yes | yes | **no**, would need a second DB | yes |
| Two writers (ingest + web) | WAL works, but it's a file shared between containers | normal | – | normal |
| Cost | 0 | 0 | 0 | **$15/mo minimum**, over budget |

**Recommendation: Postgres + TimescaleDB, one database for everything.**
Telemetry goes in a hypertable. Users, sessions, alerts, packs, commands
and the audit log go in ordinary tables. Retention, hourly/daily roll-ups and
compression are TODO 2 requirements that TimescaleDB handles in a few lines
of SQL. The reference `bms_iot/server/schema.sql` was also written for it.
Use the plain `timescale/timescaledb` image, not `timescaledb-ha`, which is
several GB.

Tuning for 1 GB: `shared_buffers=128MB`, `effective_cache_size=384MB`,
`work_mem=4MB`, `maintenance_work_mem=64MB`, `max_connections=30`,
`timescaledb.max_background_workers=4`. Connection pools: web 5, ingest 3.

SQLite would also work for a handful of packs. It falls short once ingest
and web are separate containers and we want roll-ups and retention without
writing them ourselves.

### Schema (as built, `db/migrations/001_init.sql`)

```sql
packs        (id, device_id unique, label, site, layout smallint[]  -- e.g. {12,12,12,12,9}
              nominal_series, enabled, created_at)                  -- replaces ALLOWED_DEVICES

readings     -- hypertable on ts, 1-day chunks
  ts          timestamptz  -- ordering time, see "Time" below
  pack_id     int          -- packs.id
  received_at, device_at timestamptz; seq int; status text
  voltage, current, power, soc, remaining_ah, host_temp  real
  cells_mv    smallint[]   -- device sends 3 dp volts, so mV is lossless at 2 bytes/cell
  cell_min_mv, cell_max_mv, spread_mv smallint
  temps_dc    smallint[]   -- 0.1 °C by channel, null = not fitted; temp_max_dc smallint
  alarms      smallint     -- bitmask
  unique (pack_id, ts)     -- QoS 1 may redeliver; insert … on conflict do nothing
  compress after 2 days (segmentby pack_id, orderby ts desc), drop after 90 days

readings_1h  -- continuous aggregate: n, avg/min/max of V, I, SOC, spread, temps,
                bit_or(alarms). Real-time (includes the current hour). Kept forever.
readings_1d  -- continuous aggregate on readings_1h, weighted by n. Kept forever.
pack_latest  (pack_id pk, ts, received_at, first_seen, messages, reading jsonb)

-- later:
cell_stats_1d -- nightly job: per pack, per cell, per day avg/min/max (Phase 6)
users, sessions, alerts, alert_events, commands, audit_log  -- ordinary tables
```

History API: `/api/packs/[id]/history?from&to` returns at most ~800 points:
raw rows up to ~1 h, raw rows averaged into buckets up to 3 days, the
hourly roll-up beyond that, the daily one beyond ~2 years.

### Time: arrival vs device clock

TODO 2 says to key on arrival time. TODO 9 says to buffer to flash and replay
on reconnect. These conflict: replayed readings would all get the reconnect
time. Rule at ingest:

- `ts = device_at` when the device says its clock is NTP-synced (new
  firmware field `time_ok: true`) **and** it's within tolerance, or when it's
  a replay (`replay: true`) from a synced clock.
- Otherwise `ts = received_at`, as today. This covers the current firmware
  with its clock 3.7 h behind.
- Always store both, plus `seq` (a per-boot counter) so we can spot gaps and
  duplicates.

## 4. Fitting in 1 GB RAM and 25 GB disk

**RAM** (estimates, verified with `docker stats` after deploy; the limits
are hard caps set in Compose):

| Service | Typical | `mem_limit` |
|---|---|---|
| Ubuntu + dockerd | ~180 MB | – |
| postgres + timescale | 150–250 MB | 320 MB |
| web (Next.js `output: "standalone"`) | 120–200 MB | 300 MB |
| ingest | 50–80 MB | 150 MB |
| caddy | 20–40 MB | 64 MB |
| mosquitto | <10 MB | 32 MB |
| **Total** | **~550–750 MB** | plus a **2 GB swap file** as a safety net |

What doesn't fit, and isn't needed: EMQX, Grafana, Redis, and **building
images on the droplet**. `next build` will run out of memory there. GitHub
Actions builds the images and pushes them to GHCR (free). The droplet only
runs `docker compose pull && docker compose up -d`.

**Disk** (row ≈ 280 B for 57S, ≈ 550 B for 192S, one reading every 5 s =
17,280/day; compression assumed at 5–10×, to be measured in Phase 2):

| 90 days raw, compressed after 2 days | per pack per day | 10 packs | 100 packs |
|---|---|---|---|
| 57S | ~5 MB | ~0.5–1 GB | **~5.5–10 GB** |
| 192S | ~10 MB | ~1–2 GB | **~11–20 GB** |

Roll-ups add under 50 MB per pack per year. OS + images take ~5 GB, which
leaves ~20 GB. **Docker log rotation** (`max-size: 10m`, `max-file: 3`)
is required, or container logs will be the thing that fills the disk.

## 4a. Scaling to 100 packs and beyond

Target: 100 packs (20 messages/s), without slowing down as packs and history
grow. What keeps it flat:

| Risk as it grows | Design choice |
|---|---|
| Insert per message falls behind | ingest **buffers and writes once per second** in a single multi-row insert (and `pack_latest` once per second). Postgres does thousands of rows/s this way; 100 packs is 20 rows/s |
| Charts get slower as history grows | Charts never scan long raw ranges. Over ~2 days they read the hourly roll-up, so a 1-year chart costs about the same as a 1-day chart. Index on `(pack, ts desc)` inside daily chunks |
| Fleet page gets slower with more packs | It reads `pack_latest`, one row per pack, plus counters. 100 rows is trivial |
| Dashboard polling multiplies with users | One fleet request per poll, not one per pack. Detail data only for the pack on screen. Switch to SSE if it ever matters |
| Disk fills up | Compression after 2 days, automatic retention, and a disk-usage warning on `/api/status` at 70%. On the droplet, Postgres data lives on a **DO Volume** ($1 per 10 GB/mo), so disk grows separately from the droplet |
| One ingest process isn't enough | Mosquitto **shared subscriptions** (`$share/ingest/…`) split messages across several ingest containers with no code change. Inserts are idempotent, so overlap is harmless |
| Broker connections | Mosquitto handles tens of thousands of connections; 100 is nothing |
| Bandwidth | Device → droplet is inbound, which DO doesn't bill. 100 × 57S at 5 s ≈ 2.5 GB/day inbound |

**Growth path. Each step is a config/hosting change, not a rewrite:**

| Packs | Setup | ~$/mo |
|---|---|---|
| up to ~50 | $6 droplet as planned | 6 |
| ~100 | Same droplet + 50 GB Volume for the database (192S packs need it, 57S nearly fit without) | 11 |
| 100–300 | Resize droplet to 2 GB RAM (one click in DO, same disk) | 17 |
| 300+ | Database on its own droplet (or DO Managed Postgres), 2+ ingest containers | 30+ |

Phase 2's simulator includes a **load test at 2× target (200 packs at 5 s)**
on a container capped to the droplet's 1 GB, so we know the limits before
any real pack depends on them.

## 5. Decisions so far (2026-10-03)

| Topic | Decision |
|---|---|
| Where | **Build everything locally first** in Docker Compose. Buy the domain and deploy to the droplet once it's good enough |
| Scale | A few test packs now, **up to ~100 in the near future**. Must not slow down as packs or history grow (section 4a) |
| Database | Postgres + TimescaleDB |
| Broker | MQTT stays. Private Mosquitto is built and tested locally, then moved to the droplet as is |
| Raw retention | Default 90 days, a one-line setting (see below) |
| Alerts + notifications | **Deferred.** Designed for, not built now |
| Remote commands | **Deferred.** Designed for, not built now |
| Backups | Later, at deploy time |
| Reference code (`bms_iot`, `bms192s`) | Not available. Build from TODO.md directly |
| Firmware | Owner unknown. We write the payload contract; the server accepts both old and new payloads |

**Raw vs roll-ups:** *raw* means every single reading as it arrived (every
~5 s, all cell voltages). After the retention period raw rows are deleted
automatically. The *roll-ups* stay forever: hourly and daily
average/min/max per pack, plus per-cell daily stats. Last week can be zoomed
to the second; last year only to the hour. 90 days is the default, and
changing it is one line in a migration.

**Keep collecting data locally:** with the database in Docker on this
machine, history survives restarts from Phase 1 on. When we deploy,
`pg_dump` → `pg_restore` moves everything collected so far, so trend
analysis doesn't start from zero.

## 6. Phases: all local until "Deploy"

### Phase 1: Persistence + Docker (TODO 2) — done 2026-10-03
- [x] Restructure into `ingest/` + web, shared `lib/`. MQTT is out of Next.js
- [x] Migrations: schema above, hypertable, roll-ups, compression and retention policies
- [x] ingest buffers readings and writes once per second (multi-row insert, idempotent), plus `pack_latest`. `packs` table replaces `ALLOWED_DEVICES` (seeded from it); unknown devices are counted and listed, not stored
- [x] web reads from DB: existing routes + `/history?from&to` + range buttons
- [x] `docker-compose.yml` (db, ingest, web) with memory caps matching the droplet, log rotation, Dockerfiles, README, unit tests
- [x] ingest still connects to `broker.emqx.io` for now
- [x] **Done when** `docker compose restart` leaves dashboard and history intact

Measured during Phase 1 (synthetic 16S data, 10 days at 5 s = 172k rows):

| | Measured |
|---|---|
| Row size, uncompressed | ~267 B (16S) |
| Compression | **8.8×** (34 MB → 4 MB) |
| History query, any range | 8–25 ms |
| RAM idle | db 96 MB, web 42 MB, ingest 31 MB |
| Ingest restart, messages queued at broker | all delivered and stored |
| Database down for ~10 s | readings buffered, all written after |

Found and fixed: a backlog delivered in one burst arrives in the same
millisecond, and with arrival-time keys the readings collided and were
dropped as duplicates. Ingest now keeps arrival times strictly increasing
per pack.

### Phase 2: Device simulator + load test
A script that publishes realistic payloads for any number of fake packs
(16S, 57S as 4×12S+1×9S, 192S). Each scenario can be switched on: cell
drift, silent cell, over-temp, alarm flags, sum mismatch, wrong clock,
offline, duplicate messages. With only one real device, this is how we test
the fleet page and history at scale. It needs a broker of its own, so a
plain local Mosquitto joins the Compose file here (TLS comes in Phase 5).
**Load test:** 200 packs at 5 s against the 1 GB memory caps. Measure
insert lag, RAM, CPU, disk per pack per day and the real compression ratio.
Update the numbers in section 4.

### Phase 3: Auth (TODO 4)
scrypt from `node:crypto`, DB sessions in an httpOnly cookie,
viewer/operator/admin roles, first-run admin setup, and a check on every
API route.

### Phase 4: More pages (TODO 5)
Fleet overview (designed for 100+ packs: sort, filter, search, site
grouping), pack detail with time range, cell heat-map, live raw feed, device
management (label, site, layout, allowlist), CSV export, topology mismatch.
Pages show online/offline and BMS alarm flags from the data, as today; they
just don't raise alerts.

### Phase 5: Private broker, locally (TODO 7)
Mosquitto: TLS 8883 with a private CA, per-device credentials, ACL, shared
subscription for ingest, and a bridge from `broker.emqx.io` so the real
device keeps arriving. Device credentials are managed from the device page.
Same config goes to the droplet later.

### Phase 6: Trend charts (TODO 3 trends, TODO 12)
Nightly per-cell stats → charts on the pack page: imbalance slope in
mV/week, persistent outliers, step at module boundaries (the 9S drift),
thermal gradient. Simulator scenarios let us build it before real data has
built up. Charts only; turning trends into alerts waits for the alerts
work.

### Firmware contract (TODO 9), written whenever someone owns the firmware
`FIRMWARE.md`: the payload, NTP and `time_ok`, `seq`, `replay`, status with
Last Will, broker/TLS/credential settings, and the command topic reserved for
later. The server keeps accepting today's payload, so nothing waits on it.

### Deploy (TODO 11), when the local build is good enough
Buy domain → droplet setup (swap, firewall, SSH keys) → Volume for the
database → GitHub Actions → GHCR → `docker compose pull` → Caddy HTTPS →
move the local DB over → backups → uptime monitor.

**Alongside all phases:** bench verification (TODO 10).

### Deferred: noted, not scheduled

**Alerts + notifications (TODO 3 per-reading + workflow, TODO 6).** Runs in
ingest on every reading: alarm flags, thresholds, silent cell, offline, data
integrity, clock skew, hysteresis, dedup. Alerts page with acknowledge and a
recommended action. Email/webhooks, critical immediately, digest for
warnings, quiet hours in IST, rate limit, notify on transitions only.
Thresholds start with chemistry defaults, editable per device. The plan
leaves room for it: ingest already sees every reading in one place, and the
`alerts` tables slot into the same database.

**Remote commands (TODO 8).** Command rows written by web, published by
ingest, closed-loop verification, expiry, confirmation for dangerous
commands, audit log. Needs Phase 3 (auth) and Phase 5 (private broker)
first, plus firmware support. The command topic is reserved in the ACL and
firmware contract from the start, so adding it later needs no topic
redesign.

## 7. Monthly cost at deploy

| Item | $/mo |
|---|---|
| Droplet 1 GB | 6.00 |
| Volume for the database (when packs grow; 50 GB) | 0–5.00 |
| DO weekly backups (optional) | 1.20 |
| Off-site dumps (Cloudflare R2 / Backblaze B2 free tier) | 0 |
| Domain | ~1 |
| GHCR, GitHub Actions, Let's Encrypt, uptime monitor | 0 |

## 8. Still open (none of these block Phase 1)

- Largest series count we'll see (16S / 57S / 192S); decides when the Volume is needed
- Reporting interval, and whether sites use WiFi or SIM
- Cell chemistry (LFP?), needed only when alerts are built
- Firmware owner
