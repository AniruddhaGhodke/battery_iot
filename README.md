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
| `CONFIG_SET_TOPIC` / `CONFIG_ACK_TOPIC` | `emspl/a7f3c2/{slug}/config/set` / `…/ack` | Topic templates; `{slug}` is the pack's own segment |
| `CONFIG_ACK_TIMEOUT_S` | 20 | No acknowledgement within this and the request is given up on |
| `CONFIG_RESTART_GRACE_S` | 120 | How long telemetry may take to return after an acknowledged restart |
| `CONTROL_SET_TOPIC` / `CONTROL_ACK_TOPIC` | `emspl/a7f3c2/{slug}/control/set` / `…/ack` | Channel control topics, deliberately separate from configuration |
| `CONTROL_EXPIRY_S` | 60 | A control command the firmware receives after this must be ignored |
| `CONTROL_MAX_CURRENT_A` | 5 | The channel is not opened above this current |
| `OTA_COMMAND_TOPIC` / `OTA_STATUS_TOPIC` | `emspl/a7f3c2/{slug}/ota/command` / `…/status` | Firmware update topics |
| `SITE_ADDRESS` | empty | Public HTTPS name. **Ingest needs it too**: it is the URL packs download firmware from |
| `FIRMWARE_BASE_URL` | from `SITE_ADDRESS` | Override if images are served from somewhere else |
| `FIRMWARE_DIR` | `/data/firmware` | Where uploaded images are stored (`.firmware` outside production) |
| `OTA_DOWNLOAD_TIMEOUT_MIN` | 15 | How long a pack may spend downloading an image |
| `OTA_RESTART_GRACE_MIN` | 5 | How long it may take to come back after flashing |
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

## Remote configuration

The dashboard can send supported settings to a pack and show what the pack
answers. **/settings** (linked from the header) selects a device, sends only
the settings you tick, and tracks the result.

Ingest is the only process with broker credentials, so the browser never
holds them:

```
browser ──► /api/config (web) ──HTTP──► ingest ──MQTT──► emspl/a7f3c2/<slug>/config/set
                                           ◄──MQTT───── emspl/a7f3c2/<slug>/config/ack
```

| Purpose | Topic |
|---|---|
| Configuration command (ingest publishes) | `emspl/a7f3c2/<slug>/config/set` |
| Acknowledgement (device publishes) | `emspl/a7f3c2/<slug>/config/ack` |
| Channel control (ingest publishes) | `emspl/a7f3c2/<slug>/control/set` |
| Control acknowledgement (device publishes) | `emspl/a7f3c2/<slug>/control/ack` |
| Firmware update (ingest publishes) | `emspl/a7f3c2/<slug>/ota/command` |
| Update progress (device publishes) | `emspl/a7f3c2/<slug>/ota/status` |
| Telemetry (existing) | `emspl/a7f3c2/<slug>/data` |

`<slug>` is the pack's own topic segment. It is **learned from the telemetry
topic**, not configured by hand: the first reading from a pack records it in
`packs.topic_slug`. A pack that has never published cannot be configured, and
the settings page says so.

### Which device a command is for

The topic does not identify the pack. Every board the firmware has shipped so
far publishes on `emspl/a7f3c2/pack1/...` — the segment is hardcoded — so a
command on that topic reaches all of them. What separates them is
**`target_uid`**, a 12-hex-digit id the firmware derives from the ESP32's
eFuse MAC:

```json
{ "target_uid": "AABBCCDDEEFF", "telemetry_interval_ms": 30000 }
```

