# TODO

Step 1 — live dashboard from MQTT — is done. Everything below is what remains,
roughly in the order it pays off.

The earlier Python implementation in `../bms_iot` already solves most of
these and has tests. Treat it as the reference when porting; file pointers are
given where useful.

---

## 2. Persistent history

Right now readings live in memory and vanish on restart. Nothing else on this
list (alerts, trends, reports) works without stored history.

- [ ] Pick storage. Options, simplest first:
  - SQLite (`better-sqlite3`) — one file, no server, fine for a handful of packs
  - Postgres + TimescaleDB — the existing Docker container on port 5433 works
    as-is; better for a fleet and long retention
- [ ] Write every accepted reading from `lib/store.ts` (same place it goes into memory)
- [ ] Table: one row per reading, `(pack_id, received_at)` key, pack totals,
      cell and temperature arrays. Reference: `bms_iot/server/schema.sql`
- [ ] Key on **arrival time**, not the device clock (see Firmware, NTP)
- [ ] `/api/packs/[id]/history?from=&to=` and a time-range picker on the dashboard
- [ ] Retention: raw 30–90 days, hourly/daily roll-ups kept for years
- [ ] Load latest-per-pack from the database at startup, so a restart
      doesn't blank the dashboard

## 3. Alerts

Reference: `bms_iot/server/alerts.py`, thresholds in `bms_iot/config/alerts.yaml`.

**Per reading**
- [ ] BMS alarm flags (over-current, over/under-voltage, over-temperature, string error)
- [ ] Thresholds: cell min/max voltage, cell spread, pack voltage, current, temperature
- [ ] Silent cell inside the string (sense-lead fault)
- [ ] Pack offline — no message for N minutes
- [ ] **Data integrity**: cells don't sum to pack voltage (caught the 60 V vs
      188.7 V test payload), power ≠ V×I, SOC ≠ remaining/rated
- [ ] **Device clock** off by more than a tolerance (the real device was 3.7 h behind)
- [ ] Hysteresis: an alert clears only after N clean readings
- [ ] Dedup: one open alert per pack per rule

**Trends (need weeks of history)** — the preventive-maintenance part
- [ ] Cell imbalance growth (spread slope, mV per week)
- [ ] Capacity fade
- [ ] Per-cell resistance drift
- [ ] Persistent cell deviation outliers
- [ ] Thermal gradient between modules
- [ ] Block-level stepping — see Hardware, balancing

**Workflow**
- [ ] Alerts page: open / acknowledged / closed, acknowledge with a name
- [ ] Every alert carries a recommended action, not just a title

## 4. Auth

Reference: `bms_iot/server/auth.py`.

- [ ] Email + password login, hashed (scrypt/argon2), DB-backed sessions
- [ ] Roles: viewer (read), operator (acknowledge alerts, send safe commands), admin (users, devices, dangerous commands)
- [ ] First-run setup screen to create the first admin
- [ ] Protect every API route, not just the pages

## 5. More pages

- [ ] Fleet overview: all packs, status, SOC, spread, open alerts, last seen
- [ ] Pack detail with selectable time range and larger charts
- [ ] Cell deviation heat-map over time (cells × time)
- [ ] Live raw feed — incoming MQTT messages, like MQTTX, inside the app
- [ ] Devices: labels, site, nominal cell count, module layout (e.g. 4×12S + 1×9S),
      allowlist managed in the UI instead of `.env.local`
- [ ] Export: CSV per pack and time range (one column per cell)
- [ ] Topology: detected vs configured series count, flag a mismatch

## 6. Notifications

Reference: `bms_iot/server/notify.py`.

- [ ] Email (SMTP; Gmail needs an app password) and webhook (Slack/Teams/SMS gateway)
- [ ] Critical alerts immediately; warnings batched into a digest
- [ ] Quiet hours (IST), hourly rate limit
- [ ] Only on the transition to open, never on every repeat

## 7. Broker security — before any real pack goes to site

