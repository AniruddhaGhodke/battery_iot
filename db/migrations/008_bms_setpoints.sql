-- What the BMS says its own limits are.
--
-- Raw 16-bit counts from sending groups 1, 2, 5 and 6, stored as the pack
-- last reported them. Not history: the question these answer is "what is the
-- pack running right now", and they change only when someone changes them.
-- See lib/bms-setpoints.ts for why they are not converted to engineering
-- units here.

alter table packs add column bms_setpoints jsonb;
alter table packs add column bms_setpoints_at timestamptz;
