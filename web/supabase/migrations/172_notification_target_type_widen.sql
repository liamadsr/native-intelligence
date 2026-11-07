-- Migration 172: widen notification.target_type CHECK for loop-engine deep links
-- (Phase 3, WS-3b).
--
-- WS-3b makes loop notifications link somewhere: a verdict-run notification
-- targets its flow_run (the Loop Activity/ledger surface, run-skill.ts), and a
-- failed-run notification targets its flow (flow-functions.ts). Both target_type
-- values ('flow_run', 'flow') were rejected by the original CHECK (migration
-- 031), and createNotification swallows the insert error — so those rows were
-- silently dropped and the notifications were inert (prod row 6d491207 had
-- target_type null). This widens the CHECK to permit them.
--
-- Also adds 'contact', which the CreateNotificationParams TS union has long
-- carried but the CHECK never permitted (a latent silent-drop for any
-- contact-targeted notification). The widened set now matches the TS union
-- exactly.
--
-- SAFETY: widening a CHECK only permits MORE values; it can never reject an
-- existing row, so this applies cleanly with data present. The inline CHECK from
-- migration 031 is named notification_target_type_check (Postgres's
-- {table}_{column}_check default; cf. migration 136 altering the sibling
-- notification_type_check on the same table).

alter table public.notification
  drop constraint if exists notification_target_type_check;

alter table public.notification
  add constraint notification_target_type_check
  check (target_type in (
    'action', 'capture', 'document', 'project', 'contact',
    'cycle', 'comment', 'decision', 'share', 'flow_run', 'flow'
  ));
