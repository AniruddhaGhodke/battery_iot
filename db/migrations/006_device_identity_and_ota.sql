-- Hardware identity and firmware updates.
--
-- The gateway firmware gives every board an immutable UID from its eFuse MAC
-- and sends it in each payload, while device_id is a label stored in NVS that
-- can be changed remotely. Commands must name the UID (target_uid) or every
-- device ignores them. So the UID, not the label, is the identity we key on.

alter table packs add column device_uid text;
create unique index packs_device_uid on packs (device_uid) where device_uid is not null;

-- Last reported firmware version, used to confirm an update landed.
alter table packs add column firmware_version text;
-- False while the board's clock is not NTP-synced; its timestamps are then junk.
alter table packs add column time_synced boolean;

-- Firmware images the dashboard serves to devices over HTTPS. The file is
-- stored as <sha256>.bin, so the URL is unguessable and the path can sit
-- outside the dashboard's basic auth — the ESP32 cannot send credentials.
create table firmware_images (
  id           bigserial primary key,
  version      text not null,
  sha256       text not null unique check (sha256 ~ '^[0-9a-f]{64}$'),
  bytes        bigint not null,
  original_name text,
  notes        text,
  uploaded_by  text not null,
  uploaded_at  timestamptz not null default now()
);

create index firmware_images_uploaded on firmware_images (uploaded_at desc);

-- OTA rollouts share the request table with configuration and control.
alter table config_requests drop constraint config_requests_kind_check;
alter table config_requests add constraint config_requests_kind_check
  check (kind in ('config', 'control', 'ota'));

-- 'downloading' is an OTA-only step between sent and applied.
alter table config_requests drop constraint config_requests_status_check;
alter table config_requests add constraint config_requests_status_check
  check (status in ('pending','sent','downloading','restarting','applied','rejected','timeout','failed'));

-- Which image a rollout is installing.
alter table config_requests add column firmware_id bigint references firmware_images (id);

-- The open-request index has to know about the new step too, or an OTA mid
-- download would fall out of it.
drop index config_requests_open;
create index config_requests_open on config_requests (status)
  where status in ('pending', 'sent', 'downloading', 'restarting');
