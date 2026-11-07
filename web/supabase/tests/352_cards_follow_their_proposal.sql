-- DB-level test for migration 352 (cards_follow_their_proposal): a For You
-- card settles when its proposal is settled anywhere, comes back when an
-- accept hands its claim back, and expires when its proposal is deleted. The
-- TS test pins the file's text; this runs the SQL.
--
-- Run against a database with the migrations applied (never PROD):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/352_cards_follow_their_proposal.sql
-- Prints "352 cards_follow_their_proposal: all checks passed". Everything runs
-- in one transaction that is rolled back: throwaway proposals (no capture) in
-- an existing member's workspace, and a card for each. A failed check raises
-- and aborts.

begin;

do $probe$
declare
  ws uuid; m uuid;
  p_apply uuid; p_dismiss uuid; p_aged uuid; p_aged30 uuid; p_expire uuid; p_draft uuid; p_delete uuid; p_settled uuid;
  c_apply uuid; c_dismiss uuid; c_aged uuid; c_aged30 uuid; c_expire uuid; c_draft uuid; c_delete uuid; c_settled uuid;
  v_status text; v_marker text; v_resolved timestamptz;
begin
  select workspace_id, id into ws, m from public.member limit 1;
  if ws is null then raise exception 'FAIL: needs a member'; end if;

  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe apply') returning id into p_apply;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe dismiss') returning id into p_dismiss;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe aged') returning id into p_aged;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe aged30') returning id into p_aged30;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe expire') returning id into p_expire;
  insert into public.proposed_change (workspace_id, change_type, entity_type, display_text)
  values (ws, 'send_email', 'action', 'probe draft') returning id into p_draft;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe delete') returning id into p_delete;
  insert into public.proposed_change (workspace_id, change_type, entity_type, entity_id, display_text)
  values (ws, 'update', 'action', gen_random_uuid(), 'probe settled') returning id into p_settled;

  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'apply', p_apply, now() + interval '7 days') returning id into c_apply;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'dismiss', p_dismiss, now() + interval '7 days') returning id into c_dismiss;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'aged', p_aged, now() + interval '7 days') returning id into c_aged;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'aged30', p_aged30, now() + interval '7 days') returning id into c_aged30;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'expire', p_expire, now() + interval '7 days') returning id into c_expire;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'draft_email', 'draft', p_draft, now() + interval '7 days') returning id into c_draft;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at)
  values (ws, m, 'action_card', 'delete', p_delete, now() + interval '7 days') returning id into c_delete;
  insert into public.attention_item (workspace_id, member_id, kind, title, proposal_id, expires_at, status, resolved_at)
  values (ws, m, 'action_card', 'settled', p_settled, now() + interval '7 days', 'dismissed', now() - interval '1 hour')
  returning id into c_settled;

  -- Applied elsewhere: the card is accepted, with the marker.
  update public.proposed_change set status = 'applied', applied_at = now() where id = p_apply;
  select status, payload ->> 'resolved_with_proposal', resolved_at into v_status, v_marker, v_resolved
    from public.attention_item where id = c_apply;
  if v_status <> 'accepted' or v_marker <> 'applied' or v_resolved is null then
    raise exception 'FAIL: an applied proposal accepts its card (got %, %)', v_status, v_marker;
  end if;

  -- The claim handed back (a failed apply): the card is pending again, marker gone.
  update public.proposed_change set status = 'pending', applied_at = null where id = p_apply;
  select status, payload ->> 'resolved_with_proposal', resolved_at into v_status, v_marker, v_resolved
    from public.attention_item where id = c_apply;
  if v_status <> 'pending' or v_marker is not null or v_resolved is not null then
    raise exception 'FAIL: a handed-back claim brings the card back (got %, %)', v_status, v_marker;
  end if;

  -- Dismissed elsewhere: dismissed. Aged out: expired. Expired: expired.
  update public.proposed_change set status = 'dismissed' where id = p_dismiss;
  if (select status from public.attention_item where id = c_dismiss) <> 'dismissed' then
    raise exception 'FAIL: a dismissed proposal dismisses its card';
  end if;
  update public.proposed_change set status = 'dismissed', extra = jsonb_build_object('aged_out', true) where id = p_aged;
  if (select status from public.attention_item where id = c_aged) <> 'expired' then
    raise exception 'FAIL: an aged-out proposal expires its card';
  end if;
  update public.proposed_change set status = 'dismissed', extra = jsonb_build_object('dismiss_reason', 'aged_out_30d') where id = p_aged30;
  if (select status from public.attention_item where id = c_aged30) <> 'expired' then
    raise exception 'FAIL: the 30-day create age-out expires its card';
  end if;
  update public.proposed_change set status = 'expired' where id = p_expire;
  if (select status from public.attention_item where id = c_expire) <> 'expired' then
    raise exception 'FAIL: an expired proposal expires its card';
  end if;

  -- A draft_email card stays pending when its proposal is applied (the body is written after).
  update public.proposed_change set status = 'applied', applied_at = now() where id = p_draft;
  if (select status from public.attention_item where id = c_draft) <> 'pending' then
    raise exception 'FAIL: a draft_email card waits for its body';
  end if;

  -- A card the settle path already resolved is left as it was.
  update public.proposed_change set status = 'applied', applied_at = now() where id = p_settled;
  select status, payload ->> 'resolved_with_proposal' into v_status, v_marker
    from public.attention_item where id = c_settled;
  if v_status <> 'dismissed' or v_marker is not null then
    raise exception 'FAIL: an already-settled card is not settled again (got %, %)', v_status, v_marker;
  end if;
  -- ...and is not brought back when the proposal returns to pending.
  update public.proposed_change set status = 'pending', applied_at = null where id = p_settled;
  if (select status from public.attention_item where id = c_settled) <> 'dismissed' then
    raise exception 'FAIL: only a card the trigger settled comes back';
  end if;

  -- A deleted proposal expires its card (then ON DELETE SET NULL clears the link).
  delete from public.proposed_change where id = p_delete;
  select status, proposal_id::text into v_status, v_marker from public.attention_item where id = c_delete;
  if v_status <> 'expired' or v_marker is not null then
    raise exception 'FAIL: a deleted proposal expires its card (got %, %)', v_status, v_marker;
  end if;

  raise notice '352 cards_follow_their_proposal: all checks passed';
end
$probe$;

rollback;
