# EM Battery Monitor

Live dashboard and history for Exergi Murphy battery packs. The ESP32 on each
pack publishes JSON over MQTT. An ingest worker stores every reading in
Postgres + TimescaleDB, and a Next.js app shows it.

```
ESP32 ──publish──► mosquitto on the droplet, 159-89-160-225.sslip.io:1883
                   (login required, topic emspl/a7f3c2/+/data)
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
| `npm run alert:test` | Send one WhatsApp test message to `ALERT_RECIPIENTS` (needs the `WHATSAPP_*` settings in `.env.local`) |
| `npm run migrate` | Apply database migrations without starting ingest (ingest also does it at startup) |
| `npm run build:ingest` | Bundle ingest into `dist/ingest.mjs` (what the Docker image runs) |

## Deploy

Production runs on a DigitalOcean droplet (`159.89.160.225`, `/opt/battery-iot`)
from [`deploy/docker-compose.yml`](deploy/docker-compose.yml): db, the MQTT
broker (Mosquitto, port 1883), ingest, web, and Caddy for HTTPS on
https://159-89-160-225.sslip.io (basic auth).

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

### Broker accounts

The broker refuses anonymous clients. [`deploy/mosquitto/acl`](deploy/mosquitto/acl)
defines two accounts:

| User | May | Used by |
|---|---|---|
| `emspl-device` | publish to `emspl/a7f3c2/+/data` only | every pack (one shared login for now) |
| `bms-ingest` | subscribe to `emspl/a7f3c2/+/data` only | ingest (`MQTT_USERNAME` / `MQTT_PASSWORD` in `.env`) |

The passwords are only in `/opt/battery-iot/mosquitto/auth/passwd` (hashed)
on the droplet, plus `MQTT_PASSWORD` in `.env` for ingest. They are never in git. To set or
change one, on the droplet:

```bash
cd /opt/battery-iot
docker compose run --rm mosquitto mosquitto_passwd -b /mosquitto/auth/passwd <user> '<password>'
docker compose restart mosquitto     # reload logins (ingest reconnects by itself)
```

For `bms-ingest`, put the same password in `.env` as `MQTT_PASSWORD` and run
`docker compose up -d ingest`. For `emspl-device`, every pack must be
reflashed with the new password.

Per-pack accounts (each pack may only publish to its own topic) are a later
step; see TODO 7.

**Firmware settings:** host `159-89-160-225.sslip.io` (or `159.89.160.225`),
port **1883** plain TCP (no TLS yet; port 80 is the dashboard's), username
`emspl-device`, password from the droplet, topic `emspl/a7f3c2/<pack>/data`,
payload unchanged (schema 2, see [Payload](#payload)).

## Configuration (`.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://159-89-160-225.sslip.io:1883` | Broker the device publishes to. On the droplet `mqtt://mosquitto:1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | empty | The `bms-ingest` login (see [Broker accounts](#broker-accounts)) |
| `MQTT_TOPIC` | `emspl/a7f3c2/+/data` | `+` matches one level |
| `MQTT_CLIENT_ID` | `bms-ingest-<hostname>` | Fixed, so the broker can keep the session. Must differ from the droplet's ingest |
| `ALLOWED_DEVICES` | empty | `device_id`s added to the `packs` table at startup. **Only enabled packs are stored** |
| `AUTO_REGISTER_DEVICES` | `false` | Store any new `device_id` once it sends a valid reading. On in production: the broker login already decides who can publish. A pack with `enabled = false` stays blocked |
| `STALE_AFTER_S` | 60 | No message for this long = offline |
| `CLOCK_TOLERANCE_S` | 300 | How close a synced device clock must be to arrival time to be used |
| `DATABASE_URL` | `postgres://bms:bms_local@localhost:5433/bms` | Set by Compose inside Docker |
| `ALERTS_ENABLED` | `false` | Send WhatsApp alerts. Off: alerts are only logged (see [WhatsApp alerts](#whatsapp-alerts)) |
| `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` | empty | Meta Cloud API credentials. Secret |
| `WHATSAPP_TEMPLATE` / `WHATSAPP_TEMPLATE_LANG` | `battery_alert` / `en` | Approved template with 4 variables |
| `WHATSAPP_API_VERSION` | `v26.0` | Graph API version |
| `ALERT_RECIPIENTS` | empty | Numbers with country code, comma separated |
| `ALERT_MUTE_PACKS` | empty | `device_id`s that never alert |
| `ALERT_OFFLINE_MIN` | 10 | No reading this long = pack offline |
| `ALERT_SPREAD_MV` | 100 | Cell spread alert threshold |
| `ALERT_DEBOUNCE_S` / `ALERT_CELL_DEBOUNCE_S` | 10 / 120 | How long a BMS flag / cell check must hold before it alerts |
| `ALERT_CLEAR_S` | 60 | How long an alert must be gone before "cleared" |
| `ALERT_SYSTEM_DOWN_MIN` | 3 | MQTT or database down this long = alert |
| `ALERT_COOLDOWN_MIN` | 15 | Same alert again within this time is not resent |
| `ALERT_MAX_PER_HOUR` | 60 | Cap on messages per hour, all recipients together |
| `ALERT_ANALYSIS_TIMEOUT_S` | 8 | Give up on the 24 h cause analysis after this and send the alert without it |
| `ALERT_TIMEZONE` / `ALERT_TIMEZONE_LABEL` | `Asia/Kolkata` / `IST` | Times in messages |

Restart ingest after editing `.env.local` (`docker compose up -d` or the
`npm run ingest:dev` terminal).

**Packs:** the `packs` table is the allowlist. To stop storing a pack
without deleting its history:

```sql
update packs set enabled = false where device_id = 'EM_PACK_16S_03';
```

Ingest re-reads the table every 30 s. A device page for this is in TODO.md.

## WhatsApp alerts

Ingest sends a WhatsApp message to everyone in `ALERT_RECIPIENTS` when:

| Alert | Raised when | Cleared when |
|---|---|---|
| BMS alarm flag (over-current, over-discharge, over-charge, over-temperature, cell string error) | the flag is set for 10 s | it is off for 60 s |
| Cell reading 0 V | a cell inside the string reads 0 V for 2 min (sense-lead fault) | gone for 2 min |
| High cell imbalance | spread ≥ `ALERT_SPREAD_MV` (100 mV) for 2 min | below 80 % of that for 2 min |
| Pack offline | no reading for `ALERT_OFFLINE_MIN` (10 min) | the next reading ("back online") |
| MQTT broker unreachable | ingest disconnected for 3 min | connected for 60 s |
| Database unreachable | writes failing, readings piling up in memory, for 3 min | writes succeed for 60 s |

One message when an alert is raised and one when it clears, never one per
reading. Alarms that start together on one pack share a message. An alert
that comes back within 15 min of the last one it sent is not sent again
(flapping). Alarms in readings replayed from the device's offline buffer are
ignored. Raised alerts are kept in `alert_active`, so a restart or deploy
neither repeats them nor loses the "cleared" message. Every alert, sent or
not, is in `alert_log`:

```sql
select ts, pack, condition, kind, sent, error from alert_log order by ts desc limit 20;
```

### Cause analysis

When a **battery** alert is raised — a BMS alarm flag, a silent cell or a
widening spread — ingest reads that pack's last 24 h and works out what the
data says about the cause before the message goes out. Offline and system
alerts are not analysed.

The one-line verdict goes into the WhatsApp message ahead of the readings;
the full report lives on the dashboard at **/alerts** (linked from the header),
with the figures it used, the ranked causes and what to check.

What it separates, per condition:

| Alert | The question it answers | How |
|---|---|---|
| Over-temperature | One hot spot, the duty cycle, or the ambient? | Compares temperature channels against their median, and peak temperature in the top vs bottom current quartile |
| Over-charge | One weak cell or the charger setpoint? | Looks for a cell that tops out first, and whether the spread widens above 85 % SOC |
| Over-discharge | Resistance or capacity? | A cell that sags only under load is resistance (or a bad joint); one that is low at rest is capacity |
| Over-current | Inrush or a recurring load? | Counts separate episodes in 24 h and the peak in each direction |
| Cell reading 0 V | Loose lead, broken lead, or dead channel? | Intermittent vs continuous zeros, and whether the affected positions are adjacent |
| High imbalance | Resistance, capacity, or balancing? | Load-dependent vs SOC-dependent spread, and the trend against the previous 7 days |

Every rule is deterministic — the same readings always give the same answer,
and `lib/diagnose.ts` has no network calls or model in it. Where the data
cannot separate two causes the report says `possible` or `unclear` rather
than picking one. It is worked out from stored telemetry alone, so it points
at what to check; it does not replace checking it.

The analysis runs before the message is sent and is dropped after
`ALERT_ANALYSIS_TIMEOUT_S` (8 s), because a late alert is worse than one with
no explanation. Reports are kept in `alert_log.analysis` as JSON:

```sql
select ts, pack, condition, analysis -> 'summary' from alert_log
where analysis is not null order by ts desc limit 10;
```

Live state: `/api/status` → `ingest.alerts` (sent, failed, last error, what is raised now).

Not covered: if the ingest container itself dies, or the whole droplet goes
down, nothing is left to send the alert. An outside uptime check on the
dashboard URL (UptimeRobot or similar) covers that.

### One-time setup with Meta (WhatsApp Cloud API)

1. **Business portfolio.** At business.facebook.com, create a business
   portfolio for Exergi Murphy (or use the existing one). Business
   verification is needed for higher sending limits; alerts to a handful of
   numbers work before it.
2. **App.** At developers.facebook.com: Create app → Business type → add the
   **WhatsApp** product. This creates a WhatsApp Business Account and a free
   test number (the test number can only message up to 5 numbers you add as
   allowed recipients: fine for trying it out).
3. **Sender number.** WhatsApp Manager → Phone numbers → add a number that is
   not on the WhatsApp app (a new SIM, or a landline that can take the OTP
   call). Set its display name, e.g. "EM Battery Monitor".
4. **Template.** WhatsApp Manager → Message templates → Create:
   category **Utility**, name `battery_alert`, language **English** (`en`),
   body exactly:

   ```
   Battery monitor alert: {{1}}
   Pack: {{2}}
   Details: {{3}}
   Time: {{4}}
   Open the dashboard for live readings.
   ```

   Sample values for review: `Over-temperature` / `EM_PACK_57S_01` /
   `182.4 V, -31.2 A, SOC 64%, max temp 48.3 C` / `14 Nov, 12:04 IST`.
   Approval usually takes minutes to hours.
5. **Permanent token.** Business settings → Users → System users → Add
   (admin) → Assign assets: the app and the WhatsApp account, full control →
   Generate token with `whatsapp_business_messaging` and
   `whatsapp_business_management`, expiry **Never**. (The token on the app's
   API setup page expires after 24 h: don't use it in production.)
6. **Settings.** In `/opt/battery-iot/.env` on the droplet: `ALERTS_ENABLED=true`,
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (API setup page, *not* the
   phone number itself), `ALERT_RECIPIENTS`. Then `docker compose up -d ingest`.
7. **Test.**
   `docker compose exec ingest node ingest.mjs --test-alert` sends one test
   message to every recipient and prints Meta's answer for each.

| Error in the log | Fix |
|---|---|
| `code 190` | Token expired or wrong: use the System User token from step 5 |
| `code 132001` template not found | Name/language mismatch, or not approved yet |
| `code 132000` | Template doesn't have exactly 4 variables |
| `code 131030` | Test number: add the recipient under API setup → To |
| `code 133010` | Sender number not registered with the Cloud API |

Charges: Meta bills business-started messages per template category and
country; utility messages to Indian numbers cost a fraction of a rupee
each. See Meta's current pricing page.

## API

| Route | Returns |
|---|---|
| `GET /api/status` | Ingest (broker link, message counters, rejections, write buffer), database health and size |
| `GET /api/alerts?limit=&pack=` | Alert history with the cause analysis, plus what is raised right now |
| `GET /api/alerts/:id` | One alert and its full report |
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
| "Not connected to the MQTT broker", error `ENOTFOUND` | DNS. Some mobile carriers' DNS won't resolve the broker's hostname. Set DNS to `1.1.1.1` for that network, then restart ingest. Test with `nslookup 159-89-160-225.sslip.io` |
| "Not connected to the MQTT broker", `Not authorized` | Wrong `MQTT_USERNAME` / `MQTT_PASSWORD`; see [Broker accounts](#broker-accounts) |
| "Messages are arriving but all were rejected" | The `device_id` is not an enabled pack: add it to `ALLOWED_DEVICES`. The rejected ids are listed in `/api/status` under `ingest.packs.unknown` |
| Connected, nothing arriving | Device off, wrong login, or publishing to a different topic (the broker silently drops publishes the ACL doesn't allow). `docker compose logs mosquitto` on the droplet shows each device connecting |

`curl -s localhost:3100/api/status` shows the raw counters.

## Layout

```
ingest/main.ts            MQTT subscriber, validation, /status endpoint
ingest/writer.ts          batched inserts (once per second), buffer while the DB is down
ingest/packs.ts           packs table as allowlist, cached
ingest/alerts.ts          alert rules: when to raise and clear (pure, tested)
lib/diagnose.ts           24 h cause analysis: rules per condition (pure, tested)
lib/condition-label.ts    human names for conditions, shared by ingest and web
ingest/diagnose-data.ts   the SQL that gathers the 24 h window
lib/alerts-data.ts        alert history queries for the dashboard
app/alerts/               the alerts page and its full reports
ingest/notifier.ts        alerts -> WhatsApp queue, alert_active / alert_log
ingest/whatsapp.ts        Meta WhatsApp Cloud API template sender
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
