-- ============================================================
-- 527: validate 523's constraints (Tables, phase 2).
-- ============================================================
-- 523 added these NOT VALID, so its ALTERs held the tables' exclusive locks
-- only for a moment. Validating reads every row under a SHARE UPDATE
-- EXCLUSIVE lock, which lets reads and writes go on; in its own migration
-- (its own transaction) no exclusive lock from 523 is held while it reads.
--
-- After 523. Re-runnable (validating a valid constraint does nothing). No
-- backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

alter table public.custom_field_definition validate constraint custom_field_definition_config_shape;
alter table public.custom_field_definition validate constraint custom_field_definition_required_when_table;
alter table public.entity_link validate constraint entity_link_relation_check;
