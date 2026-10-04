-- Packs, raw readings, latest reading per pack, and hourly/daily roll-ups.
-- Applied by ingest at startup (db/migrate.ts). Never edit an applied file;
-- add a new numbered one instead.

create extension if not exists timescaledb;

-- One row per battery pack (= one ESP32, one device_id). Replaces the
-- ALLOWED_DEVICES list: only enabled packs are stored.
create table packs (
  id             serial primary key,
  device_id      text not null unique,
  label          text,
  site           text,
  -- series count per module, e.g. {12,12,12,12,9} for a 57S pack
  layout         smallint[],
  nominal_series smallint,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Every accepted reading. Compact on purpose: at 100 packs every 5 s this is
-- 1.7 M rows a day.
create table readings (
  -- Ordering time: device clock when it is NTP-synced, otherwise arrival
  -- time. Both are kept below.
  ts           timestamptz not null,
  pack_id      int not null references packs (id),
  received_at  timestamptz not null,
  device_at    timestamptz,
  seq          int,
  status       text,
  voltage      real,
  current      real,
  power        real,
  soc          real,
  remaining_ah real,
  host_temp    real,
  -- Cells in millivolts. The device sends volts to 3 dp, so this is lossless.
  -- Trailing padding is already cut off; a 0 inside the string is a silent cell.
  cells_mv     smallint[] not null,
  cell_min_mv  smallint,
  cell_max_mv  smallint,
  spread_mv    smallint,
  -- Module temperatures in 0.1 degC, by channel; null = not fitted.
  temps_dc     smallint[],
  temp_max_dc  smallint,
  -- Bit i set = alarm i active, in the order of ALARM_KEYS in lib/telemetry.ts.
  alarms       smallint not null default 0
);

select create_hypertable('readings', by_range('ts', interval '1 day'));

-- Also the dedup key: QoS 1 may deliver a message twice, and inserts use
-- "on conflict do nothing".
create unique index readings_pack_ts on readings (pack_id, ts desc);

alter table readings set (
  timescaledb.enable_columnstore,
  timescaledb.segmentby = 'pack_id',
  timescaledb.orderby = 'ts desc'
);
call add_columnstore_policy('readings', after => interval '2 days');
select add_retention_policy('readings', drop_after => interval '90 days');

-- Latest full reading per pack, as the API returns it. Read by the dashboard
-- on every poll, written by ingest once per second.
create table pack_latest (
  pack_id     int primary key references packs (id),
  -- ts of the reading below; a replayed older reading does not replace it
  ts          timestamptz not null,
  -- last time anything arrived from this pack (online/offline)
  received_at timestamptz not null,
  first_seen  timestamptz not null,
  messages    bigint not null default 0,
  reading     jsonb not null
) with (fillfactor = 50);

-- Hourly roll-up, kept forever. Charts over long ranges read this instead of
-- raw rows. Weighted by n so the daily roll-up can average it correctly.
create materialized view readings_1h
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket(interval '1 hour', ts) as bucket,
  pack_id,
  count(*)          as n,
  avg(voltage)      as voltage_avg,
  min(voltage)      as voltage_min,
  max(voltage)      as voltage_max,
  avg(current)      as current_avg,
  min(current)      as current_min,
  max(current)      as current_max,
  avg(power)        as power_avg,
  avg(soc)          as soc_avg,
  min(soc)          as soc_min,
  max(soc)          as soc_max,
  avg(spread_mv)    as spread_avg,
  max(spread_mv)    as spread_max,
  min(cell_min_mv)  as cell_min_mv,
  max(cell_max_mv)  as cell_max_mv,
  avg(temp_max_dc)  as temp_max_avg_dc,
  max(temp_max_dc)  as temp_max_dc,
  bit_or(alarms)    as alarms
from readings
group by bucket, pack_id
with no data;

-- Starts 3 days back: older raw chunks are compressed and do not change.
select add_continuous_aggregate_policy('readings_1h',
  start_offset => interval '3 days',
  end_offset => interval '1 hour',
  schedule_interval => interval '30 minutes');

-- Daily roll-up on top of the hourly one, kept forever.
create materialized view readings_1d
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket(interval '1 day', bucket) as bucket,
  pack_id,
  sum(n)                                   as n,
  sum(voltage_avg * n) / sum(n)            as voltage_avg,
  min(voltage_min)                         as voltage_min,
  max(voltage_max)                         as voltage_max,
  sum(current_avg * n) / sum(n)            as current_avg,
  min(current_min)                         as current_min,
  max(current_max)                         as current_max,
  sum(power_avg * n) / sum(n)              as power_avg,
  sum(soc_avg * n) / sum(n)                as soc_avg,
  min(soc_min)                             as soc_min,
  max(soc_max)                             as soc_max,
  sum(spread_avg * n) / sum(n)             as spread_avg,
  max(spread_max)                          as spread_max,
  min(cell_min_mv)                         as cell_min_mv,
  max(cell_max_mv)                         as cell_max_mv,
  sum(temp_max_avg_dc * n) / nullif(sum(n) filter (where temp_max_avg_dc is not null), 0) as temp_max_avg_dc,
  max(temp_max_dc)                         as temp_max_dc,
  bit_or(alarms)                           as alarms
from readings_1h
group by 1, pack_id
with no data;

select add_continuous_aggregate_policy('readings_1d',
  start_offset => interval '4 days',
  end_offset => interval '1 day',
  schedule_interval => interval '2 hours');
