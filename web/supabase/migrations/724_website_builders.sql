-- ============================================================
-- 724: a business's website on a site builder, not only in a GitHub repo
-- ============================================================
-- NUMBER: 724 was assigned to this branch (723 and 725 are other branches'),
-- 2026-11-27. Re-list main's migrations before merging, and renumber (the
-- file, this line, src/lib/website/__tests__/migration-724.test.ts) if main
-- took it meanwhile.
--
-- HOW TO APPLY: on the server's database, as the row "Apply a database
-- migration" in deploy/README.md says: piped into psql in the database
-- container, `-v ON_ERROR_STOP=1`, WITHOUT --single-transaction (it holds its
-- own begin/commit; with the flag it runs the same, psql only warning that a
-- transaction is already in progress). It ends by telling the data API to
-- reload its schema, so that row's second step is not needed.
--
-- PROD ORDER: either order works. The app reads these columns only when
-- they exist (src/lib/website/store.ts falls back to 463's columns when the
-- database answers that one is missing), and only a builder site writes them,
-- which needs WEBSITE_BUILDERS set (empty: off). Applying it early is
-- harmless: every existing site gets provider 'github', which is what it is.
--
-- Roadmap issue #13 (Liam, 11-27: "let's do it"): quote forms and website
-- changes by text for sites on WordPress, Wix, Webflow, Framer and Shopify,
-- not just ones in a GitHub repo (docs/plans/hosted-site-builders.md). Each
-- change on a builder is still one card the owner says yes to; there is no
-- pull request, so the change row carries what it will write instead:
--
--   website_site.provider               where the site lives: 'github' (463's
--                                       repo), or a builder. Existing rows
--                                       are GitHub's.
--   website_site.provider_site_id       the builder's own name for the site:
--                                       a WordPress site's REST root, later a
--                                       Webflow site id or a Shopify shop.
--   website_site.credentials_encrypted  a builder login that is not an OAuth
--                                       token (a WordPress application
--                                       password): the `v1` AES-256-GCM
--                                       ciphertext of src/lib/crypto/
--                                       credentials.ts, never plaintext. OAuth
--                                       builders keep theirs in
--                                       user_oauth_tokens, as GitHub does.
--   website_change.staged               a builder change's write: which page,
--                                       its text before (the undo) and after,
--                                       and their hashes (the card's version:
--                                       head_sha holds the after's, and the
--                                       yes refuses a page that moved since).
--
-- A GitHub site still needs its repo and branch; a builder site has none.
-- Additive: columns with defaults, two NOT NULLs relaxed into a check that
-- keeps them for GitHub. RLS unchanged (463: members read, the service role
-- writes); credentials_encrypted is never selected by the app's member reads.
-- Re-runnable.

begin;

SET LOCAL lock_timeout = '5s';

alter table public.website_site add column if not exists provider text not null default 'github';
alter table public.website_site add column if not exists provider_site_id text null;
alter table public.website_site add column if not exists credentials_encrypted text null;

alter table public.website_site alter column repo_full_name drop not null;
alter table public.website_site alter column default_branch drop not null;

alter table public.website_site drop constraint if exists website_site_provider_check;
alter table public.website_site
  add constraint website_site_provider_check check (provider in ('github', 'wordpress', 'wpcom', 'webflow', 'wix', 'shopify'));

-- 463's shape checks, now for GitHub's rows only; a builder's row names its site instead.
alter table public.website_site drop constraint if exists website_site_repo_shape;
alter table public.website_site
  add constraint website_site_repo_shape check (
    (provider = 'github' and repo_full_name is not null and repo_full_name ~ '^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$')
    or (provider <> 'github' and repo_full_name is null)
  );
alter table public.website_site drop constraint if exists website_site_branch_length;
alter table public.website_site
  add constraint website_site_branch_length check (
    (provider = 'github' and default_branch is not null and char_length(default_branch) between 1 and 200)
    or (provider <> 'github' and default_branch is null)
  );
alter table public.website_site drop constraint if exists website_site_builder_shape;
alter table public.website_site
  add constraint website_site_builder_shape check (
    provider = 'github'
    or (provider_site_id is not null and char_length(provider_site_id) between 1 and 300)
  );
alter table public.website_site drop constraint if exists website_site_credentials_shape;
alter table public.website_site
  add constraint website_site_credentials_shape check (
    credentials_encrypted is null or (credentials_encrypted ~ '^v1\.' and char_length(credentials_encrypted) <= 4000)
  );

comment on column public.website_site.provider is
  'Where the site lives (724): github (a repo, 463) or a site builder (wordpress, wpcom, webflow, wix, shopify).';
comment on column public.website_site.provider_site_id is
  'A builder site''s own name for itself (724): a WordPress site''s REST root, a Webflow site id, a Shopify shop.';
comment on column public.website_site.credentials_encrypted is
  'A builder login that is not an OAuth token (724: a WordPress application password), as the v1 ciphertext of src/lib/crypto/credentials.ts. Never plaintext.';

alter table public.website_change add column if not exists staged jsonb null;

alter table public.website_change drop constraint if exists website_change_staged_size;
alter table public.website_change
  add constraint website_change_staged_size check (staged is null or pg_column_size(staged) <= 1500000);

comment on column public.website_change.staged is
  'A builder change''s write (724): the page, its text before (the undo) and after, and their hashes. Null for a GitHub change (its pull request is the write).';

commit;

notify pgrst, 'reload schema';
