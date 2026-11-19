-- Cause analysis attached to a raised battery alert (lib/diagnose.ts).
-- Null for alerts that are not analysed (offline, system) or where the
-- analysis did not finish in time.

alter table alert_log add column analysis jsonb;
