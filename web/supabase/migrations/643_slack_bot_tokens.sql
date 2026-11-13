-- ============================================================
-- 643: Slack's bot tokens, held by the app itself.
--
-- The app talks to Slack directly with our own Slack app: Slack's OAuth v2
-- install (src/lib/slack/install.ts, /api/slack/oauth/callback) gives one bot
-- token per Slack team, stored here (src/lib/slack/bot-token.ts). Before this
-- the tokens were held by an outside service; nothing of that is kept. Each
-- Slack workspace's admin adds the app again once, from Settings.
--
--   slack_bot_token   one row per Slack team the app is installed in (bound
--                     to a workspace or not yet: slack_installation says
--                     which). The bot token, and the refresh token when the
--                     Slack app rotates its tokens, ENCRYPTED by the app
--                     (src/lib/crypto/credentials.ts, `v1.` values) with
--                     CREDENTIAL_ENCRYPTION_KEY: the database never sees
--                     them in the clear. `version` moves on with every write,
--                     so a refresh writes only over the row it read (compare
--                     and set). `refresh_claimed_until`: the one container
--                     redeeming the refresh token claims the row first (a
--                     refresh token is spent once). `installed_at`: when the
--                     install (not a refresh) wrote it, so an uninstall event
--                     from before a new install leaves the new one alone.
--                     Deleted when the app is removed from the team, when the
--                     token is dead and can't be renewed, on Disconnect in
--                     Settings, and when a live installation row of the team
--                     is deleted (a workspace deleted: the trigger below).
--
-- Security: row level security on, and NO policy: no client reads or writes
-- a row, whoever they are. Every privilege is revoked from anon and
-- authenticated; only the service role (the server) touches it.
--
-- slack_installation.connect_installation_id (412) stays, always the team
-- id: the app now addresses an installation by slack_team_id and reads it
-- nowhere. It is kept so the code serving until the roll-out keeps working.
--
-- Workspace merge (402): this table has no workspace_id (it is keyed by the
-- Slack team, like slack_event), so the merge never touches it.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- before the code that uses it is rolled out. Re-runnable.
-- Pinned by src/lib/slack/__tests__/migration-643.test.ts.
-- No backslashes anywhere in this file (one MCP transport decodes escapes).
-- ============================================================

SET LOCAL lock_timeout = '5s';

create table if not exists public.slack_bot_token (
  slack_team_id text primary key check (slack_team_id ~ '^T[A-Z0-9]{2,30}$'),
  -- The Slack app the token belongs to (SLACK_APP_ID when it was stored).
  app_id text not null check (app_id ~ '^A[A-Z0-9]{2,30}$'),
  -- The bot token, encrypted by the app (v1.<iv>.<tag>.<ciphertext>).
  bot_token_enc text not null check (bot_token_enc ~ '^v1[.]' and char_length(bot_token_enc) <= 4000),
  -- The refresh token, encrypted the same way; null when the app does not rotate tokens.
  refresh_token_enc text check (refresh_token_enc is null or (refresh_token_enc ~ '^v1[.]' and char_length(refresh_token_enc) <= 4000)),
  -- When the bot token expires; null when it does not.
  expires_at timestamptz,
  -- The bot's own Slack user id.
  bot_user_id text check (bot_user_id is null or bot_user_id ~ '^[UW][A-Z0-9]{2,30}$'),
  -- The scopes Slack granted, comma separated.
  scopes text not null default '' check (char_length(scopes) <= 1000),
  -- Moves on with every write: a refresh writes only over the version it read.
  version bigint not null default 1 check (version >= 1),
  -- Set while one container redeems the refresh token; cleared by its write.
  refresh_claimed_until timestamptz,
  -- When an install wrote the token (a refresh never moves it).
  installed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- A table made by an earlier run of this file gains the later columns.
alter table public.slack_bot_token add column if not exists refresh_claimed_until timestamptz;
alter table public.slack_bot_token add column if not exists installed_at timestamptz not null default now();

comment on table public.slack_bot_token is
  'Slack (643): the bot token (and refresh token) of each Slack team the app is installed in, encrypted by the app. Service role only.';

drop trigger if exists slack_bot_token_updated_at on public.slack_bot_token;
create trigger slack_bot_token_updated_at
  before update on public.slack_bot_token
  for each row execute function public.update_updated_at();

alter table public.slack_bot_token enable row level security;

revoke all on table public.slack_bot_token from public, anon, authenticated;
grant select, insert, update, delete on table public.slack_bot_token to service_role;

-- ── A live installation deleted: its team's token goes with it ─────────────
-- A workspace deleted cascades to its slack_installation rows; the team's bot
-- token must not outlive them. Only a LIVE row takes the token: a revoked row
-- had its token deleted when it was revoked, and a revoked row deleted while
-- another workspace binds the team (store.ts bindInstallation) must not take
-- the token that install just stored. Security definer because the table is
-- the service role's only and a cascade may run as whoever deleted the
-- workspace; it only ever deletes the one team's row.
create or replace function public.slack_installation_gone_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.status = 'active' then
    delete from public.slack_bot_token where slack_team_id = old.slack_team_id;
  end if;
  return old;
end;
$$;

revoke all on function public.slack_installation_gone_trigger() from public, anon, authenticated;

drop trigger if exists slack_installation_gone on public.slack_installation;
create trigger slack_installation_gone
  after delete on public.slack_installation
  for each row execute function public.slack_installation_gone_trigger();

comment on column public.slack_installation.connect_installation_id is
  'Since 643 always the Slack team id, and read by nothing: an installation is addressed by slack_team_id, its bot token kept in slack_bot_token.';
