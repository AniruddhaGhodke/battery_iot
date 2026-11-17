-- WhatsApp alerts (ingest/alerts.ts, ingest/notifier.ts).
-- Applied by ingest at startup. Never edit an applied file; add a new one.

-- Alerts that are raised right now. Kept so a restart or deploy neither
-- repeats an alert nor forgets to send its "cleared" message.
create table alert_active (
  -- "<device_id>|<condition>", or "system|<condition>"
  key       text primary key,
  since     timestamptz not null,
  -- false when the raise was not sent (cooldown, hourly cap, sending off)
  notified  boolean not null
);

-- Every alert event, sent or not. Small: one row per raise or clear.
create table alert_log (
  id         bigserial primary key,
  ts         timestamptz not null default now(),
  -- device_id, or null for system alerts
  pack       text,
  condition  text not null,
  kind       text not null check (kind in ('raised', 'cleared')),
  headline   text not null,
  detail     text not null,
  sent       boolean not null,
  -- why it was not sent, or the provider's error
  error      text
);

create index alert_log_ts on alert_log (ts desc);
