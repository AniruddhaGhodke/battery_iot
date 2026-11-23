-- Control actions (opening and closing the channel) share the request table
-- with configuration, but are a different kind of thing: different topic,
-- different ACL entry, an expiry and an interlock. See lib/pack-control.ts.

alter table config_requests add column kind text not null default 'config'
  check (kind in ('config', 'control'));

-- When the command stops being valid. The firmware must ignore one that
-- arrives past this, which is what stops a queued message switching a
-- contactor hours after it was sent.
alter table config_requests add column expires_at timestamptz;
