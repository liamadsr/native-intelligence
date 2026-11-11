-- ============================================================
-- 570: Push (the iOS app), part two: an install's VoIP token beside its
-- alert token, so a team call's ring reaches the phone as a call (calls
-- plan, phase 8). 571 is the rings' push bookkeeping.
-- ============================================================
--   push_token.kind   'alert' (562's: the APNs token for notifications) or
--                     'voip' (the PushKit token: Apple delivers its pushes
--                     only as incoming calls, to the topic <bundle id>.voip).
--                     One install has one of each, as two rows: a VoIP
--                     token is a different value from the alert token, and
--                     it lives and dies by the same rules (registered on
--                     every signed-in launch, taken off when notifications
--                     are turned off or the session ends, pushed to only
--                     when seen within 30 days, at most 10 live a person).
--                     The sender reads one kind at a time
--                     (src/lib/push/send.ts): an alert never goes to a VoIP
--                     token, a ring never to an alert token.
--   push_token_register(token, environment, bundle_id, device_name, kind)
--                     562's, plus the kind ('alert' when left out, as the
--                     app before this sent it). The cap of 10 live installs
--                     counts each kind on its own. The four-argument
--                     function is replaced by this one (a call naming the
--                     four arguments reaches it unchanged).
--   push_token_remove(token), push_token_forget(token)  unchanged: a token
--                     is unique whatever its kind, so the token alone names
--                     the row. push_token_forget stays the one function
--                     granted to anon (562's header says why); nothing new
--                     is granted to anon here.
--
-- Additive. Idempotent. Safe on a live database: push_token gains a column
-- with a constant default (no rewrite) and its check is validated in the
-- same transaction (a few rows); one partial index is replaced by one that
-- leads with the same column. No backslashes anywhere in this file (one
-- MCP transport decodes escapes).
-- ------------------------------------------------------------

-- One transaction, whatever applies it: the file opens with begin and ends
-- with commit, so plain `psql -v ON_ERROR_STOP=1 < file` (no
-- --single-transaction) is atomic too. A failure rolls the whole file back,
-- and SET LOCAL's lock_timeout holds for every statement in it. Nothing in it
-- is refused inside a transaction (no CONCURRENTLY, no VACUUM).

begin;

SET LOCAL lock_timeout = '5s';

alter table public.push_token
  add column if not exists kind text not null default 'alert';

alter table public.push_token drop constraint if exists push_token_kind;
alter table public.push_token
  add constraint push_token_kind check (kind in ('alert', 'voip')) not valid;
alter table public.push_token validate constraint push_token_kind;

-- The sender's read: a person's live installs of one kind.
create index if not exists push_token_user_kind_live_idx on public.push_token (user_id, kind) where disabled_at is null;
drop index if exists public.push_token_user_live_idx;

comment on column public.push_token.kind is
  'Which token of the install this is (570): alert (notifications) or voip (PushKit: a team call''s ring, delivered as an incoming call).';

drop function if exists public.push_token_register(text, text, text, text);

-- The caller's install, registered or seen again: one of its two tokens.
create or replace function public.push_token_register(device_token text, token_environment text, app_bundle_id text, name_of_device text, token_kind text default 'alert')
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := auth.uid();
  tok text := lower(btrim(coalesce(device_token, '')));
  k text := coalesce(token_kind, 'alert');
  id_out uuid;
begin
  if me is null then
    raise exception 'push: sign in first' using errcode = '42501';
  end if;
  if tok !~ '^[0-9a-f]{64,200}$' then
    raise exception 'push: that is not a device token' using errcode = '22023';
  end if;
  if token_environment is null or token_environment not in ('sandbox', 'production') then
    raise exception 'push: the environment is sandbox or production' using errcode = '22023';
  end if;
  if k not in ('alert', 'voip') then
    raise exception 'push: the kind is alert or voip' using errcode = '22023';
  end if;
  insert into public.push_token (user_id, token, platform, environment, bundle_id, device_name, kind)
  values (me, tok, 'ios', token_environment, btrim(coalesce(app_bundle_id, '')), nullif(left(btrim(coalesce(name_of_device, '')), 100), ''), k)
  on conflict (token) do update
     set user_id = excluded.user_id,
         environment = excluded.environment,
         bundle_id = excluded.bundle_id,
         device_name = excluded.device_name,
         kind = excluded.kind,
         last_seen_at = now(),
         disabled_at = null,
         disabled_reason = null
  returning id into id_out;
  -- At most 10 live installs a person, of each kind: the ones seen longest ago stop.
  update public.push_token
     set disabled_at = now(), disabled_reason = 'Superseded'
   where user_id = me
     and kind = k
     and disabled_at is null
     and id not in (
       select t.id from public.push_token t
        where t.user_id = me and t.kind = k and t.disabled_at is null
        order by t.last_seen_at desc, t.created_at desc
        limit 10
     );
  return id_out;
end;
$$;

revoke all on function public.push_token_register(text, text, text, text, text) from public, anon;
grant execute on function public.push_token_register(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

commit;
