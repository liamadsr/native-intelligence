-- Migration 162: allow the 'calendar_event' flow trigger type (GEN-136).
--
-- flow.trigger_type is text with an ENUM-LIST CHECK constraint (migration 135
-- converted the pg enum to text + CHECK). The list did NOT include
-- 'calendar_event', so inserting a calendar-anchored flow would violate
-- flow_trigger_type_check. Widen the CHECK to admit it.
--
-- (The GEN-136 design doc mistakenly assumed the CHECK allowed arbitrary text;
-- it is an explicit allow-list. This migration is the required fix.)
--
-- Idempotent: DROP … IF EXISTS then re-ADD the full list.

ALTER TABLE public.flow DROP CONSTRAINT IF EXISTS flow_trigger_type_check;

ALTER TABLE public.flow
  ADD CONSTRAINT flow_trigger_type_check
  CHECK (trigger_type IN (
    'entity_status_change',
    'capture_processed',
    'pr_status_changed',
    'schedule',
    'calendar_event'
  ));
