-- Several packs publish on one topic.
--
-- 004 made topic_slug unique, on the assumption that a pack had a topic of its
-- own. The firmware does not work that way: every board hardcodes
-- emspl/a7f3c2/pack1/..., and what separates them is target_uid in the command
-- (006). So the second board onto a site could never record its topic — the
-- write failed on the unique index for every reading it sent, and the pack sat
-- there with "topic not known yet", unable to be configured.
--
-- The slug is now what it always really was: where to publish, not who to.
-- packs.device_uid is the identity and stays unique.

drop index packs_topic_slug;
create index packs_topic_slug on packs (topic_slug) where topic_slug is not null;
