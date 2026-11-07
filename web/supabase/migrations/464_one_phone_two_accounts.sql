-- ============================================================
-- 464: one phone, two separate accounts
-- ============================================================
-- One person's phone can be verified on two separate Dial8 accounts: their
-- own, reached on the Dial8 number, and a business's own account (its own
-- workspace, which the first account is not a member of), reached on that
-- business's own number (roadmap B2, 458 business_phone_number). Each agent
-- texts them from its own number, and a reply reaches whichever agent they
-- texted (src/lib/sms/inbound.ts, src/lib/sms/workspace-line.ts).
--
--   1. user_phone.line: 'dial8' (reached on the Dial8 number, as every row
--      was) or 'business' (reached only on the business numbers of the
--      workspaces its person belongs to). Existing rows are 'dial8'.
--   2. One Dial8-line holder per phone, any number of business lines: 411's
--      user_phone_verified_phone_key is replaced by the same partial unique
--      index limited to line = 'dial8'. user_phone_user_key stays: one phone
--      per person. A plain index on the phone serves the business-number
--      lookups (src/lib/sms/store.ts findBusinessPerson).
--   3. release_signup_number (457): a text sign-up runs only for a number
--      with no Dial8-line holder, and its release removes every other row
--      for the number (the code proved who holds it now). So only a
--      Dial8-line row keeps an older account's auth phone: a business-line
--      holder's text to the Dial8 number never reached that account, and
--      keeping its auth phone would make the sign-up fail on phone_exists.
--
-- Deploy notes:
--   - Applied by hand, from this file: to DEV, then to PROD only on the
--     owner's word. 464 must be on PROD BEFORE the code that reads it
--     deploys: that code selects and filters user_phone.line, and every
--     text in or out fails without the column.
--   - Applying 464 first is safe for main's code as it is: while every row
--     is 'dial8' (nothing writes 'business' before the new code), the new
--     key holds exactly what 411's did and main never reads the column.
--   - To roll the code back to main's after any business-line row exists,
--     FIRST run:  delete from public.user_phone where line = 'business';
--     main's findLinkedPhone reads a phone's verified row with maybeSingle
--     and no line filter, so a second verified row for a phone would make
--     every text from it fail.
--
-- Idempotent (IF NOT EXISTS, the constraint dropped and re-added, the
-- function replaced). This file holds no backslash anywhere: one MCP
-- transport decodes escapes, so the applied SQL would differ from the file.
-- ============================================================

SET LOCAL lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. user_phone.line
-- ------------------------------------------------------------

alter table public.user_phone add column if not exists line text not null default 'dial8';

alter table public.user_phone drop constraint if exists user_phone_line_check;
alter table public.user_phone
  add constraint user_phone_line_check check (line in ('dial8', 'business'));

comment on column public.user_phone.line is
  'Which number reaches this person (464): dial8 = the Dial8 number (one holder per phone), business = only the business numbers of the workspaces they belong to (any number of accounts per phone).';

-- ------------------------------------------------------------
-- 2. One Dial8-line holder per phone (the new key first, then the old one goes)
-- ------------------------------------------------------------

create unique index if not exists user_phone_dial8_phone_key
  on public.user_phone (phone_e164) where verified_at is not null and line = 'dial8';
drop index if exists public.user_phone_verified_phone_key;
create index if not exists user_phone_phone_idx on public.user_phone (phone_e164);

comment on table public.user_phone is
  'A person''s linked phone for texting the agent (411). One per person. A verified number has one Dial8-line holder and any number of business lines (464). The person reads and deletes their own row; only the service role writes.';

-- ------------------------------------------------------------
-- 3. release_signup_number: only a Dial8-line row keeps the number
-- ------------------------------------------------------------

create or replace function public.release_signup_number(p_phone text)
returns uuid[]
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_bare text := ltrim(coalesce(p_phone, ''), '+');
  v_released uuid[];
begin
  if v_bare !~ '^[1-9][0-9]{6,14}$' then
    return '{}'::uuid[];
  end if;

  with holders as (
    select u.id
    from auth.users u
    where u.phone in (v_bare, '+' || v_bare)
      and not exists (
        select 1 from public.user_phone p
        where p.user_id = u.id
          and p.phone_e164 = '+' || v_bare
          and p.verified_at is not null
          and p.line = 'dial8'
      )
  ),
  freed_identities as (
    delete from auth.identities i
    using holders h
    where i.user_id = h.id
      and i.provider = 'phone'
    returning i.user_id
  ),
  freed as (
    update auth.users u
    set phone = null, phone_confirmed_at = null, updated_at = now()
    from holders h
    where u.id = h.id
    returning u.id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_released from freed;

  return v_released;
end;
$$;

comment on function public.release_signup_number(text) is
  'Frees a phone number from older auth accounts that no longer hold it on the Dial8 line in user_phone (457, 464), so a text sign-up that proved the number with a code can create a fresh account. Returns their ids. Service role only.';

revoke execute on function public.release_signup_number(text) from public, anon, authenticated;
grant execute on function public.release_signup_number(text) to service_role;