`broker.emqx.io` is public: anyone can read your telemetry and publish fake
readings to your topic. The allowlist limits the damage; it is not security.

- [ ] Move to a private broker — EMQX Cloud Serverless (free tier) or a
      Mosquitto on the DigitalOcean droplet
- [ ] TLS on port 8883 (also gets through firewalls that block 1883)
- [ ] Separate credentials for the server and for each device
- [ ] ACL: each device may only publish to its own topic
- [ ] Change `MQTT_URL`, `MQTT_USERNAME`, `MQTT_PASSWORD` — no code change

## 8. Remote commands — only after step 7

Reference: `bms192s/protocol.py` (28 host commands), `bms192s/verification.py`.

- [ ] Command topic per pack, published by the server, executed by the ESP32
- [ ] **Never on a public broker** — commands change protection set-points and
      contactor state on packs up to ~205 V
- [ ] Closed-loop verification: confirm the setting in later telemetry
- [ ] Expiry: a command not delivered within minutes is dropped, not replayed later
- [ ] Explicit confirmation for dangerous commands (contactors, clearing history)
- [ ] Audit log: who sent what, when, and whether it applied
- [ ] Gateway restart; remote BMS power-cycle hardware (`bms_iot/docs/HARDWARE_REMOTE_POWER.md`)

## 9. Device firmware (ESP32)

- [ ] **NTP.** The clock is 3.7 h behind and the offset changes every power cycle:
      `configTime(0, 0, "pool.ntp.org"); while (time(nullptr) < 1700000000) delay(200);`
- [ ] `timestamp` and `unix_timestamp` disagree by 676 s — derive both from `time(nullptr)`
- [ ] Unique, fixed `device_id` per pack, matching `ALLOWED_DEVICES`
- [ ] Host temperature and module temps 3–4 read 0 — wire them or omit them
- [ ] Consider adding `mos_status` (contactor state) and `cycle_count`
- [ ] Retained `online`/`offline` status message with MQTT last will
- [ ] Buffer to flash while offline and replay on reconnect
- [ ] Contract: `bms_iot/docs/FIRMWARE_PAYLOAD.md`

## 10. Scaling and verification

- [x] Pack voltage, cell voltage, current, power — verified on real data
      (16 cells sum to 53.011 V vs 53.0 V reported; 53.0 V × 4.1 A = 217 W)
- [ ] Temperatures against a thermocouple
- [ ] Capacity against a full charge/discharge cycle
- [ ] Only if a raw CAN gateway is used instead of the ESP32 JSON: CAN scale
      factors, status-word bit order, temperature polarity
      (`bms_iot/docs/BENCH_TESTING.md`, `scripts/analyze_capture.py`)

## 11. Deployment (DigitalOcean)

Reference: `bms_iot/DEPLOY_DIGITALOCEAN.md`.

- [ ] Droplet, Node 20+, `npm run build && npm start` under pm2 or systemd
      (or a Docker image). **Not Vercel** — the MQTT subscription needs a
      long-running process
- [ ] Caddy or nginx in front with HTTPS
- [ ] Database on the droplet or managed, with backups
- [ ] `.env` on the server only, never in git
- [ ] Health check on `/api/status`, alert if the broker link drops

## 12. Hardware follow-ups (from the 57S discussion)

- [ ] 4×12S + 1×9S packs: the 9S module drifts low (seen as a ~15 mV step at cell 49)
- [ ] First check slave BMS boards aren't powered from the block they monitor
- [ ] If drift persists: bridge balancers across module boundaries, sized from
      the measured mV/week drift (needs the trend rules in step 3)
- [ ] Electrical sign-off on fusing and isolation before any change

---

## Known caveats of the current build

- Memory only: restart = empty dashboard until the next message
- Polls every 3 s; switch to Server-Sent Events if that becomes too chatty
- No auth: anyone who can reach port 3100 sees the data. Fine on localhost only
- Public broker (see step 7)
- On the iPhone hotspot, DNS must be 1.1.1.1 or the broker won't resolve
