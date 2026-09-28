# EM Battery Monitor

Live dashboard for Exergi Murphy battery packs. A Next.js app that subscribes
to the MQTT topic the ESP32 publishes on and shows the latest reading per pack.

One app, no separate backend: the Next.js server holds the MQTT subscription
and the API routes; the browser only talks to Next.js.

```
ESP32 ──publish──► broker.emqx.io:1883  (topic emspl/a7f3c2/+/data)
                          │
                          ▼  subscribed once at server start (instrumentation.ts)
                 Next.js server ── lib/store.ts: latest + recent readings, in memory
                          │
                 /api/status  /api/packs  /api/packs/[id]  /api/packs/[id]/recent
                          │
                          ▼  polled every 3 s
                     Dashboard (/)
```

## Run it

Needs Node 20 or newer (`node -v`).

```bash
cd ~/Desktop/EMPSPL/IOT\ Software/battery_iot
cp .env.example .env.local        # then edit if needed
npm install
npm run dev
```

Open <http://localhost:3100>. Port 3100 because Grafana from the old Docker
stack uses 3000.

For a production-style run: `npm run build && npm start`.

It must run as a normal Node server (`next dev` / `next start`), on your Mac
now and a DigitalOcean droplet later. **Not serverless (Vercel)**: there the
process stops after each request and the MQTT subscription dies with it.

## Configuration (`.env.local`)

| Variable | Default | Meaning |
|---|---|---|
| `MQTT_URL` | `mqtt://broker.emqx.io:1883` | Broker the device publishes to |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | empty | Not needed on the public broker |
| `MQTT_TOPIC` | `emspl/a7f3c2/+/data` | `+` matches one level |
| `MQTT_CLIENT_ID` | random | Keep unique on a public broker |
| `ALLOWED_DEVICES` | empty (accept all) | Comma-separated `device_id`s. **Set this** — anyone can publish to a public topic |
| `HISTORY_SIZE` | 720 | Readings kept per pack for the trend charts |
| `STALE_AFTER_S` | 60 | No message for this long = offline |

Restart `npm run dev` after editing `.env.local`.

## API

| Route | Returns |
|---|---|
| `GET /api/status` | Broker connection, message counters, rejection reasons, last error |
| `GET /api/packs` | Every pack seen since start, with summary figures |
| `GET /api/packs/:id` | Latest full reading for one pack |
| `GET /api/packs/:id/recent?limit=360` | Recent readings for charts |

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
- Times shown are **arrival time** at the server. The device clock is only
  displayed, with a warning if it is off by more than 5 minutes.

## No data showing?

The dashboard's empty state names the cause. The usual ones:

| Symptom | Cause |
|---|---|
| "Not connected to the MQTT broker", error `ENOTFOUND` | DNS. The mobile carrier's DNS blocks `broker.emqx.io`. Set DNS to `1.1.1.1` for that network, then restart. Test with `nslookup broker.emqx.io` |
| "Messages are arriving but all were rejected" | The `device_id` is not in `ALLOWED_DEVICES` |
| Connected, nothing arriving | Device off, or publishing to a different topic. Check in MQTTX |
| Data vanished | The server restarted — memory only for now (see TODO.md) |

`curl -s localhost:3100/api/status` shows the raw counters.

## Layout

```
instrumentation.ts        starts the MQTT subscription at server boot
lib/config.ts             environment variables
lib/store.ts              MQTT client (one per server) + in-memory data
lib/telemetry.ts          payload -> Reading, derived checks
app/api/...               route handlers
components/Dashboard.tsx  the page
components/CellBars.tsx   per-cell voltage bars
components/Sparkline.tsx  trend charts (plain SVG)
```

What comes next is in [TODO.md](TODO.md).
