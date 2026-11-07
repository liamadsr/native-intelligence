-- ============================================================
-- 241: Require a business email to sign up (before-user-created hook)
-- ============================================================
-- Dial8 is a team product for businesses. From now on a NEW account must be
-- created with an email on a company-owned domain; free-mail / personal
-- addresses (Gmail, Yahoo, Outlook.com, iCloud, ...) are refused.
--
-- HOW IT IS ENFORCED. Supabase Auth's `before-user-created` hook runs
-- `public.hook_require_work_email` just before a row is inserted into
-- auth.users. Returning an `error` object aborts the signup and the message
-- is forwarded verbatim to the client. Because it sits in front of the
-- INSERT it covers every signup path at once — password, magic link and
-- Google OAuth — with no per-path code in the app.
--
-- EXISTING USERS KEEP ACCESS. The hook fires only on user CREATION. Accounts
-- that already exist on a personal domain sign in exactly as before; signing
-- in (password, magic link, or Google on an already-linked identity) never
-- inserts into auth.users, so the hook never sees them.
--
-- INVITED PEOPLE ARE LET THROUGH. A business that invites someone to its
-- workspace has vouched for them, so a PENDING invite (not yet accepted, not
-- expired) addressed to the signup email exempts it from the domain rule —
-- a contractor on gmail.com can still join the team that invited them. The
-- invite is matched on email alone, not on the token: the invitee may sign
-- up from the login page directly rather than through the invite link.
--
-- ONE-TIME DASHBOARD STEP (not expressible in SQL): enable the hook under
-- Authentication → Hooks → "Before User Created" → Postgres function →
-- public.hook_require_work_email. Until that is switched on, this migration
-- installs the function but nothing calls it. The Management API equivalent:
--   PATCH /v1/projects/{ref}/config/auth
--   { "hook_before_user_created_enabled": true,
--     "hook_before_user_created_uri":
--       "pg-functions://postgres/public/hook_require_work_email" }
--
-- KEEP IN SYNC with FREE_EMAIL_DOMAINS in src/lib/auth/work-email.ts and the
-- message with WORK_EMAIL_REQUIRED_MESSAGE there. The client pre-checks with
-- that list so the form can refuse inline; THIS list is the one that decides.
--
-- This is deliberately separate from public.is_personal_email_domain
-- (migration 232). That function feeds CRM company auto-linking and must stay
-- conservative so it never invents phantom companies; a signup gate wants the
-- opposite bias, so it gets its own, broader list.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_free_email_domain(p_domain text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(coalesce(p_domain, '')) = ANY (ARRAY[
    -- Google
    'gmail.com','googlemail.com',
    -- Microsoft
    'outlook.com','outlook.co.uk','hotmail.com','hotmail.co.uk','hotmail.fr',
    'live.com','live.co.uk','msn.com',
    -- Yahoo
    'yahoo.com','yahoo.co.uk','yahoo.fr','yahoo.de','yahoo.ca','yahoo.com.au',
    'ymail.com','rocketmail.com',
    -- Apple
    'icloud.com','me.com','mac.com',
    -- Privacy-first / other consumer providers
    'proton.me','protonmail.com','protonmail.ch','pm.me',
    'tutanota.com','tuta.io','tuta.com',
    'hey.com','fastmail.com','fastmail.fm','duck.com',
    'aol.com','mail.com','email.com','zoho.com','zohomail.com',
    'gmx.com','gmx.de','gmx.net','web.de','t-online.de',
    'yandex.com','yandex.ru','mail.ru','bk.ru','inbox.ru','list.ru',
    'qq.com','163.com','126.com','sina.com','foxmail.com',
    'naver.com','daum.net','hanmail.net',
    'rediffmail.com','laposte.net','orange.fr','wanadoo.fr','free.fr','sfr.fr',
    'libero.it','virgilio.it','seznam.cz','op.pl','wp.pl','interia.pl',
    -- US ISP mailboxes
    'comcast.net','att.net','sbcglobal.net','verizon.net','bellsouth.net',
    'cox.net','charter.net','earthlink.net','optonline.net',
    -- Disposable / throwaway
    'mailinator.com','guerrillamail.com','10minutemail.com','temp-mail.org',
    'yopmail.com','sharklasers.com','trashmail.com','getnada.com'
  ])
$$;

COMMENT ON FUNCTION public.is_free_email_domain(text) IS
  'Signup gate: true for free-mail / personal / disposable domains that may not create a Dial8 account. Mirror of FREE_EMAIL_DOMAINS in src/lib/auth/work-email.ts.';

-- Pending-invite lookup by address. `invite` is only indexed by
-- (workspace_id, email); the hook searches across workspaces.
CREATE INDEX IF NOT EXISTS invite_pending_email_lower_idx
  ON public.invite (lower(email))
  WHERE accepted_at IS NULL;

-- The hook. Takes the before-user-created event, returns `{}` to allow or
-- `{"error": {...}}` to refuse. SECURITY DEFINER because it runs as
-- supabase_auth_admin, which has no RLS policy on `invite` — the function
-- reads exactly one predicate off that table and nothing else.
CREATE OR REPLACE FUNCTION public.hook_require_work_email(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_email  text;
  v_domain text;
BEGIN
  v_email := lower(trim(coalesce(event -> 'user' ->> 'email', '')));

  -- No email on the record (phone / anonymous flows Dial8 does not use, but
  -- the hook must never be the thing that breaks them): nothing to judge.
  IF v_email = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  v_domain := split_part(v_email, '@', 2);

  IF NOT public.is_free_email_domain(v_domain) THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Personal domain, but someone invited this exact address: let them in.
  IF EXISTS (
    SELECT 1 FROM public.invite i
    WHERE lower(i.email) = v_email
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RETURN '{}'::jsonb;
  END IF;

  RETURN jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Dial8 requires a business email to sign up. Personal addresses like Gmail or Yahoo aren''t accepted.'
    )
  );
END;
$$;

COMMENT ON FUNCTION public.hook_require_work_email(jsonb) IS
  'Supabase Auth before-user-created hook: refuses new accounts on free-mail domains unless a pending workspace invite is addressed to that email. Existing users are untouched (hook only runs on creation).';

-- Permissions per the Supabase auth-hooks guide: only the auth server may
-- call the hook, and it must not be reachable through the Data API.
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.hook_require_work_email(jsonb) TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.is_free_email_domain(text) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.hook_require_work_email(jsonb) FROM authenticated, anon, public;
