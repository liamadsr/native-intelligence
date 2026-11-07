-- ============================================================
-- Migration 013: Auth, Organizations & Invites
-- Foundation layer: workspace, member, invite tables
-- ============================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLES
-- ============================================================

-- workspace: top-level organizational unit
CREATE TABLE public.workspace (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  settings JSONB NOT NULL DEFAULT '{}',
  logo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workspace_slug_idx ON public.workspace (slug);

-- member: workspace-scoped profile (one auth.users row → many member rows)
CREATE TABLE public.member (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'guest')),
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (user_id, workspace_id)
);

CREATE INDEX member_workspace_idx ON public.member (workspace_id);
CREATE INDEX member_user_idx ON public.member (user_id);

-- invite: pending invitations to join a workspace
CREATE TABLE public.invite (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID NOT NULL REFERENCES public.workspace (id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
  invited_by UUID NOT NULL REFERENCES public.member (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE DEFAULT encode(gen_random_bytes(32), 'hex'),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX invite_token_idx ON public.invite (token);
CREATE INDEX invite_workspace_email_idx ON public.invite (workspace_id, email);

-- ============================================================
-- HELPER FUNCTIONS (used by RLS across the entire system)
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_workspace_member(ws_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.member
    WHERE workspace_id = ws_id
      AND user_id = auth.uid()
  );
$$ LANGUAGE sql SECURITY DEFINER STABLE;

CREATE OR REPLACE FUNCTION public.get_member_role(ws_id UUID)
RETURNS TEXT AS $$
  SELECT role FROM public.member
  WHERE workspace_id = ws_id
    AND user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- ============================================================
-- RLS POLICIES
-- ============================================================

ALTER TABLE public.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invite ENABLE ROW LEVEL SECURITY;

-- workspace
CREATE POLICY "Members can view their workspaces"
  ON public.workspace FOR SELECT
  USING (public.is_workspace_member(id));

CREATE POLICY "Owners can update workspace"
  ON public.workspace FOR UPDATE
  USING (public.get_member_role(id) = 'owner');

CREATE POLICY "Authenticated users can create workspaces"
  ON public.workspace FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- member
CREATE POLICY "Members can view workspace members"
  ON public.member FOR SELECT
  USING (public.is_workspace_member(workspace_id));

CREATE POLICY "Users can update own member profile"
  ON public.member FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Authenticated users can insert members"
  ON public.member FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- invite
CREATE POLICY "Admins can manage invites"
  ON public.invite FOR ALL
  USING (public.get_member_role(workspace_id) IN ('owner', 'admin'));

-- ============================================================
-- TRIGGERS
-- ============================================================

-- updated_at auto-touch
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workspace_updated_at
  BEFORE UPDATE ON public.workspace
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

CREATE TRIGGER member_updated_at
  BEFORE UPDATE ON public.member
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- Auto-create workspace + member on sign-up
-- (replaces the old early_access linking trigger with a combined one)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
  new_workspace_id UUID;
  user_name TEXT;
BEGIN
  -- derive display name from email or metadata
  user_name := coalesce(
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.raw_user_meta_data ->> 'name',
    split_part(NEW.email, '@', 1)
  );

  -- create default workspace
  INSERT INTO public.workspace (name, slug)
  VALUES (
    user_name || '''s Workspace',
    lower(replace(user_name, ' ', '-')) || '-' || substr(NEW.id::text, 1, 8)
  )
  RETURNING id INTO new_workspace_id;

  -- create owner member record
  INSERT INTO public.member (user_id, workspace_id, role, display_name)
  VALUES (NEW.id, new_workspace_id, 'owner', user_name);

  -- preserve early_access conversion tracking
  UPDATE early_access
  SET
    user_id = NEW.id,
    converted_at = now(),
    status = 'signed_up'
  WHERE email = lower(trim(NEW.email))
    AND user_id IS NULL;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Drop old trigger and create new combined one
DROP TRIGGER IF EXISTS trg_link_early_access ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- ============================================================
-- BACKFILL: Create workspaces + members for existing users
-- ============================================================

DO $$
DECLARE
  r RECORD;
  new_ws_id UUID;
  uname TEXT;
BEGIN
  FOR r IN SELECT id, email, raw_user_meta_data FROM auth.users LOOP
    -- skip if user already has a member record
    IF EXISTS (SELECT 1 FROM public.member WHERE user_id = r.id) THEN
      CONTINUE;
    END IF;

    uname := coalesce(
      r.raw_user_meta_data ->> 'full_name',
      r.raw_user_meta_data ->> 'name',
      split_part(r.email, '@', 1)
    );

    INSERT INTO public.workspace (name, slug)
    VALUES (
      uname || '''s Workspace',
      lower(replace(uname, ' ', '-')) || '-' || substr(r.id::text, 1, 8)
    )
    RETURNING id INTO new_ws_id;

    INSERT INTO public.member (user_id, workspace_id, role, display_name)
    VALUES (r.id, new_ws_id, 'owner', uname);
  END LOOP;
END;
$$;
