-- Remote configuration: addressing a device, and the history of what was sent.
-- Applied by ingest at startup. Never edit an applied file; add a new one.

-- The topic segment this pack publishes under, i.e. "pack1" in
-- emspl/a7f3c2/pack1/data. Nothing recorded this before: the device_id came
-- from the payload and the topic was never stored, so there was no way to
-- address a pack. Null until it is known; ingest fills it in from the
-- telemetry topic as readings arrive.
alter table packs add column topic_slug text;
create unique index packs_topic_slug on packs (topic_slug) where topic_slug is not null;

-- The interval the pack is configured to publish at, once we have set it.
-- Staleness and the offline alert derive from this, so a long interval does
-- not read as a dead pack (lib/pack-config.ts).
alter table packs add column telemetry_interval_ms integer;

-- One row per configuration request, from submission to final outcome.
create table config_requests (
  id            bigserial primary key,
  pack_id       int not null references packs (id) on delete cascade,
  -- Denormalised so history survives a pack being removed from the table.
  device_id     text not null,
  -- The settings asked for, e.g. {"telemetry_interval_ms": 10000}
  requested     jsonb not null,
  status        text not null
                check (status in ('pending','sent','restarting','applied','rejected','timeout','failed')),
  -- Who asked. 'admin' until the app has logins of its own.
  requested_by  text not null,
  requested_at  timestamptz not null default now(),
  -- When the broker accepted the publish, and when the device answered.
  sent_at       timestamptz,
  acked_at      timestamptz,
  -- The device's acknowledgement, as received.
  ack           jsonb,
  error         text
);

create index config_requests_pack on config_requests (pack_id, requested_at desc);
create index config_requests_open on config_requests (status) where status in ('pending','sent','restarting');
