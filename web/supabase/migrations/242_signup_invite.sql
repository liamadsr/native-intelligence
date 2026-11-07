-- ============================================================
-- 242: Admin signup invites (bypass the work-email gate by invitation)
-- ============================================================
-- Migration 241 refuses new accounts on free-mail domains unless a pending
-- WORKSPACE invite (public.invite) names the address. That covers teammates
-- joining an existing workspace, but not the case where Dial8 itself wants to
-- let a specific person in — a design partner on gmail.com, a tester, a
-- prospect — to create their OWN account and workspace.
--
-- `signup_invite` is that allow-list, one row per address, written only from
-- the admin console (/admin/invites, service role; RLS on with no policies so
-- the Data API exposes nothing). The before-user-created hook honours an
-- unused, unexpired row exactly like a pending workspace invite. A trigger
-- stamps `used_at` once the account exists so the admin page can show who
-- actually signed up.
--
-- The token is what the invite email links to (/login?invite=<token>); the
-- login page resolves it server-side to prefill the address, so the email
-- itself never travels in a URL.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.signup_invite (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  token       text NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  -- auth.users id of the admin who sent it; kept as a bare uuid (no FK) so an
  -- admin account being deleted does not cascade away the invite history.
  invited_by  uuid,
  note        text,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  used_at     timestamptz,
  used_by     uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT signup_invite_email_check CHECK (email = lower(btrim(email)) AND position('@' in email) > 1)
);

-- One live invite per address; re-inviting refreshes the row (upsert).
CREATE UNIQUE INDEX IF NOT EXISTS signup_invite_email_key ON public.signup_invite (email);

ALTER TABLE public.signup_invite ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.signup_invite FROM anon, authenticated, public;

COMMENT ON TABLE public.signup_invite IS
  'Admin-issued signup allow-list: an unused, unexpired row lets that email create a Dial8 account even on a free-mail domain (see hook_require_work_email). Service-role only.';

-- ------------------------------------------------------------
-- Hook: also honour signup invites (supersedes the 241 body)
-- ------------------------------------------------------------
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

  IF v_email = '' THEN
    RETURN '{}'::jsonb;
  END IF;

  v_domain := split_part(v_email, '@', 2);

  IF NOT public.is_free_email_domain(v_domain) THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Personal domain, but a workspace invited this address: let them in.
  IF EXISTS (
    SELECT 1 FROM public.invite i
    WHERE lower(i.email) = v_email
      AND i.accepted_at IS NULL
      AND i.expires_at > now()
  ) THEN
    RETURN '{}'::jsonb;
  END IF;

  -- ...or Dial8 itself invited them from the admin console.
  IF EXISTS (
    SELECT 1 FROM public.signup_invite s
    WHERE s.email = v_email
      AND s.used_at IS NULL
      AND s.expires_at > now()
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
  'Supabase Auth before-user-created hook: refuses new accounts on free-mail domains unless a pending workspace invite or an admin signup invite names that email. Existing users are untouched (hook only runs on creation).';

GRANT EXECUTE ON FUNCTION public.hook_require_work_email(jsonb) TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.hook_require_work_email(jsonb) FROM authenticated, anon, public;

-- ------------------------------------------------------------
-- Stamp the invite once the account exists
-- ------------------------------------------------------------
-- Separate from handle_new_user on purpose: that trigger builds the
-- workspace and must not inherit new failure modes. This one swallows every
-- error — bookkeeping must never be the reason a signup fails.
CREATE OR REPLACE FUNCTION public.mark_signup_invite_used()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  BEGIN
    UPDATE public.signup_invite
    SET used_at = now(), used_by = NEW.id, updated_at = now()
    WHERE email = lower(trim(coalesce(NEW.email, '')))
      AND used_at IS NULL;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_mark_signup_invite ON auth.users;
CREATE TRIGGER on_auth_user_created_mark_signup_invite
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.mark_signup_invite_used();
