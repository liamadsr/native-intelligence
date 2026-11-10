-- ============================================================
-- 497: the activity log records a custom field change (the shared entity
-- layer, phase 6).
-- ============================================================
-- A record's History (488, 489) said when it was renamed, moved or
-- assigned, but not when someone set one of its own fields (473, 496). This
-- adds ONE action and ONE trigger function, on every kind that is both
-- logged (`activity`) and takes fields (`customFields`) in the entity
-- registry: document, contact, project, action, initiative, company, deal.
--
--   updated   a record's custom field values changed   {fields: [key, ...]}
--
-- detail holds the changed fields' KEYS only (a slug of the workspace's own
-- field name, never a value, never the record's text), at most 20, sorted.
-- The feed names them through custom_field_definition, read under the
-- viewer's RLS, like every other label.
--
-- The trigger keeps 488's cost rules: a row-level AFTER UPDATE OF
-- custom_fields with a WHEN clause, so an update that leaves the values
-- alone (every autosave, every rename) never calls the function. It keeps
-- 489's: no subtransaction, runs as its owner with a pinned search_path,
-- writes only when entity_activity_writable (not in a merge, the workspace
-- still there), the actor from entity_activity_actor. A record changing
-- workspace logs nothing here (489's own update trigger carries its history
-- across). A suggested task logs nothing until it is confirmed (as 489's
-- task triggers); an evaluation capture is not a kind here.
--
-- After 489 and 496. Idempotent (drop constraint if exists, create or
-- replace, drop trigger if exists). No backslashes anywhere in this file.
-- ------------------------------------------------------------

SET LOCAL lock_timeout = '5s';

-- ── The vocabulary gains 'updated' ──────────────────────────────────────────
alter table public.entity_activity drop constraint if exists entity_activity_action_check;
alter table public.entity_activity
  add constraint entity_activity_action_check check (action in (
    'created', 'renamed', 'status_changed', 'assigned', 'archived', 'restored',
    'mentioned', 'commented', 'linked', 'updated'
  ));

-- ── One function for every kind: its type is the trigger's argument ─────────
create or replace function public.entity_activity_custom_fields_update()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  a record;
  v_type text := tg_argv[0];
  v_fields jsonb;
begin
  if old.workspace_id is distinct from new.workspace_id then
    return null;
  end if;
  if not public.entity_activity_writable(new.workspace_id) then
    return null;
  end if;
  -- A suggested task is not in anyone's lists yet (489's task triggers).
  if v_type = 'action' and (to_jsonb(new) ->> 'confirmation') = 'suggested' then
    return null;
  end if;
  select coalesce(jsonb_agg(k order by k), '[]'::jsonb) into v_fields
    from (
      select k
        from (
          select jsonb_object_keys(coalesce(old.custom_fields, '{}'::jsonb)) as k
          union
          select jsonb_object_keys(coalesce(new.custom_fields, '{}'::jsonb))
        ) u
       where (old.custom_fields -> u.k) is distinct from (new.custom_fields -> u.k)
       order by k
       limit 20
    ) changed;
  if jsonb_array_length(v_fields) = 0 then
    return null;
  end if;
  select * into a from public.entity_activity_actor();
  insert into public.entity_activity (workspace_id, entity_type, entity_id, action, actor_kind, actor_member_id, detail)
  values (new.workspace_id, v_type, new.id, 'updated', a.actor_kind,
          public.entity_activity_member(a.actor_user_id, new.workspace_id),
          jsonb_build_object('fields', v_fields));
  return null;
end;
$$;

revoke all on function public.entity_activity_custom_fields_update() from public, anon, authenticated;

-- ── The triggers ────────────────────────────────────────────────────────────
drop trigger if exists entity_activity_custom_fields on public.document;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.document
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('document');

drop trigger if exists entity_activity_custom_fields on public.contact;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.contact
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('contact');

drop trigger if exists entity_activity_custom_fields on public.projects;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.projects
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('project');

drop trigger if exists entity_activity_custom_fields on public.actions;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.actions
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('action');

drop trigger if exists entity_activity_custom_fields on public.initiative;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.initiative
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('initiative');

drop trigger if exists entity_activity_custom_fields on public.company;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.company
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('company');

drop trigger if exists entity_activity_custom_fields on public.deal;
create trigger entity_activity_custom_fields
  after update of custom_fields on public.deal
  for each row
  when (old.custom_fields is distinct from new.custom_fields)
  execute function public.entity_activity_custom_fields_update('deal');