Each board compares it against its own UID and ignores anything that does not
match (`commandTargetsThisDevice` in the firmware's `main.cpp`). **Ingest puts
it on every command** — configuration, control and OTA. A command without it
is dropped by every pack and nothing is published back, so it looks exactly
like a device that is not listening.

The UID is therefore the pack's real identity, and `device_id` is only a label:

- It arrives in each payload as `device_uid` and is stored in `packs.device_uid`
  (unique). Readings are matched on it first, so a board that is renamed stays
  the same pack and keeps its history.
- A pack that has not reported one **cannot be sent anything**, and the pages
  say so. The firmware build running on a pack today may not send it; the first
  update to a build that does has to go on over USB.
- `device_id` is itself settable (below), which is how two boards that shipped
  with the same name are told apart without touching the hardware.

### Settings

Defined once in `lib/pack-config.ts` so the form and the server agree. Unknown
keys are rejected rather than forwarded — a device that receives a key it does
not understand may ignore the whole message. The browser is not trusted:
ingest validates every request again.

**Can be sent today** (the gateway's own behaviour):

| Key | Values | Restarts |
|---|---|---|
| `device_id` | 1–31 of `A–Z a–z 0–9 _ -` | no |
| `can_baud_kbps` | 250 only | yes |
| `telemetry_interval_ms` | 1,000–300,000 ms | no |

Renaming a pack with `device_id` changes only its label. The board keeps its
UID, so its readings keep going to the same row and its history is intact; the
packs table follows the new name on the next reading. The acknowledgement comes
back under the **new** name, which is why an ack is also matched on the topic
it arrived on.

250 is the only bitrate offered. The 192S protocol runs at 250 kHz and has no
bitrate command, so 500 would silence the BMS link; the field is kept only so
a pack can be put back if it is ever mis-set by other means.

**Defined but not sendable yet** — the BMS accepts all of these on CAN id
`0xF4`, but the gateway firmware does not forward them from MQTT. They are
listed so the values and limits can be agreed before firmware work starts, and
`validateSettings` refuses them until the `pending` flag is cleared.

| Key | CAN | Range | Group |
|---|---|---|---|
| `bms_over_discharge_mv` | `0x01` | 2,000–3,000 mV/cell | protection |
| `bms_over_charge_mv` | `0x05` | 3,400–3,800 mV/cell | protection |
| `bms_over_current_a` | `0x02` | 1–1,000 A | protection |
| `bms_over_temperature_c` | `0x06` | 0–100 °C | protection |
| `bms_low_temperature_c` | `0x18` | −100–0 °C | protection |
| `bms_discharge_recovery_mv` | `0x0B` | 2,000–3,300 mV/cell | protection |
| `bms_charge_recovery_mv` | `0x0A` | 3,200–3,700 mV/cell | protection |
| `bms_cell_diff_mv` | `0x17` | 0–5,000 mV | protection |
| `bms_power_off_mv` | `0x0E` | 2,000–3,300 mV/cell | protection |
| `bms_power_off_delay_s` | `0x0F` | 0–3,600 s | protection |
| `bms_auto_balance` | `0x08` | on / off | balancing |
| `bms_balance_start_mv` | `0x11` | 3,000–3,700 mV/cell | balancing |
| `bms_fan_start_c` | `0x1A` | 0–100 °C | thermal |
| `bms_ptc_start_c` | `0x1B` | 0–100 °C | thermal |
| `bms_capacity_ah` | `0x03` | 1–10,000 Ah | commissioning |
| `bms_series_count` | `0x04` | 1–192 | commissioning |
| `bms_hall_sensor` | `0x19` | 1, 2 or 3 | commissioning |
| `bms_power_on_default` | `0x0C` | on / off | commissioning |
| `bms_precharge_delay_s` | `0x16` | 0–600 s | commissioning |

### For whoever writes the gateway firmware

Three things the protocol document does not settle, which have to be agreed
before any of the BMS fields are enabled:

1. **Scaling is not stated anywhere.** The protocol gives a 16-bit value per
   command but never its units — whether a voltage is mV, 10 mV or pack volts,
   or whether a temperature is whole degrees or tenths. **MQTT carries
   engineering units** (mV per cell, A, °C) and the firmware owns the
   conversion, because the firmware can check its own writes against the
   BMS's broadcast of the same values in groups 1, 2 and 5. A factor-of-ten
   error on a protection setpoint disables protection, so none of these fields
   should be enabled until a write has been confirmed by read-back.
2. **Are the voltage setpoints per cell or per pack?** The fields above assume
   per cell, which is how a BMS protects cells, but the document does not say.
   Confirm before enabling.
3. **`0x08` is encoded backwards from everything else.** Auto-balance uses
   `0x0002` for on and `0x0001` for off, while `0x07`, `0x0C`, `0x0D` and
   `0x15` all use `0x0001` for on. `lib/pack-config.ts` keeps the inversion,
   but it is an easy one to get wrong in firmware.

Also worth doing while the firmware is open: **forward the setpoints the BMS
already broadcasts** (groups 1, 2, 5 and the MOS status in group 81) in the
telemetry payload. They are on the wire now and simply dropped. That gives
read-back for nothing, which is how "applied" should really be confirmed, and
lets the dashboard show the limits in force.

### Channel control

Opening and closing the pack's channel is a control action, not a setting, and
is handled separately (`lib/pack-control.ts`, the Channel control section on
/settings). Like the setpoints it is **pending** until the gateway firmware
forwards it.

**The protocol has one channel command, not two.** `0x07` switches the channel
as a whole; there is no separate charge-relay and discharge-relay command,
even though the BMS reports the two MOS states separately (group 81, byte 8)
and logs "damaged charging relay" and "damaged discharge relay" as distinct
faults. Separate control would need the vendor to confirm an undocumented
command or another bus.

What makes it different from a setting:

| | Why |
|---|---|
| Its own topic `.../control/set` and ACL entry | Permission to configure a pack and permission to open its contactor can be separated — remove two lines from the ACL to keep one without the other |
| `expires_at` in the payload | The broker keeps queued messages for an offline device (persistence on, 14-day session expiry). **The firmware must ignore a command past its expiry** — otherwise a command sent and forgotten fires when the pack reconnects |
| Interlock before publishing | The channel is not opened above `CONTROL_MAX_CURRENT_A` (5 A). Breaking a contactor under load arcs and can weld the contacts. Checked on the server against the pack's last reading, never in the browser |
| Refuses on stale telemetry | Without a recent reading the pack's state is unknown, and switching blind is worse than not switching |
| Confirmation in the dashboard | Neither button acts on a single click |

The payload on `emspl/a7f3c2/<slug>/control/set`:

```json
{ "action": "channel", "value": "off", "request_id": 42, "expires_at": 1795435000000 }
```

Acknowledgements come back on `.../control/ack` in the same shape as a
configuration ack.

Set **`bms_power_on_default`** (`0x0C`) to match whatever you decide: a channel
opened remotely closes again on the next power cycle unless that says
otherwise. The two belong together.

### What the firmware must publish

There is no acknowledgement frame in the configuration payload spec, so this
is the contract. On `emspl/a7f3c2/<slug>/config/ack`:

```json
{
  "device_id": "EM_PACK_57S_01",
  "request_id": 42,
  "status": "accepted",
  "applied": { "telemetry_interval_ms": 30000 },
  "error": null
}
```

- `status` is `accepted` or `rejected`. `result`/`state` and a boolean
  `ok`/`accepted`/`success` are accepted too.
- `error` is shown to the user verbatim on a rejection — make it specific.
- **`request_id` is not sent today** (the payload spec has no field for it, so
  ingest does not add one). Without it an acknowledgement is matched to the
  oldest outstanding request for that device, which is ambiguous with two in
  flight. Ingest only allows one open request per pack because of this. Echoing
  a `request_id` back is a small firmware change that removes the limitation.

### Status

| Status | Meaning |
|---|---|
| `pending` | Accepted by the server, not yet published |
| `sent` | The broker accepted the publish — **not** proof the device applied it |
| `downloading` | OTA only: the pack is pulling the image over HTTPS |
| `restarting` | Acknowledged; waiting for the pack to come back |
| `applied` | Acknowledged, and for a restart telemetry has resumed |
| `rejected` | The device refused it, with its reason |
| `timeout` | No acknowledgement, or it never came back after a restart |
| `failed` | The publish itself did not get through (usually the ACL) |

History is in `config_requests`:

```sql
select id, device_id, requested, status, requested_by, error
  from config_requests order by requested_at desc limit 10;
```

Commands are published at **QoS 1 with retain off**. A retained configuration
would be redelivered and reapplied every time a device reconnected.

### Broker access

`deploy/mosquitto/acl` grants `bms-ingest` write on `+/config/set`,
`+/control/set` and `+/ota/command`, and read on the three the device answers
on; the device account is the mirror of that. Ingest is the only client
permitted to write those three, which is what stops anything else
reconfiguring, switching or reflashing a pack. They are separate entries so
the three permissions can be separated later. After changing the ACL:

```bash
docker compose restart mosquitto
```

A `failed` request with "not authorized", or `broker refused subscription` in
the ingest log, means the ACL was not picked up.

### Testing it

```bash
# from the droplet, pretending to be a pack
docker compose exec mosquitto mosquitto_sub -u bms-ingest -P "$MQTT_PASSWORD" \
  -t 'emspl/a7f3c2/+/config/set' -v
```

Send a change from /settings and the payload appears. To answer it:

```bash
docker compose exec mosquitto mosquitto_pub -u emspl-device -P '<device password>' \
  -t 'emspl/a7f3c2/pack1/config/ack' \
  -m '{"device_id":"EM_PACK_57S_01","status":"accepted"}'
```

The page moves to Applied within a couple of seconds.

### Not included

- **TLS.** The broker listens on plain 1883. Worth adding before configuration
  commands travel over untrusted networks.
- **Per-user identity.** `requested_by` comes from the basic-auth username in
  front of the dashboard, so today every row says `admin`. Real attribution
  needs app logins (TODO 3).
- **BMS setpoints and channel control.** The 192S protocol does accept these
  (`0x01`/`0x02`/`0x05`/`0x06` and `0x07` on CAN id `0xF4`), but the gateway
  firmware does not expose them over MQTT yet. `lib/pack-config.ts` is where
  they are added once it does.

## Firmware updates (OTA)

**/firmware** (linked from the settings header) uploads a build and installs it
on one pack. The image is not sent over MQTT: the pack is told where to fetch
it and what it must hash to, and downloads it itself.

```
browser ──► /api/firmware  upload, hashed and stored as <sha256>.bin
browser ──► /api/ota ──► ingest ──MQTT──► emspl/a7f3c2/<slug>/ota/command
                                 ◄──MQTT─ emspl/a7f3c2/<slug>/ota/status
pack    ──HTTPS──► https://<SITE_ADDRESS>/firmware/<sha256>.bin
```

The command is exactly what the firmware checks for:

```json
{
  "target_uid": "AABBCCDDEEFF",
  "version": "1.1.0",
  "url": "https://bms.example.com/firmware/<64 hex>.bin",
  "sha256": "<64 hex>"
}
```

### How an update is verified

The file name **is** its SHA-256, computed from the bytes as uploaded. The same
hash goes in the command, so the dashboard cannot serve one file and promise
another. The pack hashes what it actually wrote to flash and refuses to boot a
mismatch, and the upload is rejected here if it does not start with `0xE9` (an
ESP32 image) or will not fit the 1.9 MB OTA partition — which catches the
`.elf` or the wrong `firmware.bin` before a pack erases a partition for it.

Nothing is "applied" until the pack comes back **reporting the version that was
sent**. A build that fails its own check on boot rolls back to the previous one
and publishes again as if nothing happened; comparing `firmware_version` is the
only thing that tells those two apart, and a rollback is reported as `failed`.

### Serving the image

Images live in a Docker volume (`firmware`), written by `web` and served by
Caddy from `/firmware/*.bin` **outside basic auth** — the ESP32 cannot send
credentials. Only `<64 hex>.bin` is ever written there, so a name has to be an
image's own hash to exist at all: the URL is the capability. There is no
listing, and nothing else is served from that path.

`SITE_ADDRESS` is passed to **ingest** as well as Caddy, because ingest is what
puts the URL in the command. The device requires `https://` and at most 255
characters, so an internal address will not do.

### Before the first update

Two things on the firmware side, neither of which the server can do:

1. **`include/otaCredentials.h` is empty.** `OTA_ROOT_CA_CERT` has no
   certificate in it, and `otaService.cpp` refuses every update while that is
   true — it publishes `rejected` with "OTA root CA is not configured", which
   this page shows verbatim. Paste in the PEM root CA for the dashboard's
   certificate (Let's Encrypt: ISRG Root X1) and flash once over USB.
2. **The first update per board must go on over USB.** A board running a build
   that does not send `device_uid` cannot be addressed by `target_uid`, so it
   cannot be reached over the air at all.

Also worth knowing: downloads are **Wi-Fi only** in this firmware release. A
pack on the cellular backup keeps the command and waits for Wi-Fi.

### Timings

A download is minutes, not seconds, and the pack stops publishing for the whole
of it — the download blocks the firmware's main loop and the restart follows.
Ingest tells the alert engine to expect that silence, so no "pack offline"
message goes to WhatsApp for an update in progress. If the update fails, normal
alerting resumes within a minute.

| Setting | Default | What it covers |
|---|---|---|
| `CONFIG_ACK_TIMEOUT_S` | 20 | Waiting for the first word from the device |
| `OTA_DOWNLOAD_TIMEOUT_MIN` | 15 | The download itself |
| `OTA_RESTART_GRACE_MIN` | 5 | Reboot, reconnect, clock sync |

A malformed command is the one case with no reply at all: the firmware only
writes the reason to its own console. The request then ends as `timeout`, and
says so.

## API

| Route | Returns |
|---|---|
| `GET /api/firmware` | Uploaded images and recent rollouts |
| `POST /api/firmware` | Stores an image (multipart: `image`, `version`, `notes`) |
| `POST /api/ota` | Starts an update: `{device_id, firmware_id}` |
| `GET /firmware/<sha256>.bin` | The image itself, for a device (no auth) |
| `GET /api/status` | Ingest (broker link, message counters, rejections, write buffer), database health and size |
| `GET /api/alerts?limit=&pack=` | Alert history with the cause analysis, plus what is raised right now |
| `GET /api/alerts/:id` | One alert and its full report |
| `GET /api/config` | Configurable packs and the recent request history |
| `POST /api/config` | Send settings to a pack (proxied to ingest, which owns the broker connection) |
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
ingest/commands.ts        remote configuration: publish, match acks, timeouts
lib/pack-config.ts        what may be set and within what bounds (shared)
lib/pack-control.ts       channel control: expiry, interlock, one command only
lib/config-data.ts        configuration queries for the dashboard
app/settings/             the settings page
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
