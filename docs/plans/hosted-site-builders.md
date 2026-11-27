# Website by text on site builders (roadmap issue #13)

Liam, 11-27, on issue #13: "let's do it": quote forms and website changes by text for
sites on WordPress, Wix, Webflow, Framer and Shopify, not just ones in a GitHub repo.

Today (verified on main at the time of writing) the website flow is GitHub-only:
`web/src/lib/website/*`, the tools in `web/src/lib/ai/tools/website.ts`
(`connect_website`, `wire_website_form`, `change_website`, `undo_website_change`, plus
`list_website_repos`), migration 463. Every change is a pull request made by a coding run,
and goes live only when the owner says yes on one merge card (`merge_website_change`).
The onboarding text (`web/src/lib/onboarding/text-setup.ts`) tells the agent to say a site
on Wix, Squarespace, WordPress or another builder "can be connected later". Webflow and Wix
are offered only as generic MCP connectors (`web/src/lib/mcp-client/suggested.ts`);
Shopify and Framer are not offered at all.

Research was done on 2026-11-27 from each builder's official docs (links below). Points
marked **unverified** must be checked again before we rely on them.

## 1. Per builder

### WordPress, self-hosted

- **(a) Connect.** Application passwords (core since 5.6), sent as HTTP Basic over https.
  No developer app, no review, no marketplace. The site's REST index
  (`/wp-json/`) names its "Authorize Application" page
  (`authentication.application-passwords.endpoints.authorization`). We send the owner to
  `wp-admin/authorize-application.php?app_name=…&app_id=…&success_url=…`; they sign in to
  their own WordPress and click **Approve**; WordPress redirects to our `success_url` with
  `site_url`, `user_login` and `password`. Revocable from their profile page. The index's
  `authentication` key is empty when the site isn't on https or a plugin/host switched the
  feature off. Docs: https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/ ,
  https://make.wordpress.org/core/2020/11/05/application-passwords-integration-guide/ ,
  https://developer.wordpress.org/advanced-administration/security/application-passwords/
- **(b) Form.** No core REST endpoint injects a site-wide script. **On one page:** a Custom
  HTML block (`<!-- wp:html -->`) holding our embed
  (`<div data-ni-form="fk_…"></div><script async src="…/f/embed.js"></script>`), written
  with `POST /wp/v2/pages/{id}`. WordPress keeps a `<script>` only for a login with
  `unfiltered_html` (an Administrator on a single site; not on multisite), which
  `users/me?context=edit` reports. **Site-wide:** needs our own small plugin
  (`wp_enqueue_script`), installed by the owner, or from the wordpress.org directory with
  `POST /wp/v2/plugins` once listed (directory review, no fee). Docs:
  https://developer.wordpress.org/rest-api/reference/pages/ ,
  https://developer.wordpress.org/rest-api/reference/plugins/
- **(c) Changes.** Pages and posts: `GET/POST /wp/v2/pages/{id}` (`context=edit` gives the
  raw block markup and title), `status` publish/draft/pending/private. WordPress keeps a
  **revision** of every update (`/wp/v2/pages/{id}/revisions`, read-only: there is no
  restore mutation, so undo = write the earlier text back, itself a new revision). Preview of
  an unpublished change exists only for a signed-in user (autosaves +
  nonce), so our "preview" is the exact before/after text on the card. Docs:
  https://developer.wordpress.org/rest-api/reference/posts/ ,
  https://developer.wordpress.org/rest-api/reference/post-revisions/
- **(d) Limits.** No platform rate limit (the owner's host decides). Page builders
  (Elementor, Divi) keep their text in post meta, not `content`: the REST content of such a
  page is a shell, so edits there are **not possible** through core REST (we say so and
  point to the builder). Security plugins can block REST or application passwords.

### WordPress.com

- **(a) Connect.** OAuth2: register an app at https://developer.wordpress.com/apps/
  (client id, secret, redirect URI; no review documented). Authorize
  `https://public-api.wordpress.com/oauth2/authorize` (one site by default, `blog=`),
  token `…/oauth2/token`. Scopes: `posts`, `sites`, `media`… The owner signs in to
  WordPress.com and approves. Docs: https://developer.wordpress.com/docs/oauth2/
- **(b) Form.** No embed endpoint. On one page: the same Custom HTML block, but
  WordPress.com strips scripts from content on plans without plugins/custom code. Site-wide
  needs our plugin on a plan that allows plugins (**unverified**: secondary sources say every
  paid plan since April 2026, earlier only Business/Commerce). Business/Commerce ("Atomic")
  sites also expose the self-hosted `wp/v2` API and application passwords, so they connect
  exactly as self-hosted.
- **(c) Changes.** REST v1.1 `POST /rest/v1.1/sites/$site/posts/$id` (pages too),
  draft/publish. Revisions on Atomic sites as core; on simple sites **unverified**.
- **(d) Limits.** Plan gating is the real limit; no published rate limit.

### Wix

- **(a) Connect.** An OAuth app from the Wix Developers dashboard: the owner installs our app
  and grants the permissions it declares. Three distributions: App Market (review),
  **unlisted** (no App Market review; installable by any site owner through a share link),
  private (only sites we own or contribute to). Docs:
  https://dev.wix.com/docs/build-apps/get-started/overview/exposing-apps-publicly-and-privately ,
  https://dev.wix.com/docs/build-apps/launch-your-app/app-distribution/install-your-app/share-an-app-install-link ,
  https://dev.wix.com/docs/rest/api-reference/auth-management/o-auth-apps
- **(b) Form.** Embedded Scripts: an "Embedded Script" extension declared on the app,
  turned on per site with `POST apps/v1/scripts` (permission "Manage Embedded Scripts"),
  head of every page (site-wide; no per-page placement). Docs:
  https://dev.wix.com/docs/rest/app-management/embedded-scripts/introduction . Wix's own
  editor custom code needs Premium + a connected domain; whether an app's embedded script
  does too is **unverified**.
- **(c) Changes.** **No API edits the text of an existing Wix page.** Reachable: Wix Data
  collections (CMS), Blog posts, Stores products. So "change my hours" by text works only
  where the text lives in a collection or a post.
- **(d) Limits.** Per-app permissions; page copy is out of reach (say so plainly).

### Webflow

- **(a) Connect.** OAuth app registered in a Webflow Workspace; scopes `sites:read`,
  `sites:write`, `pages:read`, `pages:write`, `cms:read`, `cms:write`, `custom_code:read`,
  `custom_code:write`. A site API token can't call the custom-code endpoints (401), so it
  must be an app. Before review, only our own Workspace can install; a **private** app gets
  an install URL usable by anyone **after the same Webflow review** as a Marketplace app.
  Docs: https://developers.webflow.com/apps/docs/private-apps ,
  https://developers.webflow.com/data/v2.0.0/docs/working-with-custom-code
- **(b) Form.** Register a hosted script (`POST /v2/sites/{site_id}/registered_scripts/hosted`
  → our `embed.js`), then apply it to the site or one page
  (`PUT /v2/sites/{site_id}/custom_code`, `PUT /v2/pages/{page_id}/custom_code`; send the full
  block list). Scripts are staged until the site is published. Our form needs a
  `<div data-ni-form>` on the page too: embed.js would have to draw it in a named place or
  float it (a small embed.js change, phase 3). Paid site plan for custom code on a custom
  domain: **unverified**.
- **(c) Changes.** CMS items: staged `PATCH /v2/collections/{id}/items/{item}` then
  `POST …/items/publish` (clean draft → publish). Static pages:
  `GET /v2/pages/{id}/dom` reads text nodes, but `POST /v2/pages/{id}/dom` **writes only
  secondary-locale text**: the primary-language copy of a static page can't be changed by
  API. Publish: `POST /v2/sites/{site_id}/publish` publishes everything staged (so we ask
  first). No revision API: undo = write the old value back and publish. Docs:
  https://developers.webflow.com/data/docs/working-with-the-cms ,
  https://developers.webflow.com/data/v2.0.0/reference/pages-and-components/pages/update-static-content
- **(d) Limits.** 60 requests/min (Starter/Basic site plans), 120 (CMS/eCommerce/Business);
  one successful site publish per minute. https://developers.webflow.com/data/reference/rate-limits

### Framer

- **(a) Connect.** No OAuth and no marketplace install. The Server API (open beta since Feb
  2026) uses an API key the owner makes in their project's settings and pastes to us. Docs:
  https://www.framer.com/developers/server-api-introduction ,
  https://www.framer.com/developers/server-api-quick-start
- **(b) Form.** **No documented API puts custom code on a Framer site.** The owner pastes
  our embed in Site Settings › Custom Code themselves (we give them the snippet, as today).
- **(c) Changes.** The Server API shares the Plugin API's abilities (CMS collections, nodes'
  text, publish), but it is a beta: no SLA, unpublished rate limits, pricing unannounced.
- **(d) Verdict.** Not built now. Framer stays "paste this snippet", and is revisited when the
  Server API leaves beta.

### Shopify

- **(a) Connect.** OAuth against the Admin GraphQL API, an app made in the Shopify Dev
  Dashboard. **Custom distribution**: an install link, one store (or one Plus organization),
  **no review**. **Public distribution** (listed or unlisted): any merchant, **App Store
  review**. Admin-made custom apps can't be created any more. Docs:
  https://shopify.dev/docs/apps/launch/distribution/select-distribution-method
- **(b) Form.** ScriptTag is deprecated (no new tags after 2026-10-01, stops running
  2027-03-01). The way is a **theme app extension** with an **app embed block** (site-wide)
  or an app block (on a page, placed by the merchant in the theme editor); the merchant turns
  it on in the theme editor (we deep-link them). Needs our app deployed with the extension,
  so for any merchant but one: App Store review. Docs:
  https://shopify.dev/docs/apps/build/online-store/script-tag-deprecation ,
  https://shopify.dev/docs/apps/build/online-store/theme-app-extensions
- **(c) Changes.** `pageUpdate` (a page's `body` HTML, title, published), `productUpdate`
  (`descriptionHtml`, status DRAFT/ACTIVE), scopes `write_online_store_pages` /
  `write_products`. Theme files (`themeFilesUpsert`) need a Shopify-granted exemption: not
  planned. No revision API: undo = the old value written back. Docs:
  https://shopify.dev/docs/api/admin-graphql/latest/mutations/pageUpdate
- **(d) Limits.** Cost-based GraphQL rate limit (generous). Most service businesses are not
  on Shopify.

## 2. Order

1. **WordPress, self-hosted** (phase 1). The largest share of small-business sites, an open
   API, no developer app, no review, real revisions. Page-level form embed and page/post text
   edits work on day one.
2. **Shopify** (phase 2). Pages and product descriptions by text through a custom-distribution
   app needs no review, but only one store per app, so for real customers it means a public
   (unlisted) app and App Store review; the form needs the theme app extension. Start the
   review early.
3. **Webflow** (phase 3). CMS edits and the form are good; static page copy is out (primary
   locale). Needs the app's Webflow review before anyone outside our Workspace can install.
4. **WordPress.com** (phase 3, with Webflow: it is OAuth plus the same block writes as
   self-hosted; Atomic sites already work in phase 1).
5. **Wix** (phase 4). Unlisted app needs no review; the form works (embedded script), but page
   text can't be changed, only collections, blog posts and products.
6. **Framer**: not built. The owner pastes our snippet; revisit when the Server API is out of
   beta.

This matches the prior (WordPress and Shopify first, then Webflow, then Wix) with one
change: WordPress.com is folded into Webflow's phase because its Business sites already
connect as self-hosted.

## 3. One provider-neutral layer

The same agent tools, the provider chosen per connected site:

- `website_site.provider` (`github` or a builder) says which path a change takes. One
  live site per workspace, as today.
- `connect_website` gains `builder` (with `site_url`): it answers with the builder's connect
  link (WordPress: the "Authorize Application" page) instead of reading a repo. The
  callback saves the site.
- `change_website` on a builder site takes `page` and `edits` (exact text and its
  replacement). Called with only `page` (or nothing) it lists the pages, or returns the page's
  text, so the agent reads before it writes. The server applies the edits (each must match
  once), refuses anything that adds a script, a frame or an event handler, and raises the
  card.
- `wire_website_form` on a builder site takes `page` and a public form (`form_id`): a fresh
  form link, the builder's embed block appended to that page (an earlier embed of the same
  form has its key replaced in place).
- `undo_website_change` writes back the text the last change replaced, after checking the
  page is still what that change wrote.

Underneath, `web/src/lib/website/providers/` has one `BuilderClient` per builder (identity,
list, read, write, embed block), and `web/src/lib/website/builder.ts` is the flow. A builder
change is a `website_change` row like a pull request's, with `staged` holding the page, the
text before and after, and their hashes.

**Preview → approve → publish → undo**, as the GitHub path: the change is staged on our side,
the card (`merge_website_change`, the same tool, external-write) quotes exactly what is
replaced and with what (the "preview"), the yes writes it (the builder's publish), and undo
is a new change through the same yes. Nothing outward happens before the owner's yes. The
yes refuses a page that changed in the builder since the card was made (as the GitHub merge
refuses a moved head), and a stuck write is settled by reading the page back (`reconcile.ts`).

## 4. Migrations and settings

- **724_website_builders.sql** (the number the managing session assigned this branch, 2026-11-27; its own
  begin/commit, apply WITHOUT `--single-transaction`): `website_site.provider` (default
  `github`), `provider_site_id`, `credentials_encrypted` (the `v1` ciphertext of
  `src/lib/crypto/credentials.ts`, the same key as OAuth tokens); repo and branch NOT NULL
  relaxed into a check that keeps them for GitHub; `website_change.staged`. Additive; the
  app reads the columns only when present.
- **`WEBSITE_BUILDERS`** (in `deploy/app/.env.example`): which builders the agent may connect,
  comma-separated (`wordpress`). Empty: none, and the flow is exactly today's. WordPress needs
  no app credentials, so it is the only switch for phase 1.
- Later phases add, each with a `.env.example` line and off until filled:
  `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` (Dev Dashboard app, scopes
  `read_online_store_pages,write_online_store_pages,read_products,write_products`, redirect
  `<OAUTH_REDIRECT_BASE_URL>/api/oauth/shopify/callback`, theme app extension, App Store
  review for public distribution); `WEBFLOW_CLIENT_ID` / `WEBFLOW_CLIENT_SECRET` (Workspace
  app, the scopes above, Webflow review for a private install URL); `WPCOM_CLIENT_ID` /
  `WPCOM_CLIENT_SECRET` (developer.wordpress.com/apps); `WIX_APP_ID` / `WIX_APP_SECRET`
  (Wix Developers app, unlisted, "Manage Embedded Scripts" and the Data/Blog/Stores
  permissions, an Embedded Script extension). A builder's token belongs to the site, not to
  a person (a Shopify token is the store's), so it is kept on the site's row in
  `website_site.credentials_encrypted`, encrypted with the same key as the OAuth tokens
  (`src/lib/crypto/credentials.ts`); nothing in the repo.

**Before `WEBSITE_BUILDERS` is switched on, the edge must be reloaded with the Caddyfile
from this branch.** WordPress hands the application password (and the login's name) back in
the callback's query string, and the edge access-logs the app's requests and logs whole
requests on an upstream error: both log filters now redact `password` and `user_login`
(`deploy/edge/Caddyfile`, tested in `deploy/edge/tests/test_edge.py`). The callback also
answers with a 303 to its own path without the query, so the address leaves the browser's
history, and the WordPress client refuses a site whose name resolves to a private, loopback
or link-local address. The `deploy/edge` change holds the automatic deploys until a person
has reloaded the edge.

## 5. Onboarding

`text-setup.ts` offers to connect a WordPress site by text when the builder is on
(`WEBSITE_BUILDERS`), and still says the other builders are coming and moves on. Each phase
adds its builder to that sentence.

## 6. Phases

1. **Provider layer + WordPress self-hosted** (this branch): migration 724, the
   `BuilderClient` interface, the WordPress client, connect link and callback, edits, page
   form embed, undo, the card and the yes, the reconcile of a stuck write, the agent's
   section, onboarding, tests with a fake WordPress. Off until `WEBSITE_BUILDERS=wordpress`.
2. **Shopify** (built, mocked APIs): see §8. Later: the theme app extension for a
   site-wide form; App Store review if the owner picks a public app.
3. **Webflow** (CMS items) and **WordPress.com** (OAuth): built, mocked APIs, see §9. Later:
   Webflow's form (a placed element).
4. **Wix** (built, mocked APIs): see §10. Later: blog posts (their rich-content JSON).
5. **A quote form embed** (`data-ni-quote`): built, see §11.
6. **WordPress plugin** (site-wide form, wordpress.org directory).

## 7. Phase 1: what the owner checks for real

No real WordPress was called from the container: the tests use a fake one. To try it: set
`WEBSITE_BUILDERS=wordpress` on a non-production deploy, have an Administrator login on a
WordPress 5.6+ site on https, connect it by asking the agent ("my site is on WordPress,
example.com"), approve on WordPress, then ask for a text change and for a form on a page.

## 8. Phase 2: Shopify

Built against a fake store only; nothing registered (the owner hasn't chosen custom
distribution or a public app yet). Designed for **custom distribution** first: one store (or
one Plus organization), no App Store review; a public app changes only who may install it,
not this code.

- **Connect.** `connect_website` with `builder: "shopify"` and the store's `.myshopify.com`
  address (or its handle, or an admin link; a custom domain is refused with "ask for the
  myshopify one"). It answers the store's own consent link
  (`https://<store>.myshopify.com/admin/oauth/authorize`, the authorization code grant) with
  our scopes (`read_online_store_pages`, `write_online_store_pages`, `read_products`,
  `write_products`), the redirect `<NEXT_PUBLIC_APP_URL>/api/website/shopify/callback`, and
  our signed state (30 minutes). The callback (`src/app/api/website/shopify/callback`) checks
  Shopify's HMAC over the whole query with the app's secret, the state, that the person
  signed in is the one who asked, and that the store is the one asked for. It trades the
  code for the store's offline token server-side, and checks the token's scopes cover pages.
  The token is stored encrypted on the site's row. Then it answers a 303 to its own path with
  only a result code. The edge already redacts `code` and `state`; `hmac` is a 64-character
  run.
- **Changes.** Online Store pages (`pageUpdate`: body HTML and title) and product
  descriptions (`productUpdate`: `descriptionHtml` and title), through the same card and yes
  as WordPress. The yes refuses a page that changed since. Shopify keeps no revision, so the
  card says "I keep the earlier text, so it can be undone" and undo writes it back.
  `userErrors`, a throttle and a revoked token come back as plain words. Admin GraphQL
  `2026-10` (`SHOPIFY_API_VERSION` in `providers/shopify.ts`).
- **Form.** One of the business's public forms, as our embed in the page's body HTML. Shopify
  might keep or strip a script in a page's body (**unverified**), so the write is read back.
  If the embed's script is gone, the page is put back as it was, the form keeps its old link,
  and the owner is told to use the form's own link. The proper way, a theme app extension
  (an app embed block the merchant turns on in the theme editor), needs the app deployed with
  that extension: a later step.
- **Settings.** `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` (`deploy/app/.env.example`,
  `check_settings.py`), plus `shopify` in `WEBSITE_BUILDERS`. Named without both, Shopify
  stays off. No migration (724 already allows `shopify`).
- **Owner steps.** In the Shopify Dev Dashboard (dev.shopify.com), make an app; pick the
  distribution (Custom: enter the one store's myshopify domain; Public: App Store review).
  Set its App URL to the app's address and the allowed redirection URL above, and request
  the four scopes. Copy its Client ID and secret into the server's `.env`. Reload the edge
  first (as for WordPress), then add `shopify` to `WEBSITE_BUILDERS`. To try it: ask the
  agent "my store is on Shopify, <name>.myshopify.com", approve in Shopify admin, then ask
  for a change to a page and to a product description, say yes, and undo it.

## 9. Phase 3: Webflow and WordPress.com

Built against fakes only; nothing registered.

**Webflow** (`providers/webflow.ts`)
- **Connect:** `connect_website` with `builder: "webflow"` and the site's address answers
  Webflow's consent link (`webflow.com/oauth/authorize`, scopes `sites:read cms:read
  cms:write`, redirect `<NEXT_PUBLIC_APP_URL>/api/website/webflow/callback`, our signed
  state). The callback trades the code server-side, lists the sites the token reaches, and
  keeps the one whose custom domain or `webflow.io` address is the one asked for (or the only
  one approved); another site is refused.
- **Changes:** CMS items only, since Webflow's API can't write a static page's
  primary-language text. An item reads as one JSON object of its text fields (not the slug,
  not numbers or references). An edit replaces text inside it and must leave it valid with
  the same fields. The item's `name` is its title and changes only there. The yes writes
  with the item's live update (`PATCH /v2/collections/{id}/items/{item}/live`), which
  publishes that item and never the whole site. Webflow keeps no revision, so undo writes
  the earlier fields back. A 429 (60 to 120 a minute by site plan) is said plainly.
- **Form:** not yet. A page needs a placed element for our form, which a registered script
  alone doesn't give; the agent offers the embed snippet for an Embed element, or the form's
  own link.
- **Owner steps:** create the app in our Webflow Workspace (Workspace settings › Apps &
  Integrations › Develop › Create an App), with the Data client, the three scopes, and the
  redirect URI above. Copy its Client ID and secret into `WEBFLOW_CLIENT_ID` and
  `WEBFLOW_CLIENT_SECRET`, and add `webflow` to `WEBSITE_BUILDERS`. Until Webflow reviews the
  app (private or Marketplace), only our own Workspace's sites can install it.

**WordPress.com** (`providers/wordpress.ts`, the `WpcomLogin` shape)
- **Connect:** `builder: "wpcom"` and the site's address answers WordPress.com's consent
  link (`public-api.wordpress.com/oauth2/authorize`, one site by default: the owner picks
  it). The callback trades the code server-side (`/oauth2/token`); the answer names the
  token's one site (`blog_id`, `blog_url`), and a site other than the one asked for is
  refused.
- **Changes:** the self-hosted client's own pages and posts, through WordPress.com's wp/v2
  routes (`/wp/v2/sites/<id>/…`) with the token. Whether every route answers there is
  **unverified**; the tests use a fake. Revisions are kept, as self-hosted. Rights come from
  `/rest/v1.1/sites/<id>` (`edit_pages`, `edit_others_pages`).
- **Form:** only when the site reports `unfiltered_html` (plans with plugins); otherwise the
  agent says so. The write is read back either way (§8).
- **Owner steps:** create the app at developer.wordpress.com/apps (type Web, redirect URL
  `<NEXT_PUBLIC_APP_URL>/api/website/wpcom/callback`). Copy its Client ID and secret into
  `WPCOM_CLIENT_ID` and `WPCOM_CLIENT_SECRET`, and add `wpcom` to `WEBSITE_BUILDERS`. No
  review is documented.

No migration (724 already allows both). The tokens are kept encrypted on the site's row, as
Shopify's are.

## 10. Phase 4: Wix

Built against a fake only; nothing registered. Wix lets **no app change the words of a page
itself**. The agent says so in its tools, its section and onboarding; what it reaches on Wix
is the form on every page, CMS items and product descriptions.

- **Connect:** an **unlisted** app (no App Market review; installed by its link).
  `connect_website` with `builder: "wix"` and the site's address answers our install link
  (`www.wix.com/installer/install?appId=…&redirectUrl=…&state=…`). The owner picks the site
  and adds the app; Wix sends them to `/api/website/wix/callback` with the site's
  `instanceId` and our state. The callback checks the state and the signed-in person. It
  proves the install by minting a token for that instance with our app's id and secret (the
  client-credentials grant, `POST /oauth2/token`), and checks that the instance's site
  (`GET /apps/v1/instance`) is the one asked for. Nothing of a person's is kept: each call
  mints a short-lived token from the app's credentials and the site's instance id
  (`provider_site_id`). The exact installer parameters are **unverified**; the tests use a
  fake.
- **Form, site-wide:** the app's Embedded Script extension (end of body, one parameter,
  `formKey`), turned on with `POST /apps/v1/scripts`. It reads and writes as the embed's own
  markup, so the change goes through the same card, and the write is read back (§8). A
  second wiring replaces the form; undo turns the parameter back to what it was (an empty
  key draws nothing). Whether Wix's embedded scripts need a Premium site with a connected
  domain is **unverified**; a refusal is said plainly.
- **Changes:** CMS collection items (Wix Data v2; read as one JSON object of their text
  fields, without system fields; written with the item's other fields kept from Wix's own
  copy, since an update replaces the whole item) and product descriptions (Wix Stores v1,
  `PATCH /stores/v1/products/{id}`). Blog posts keep their text in Wix's rich-content JSON,
  so they are not covered yet. Wix keeps no revision, so undo writes the earlier text back.
- **Settings:** `WIX_APP_ID` and `WIX_APP_SECRET`, plus `wix` in `WEBSITE_BUILDERS`. No
  migration.
- **Owner steps:** in the Wix Developers dashboard (dev.wix.com), create an app and make it
  unlisted. Set its redirect URL (`<NEXT_PUBLIC_APP_URL>/api/website/wix/callback`) and the
  permissions above. Add an Embedded Script extension (end of body, functional) with the code
  in `deploy/app/.env.example` and its one parameter, `formKey`. Copy the App ID and secret
  into the server's `.env`. Reload the edge first, then add `wix`.

## 11. Phase 5: the quote form on every builder

The issue promises quote forms on every builder, and the quote intake had no drawn form of
its own. Now `public/f/embed.js` draws one from a fixed shape:
`<div data-ni-quote="qk_…"></div><script async src="<app>/f/embed.js"></script>`. A `qk_` key
in `data-ni-form` draws it too, for Wix's one-attribute template. It asks name, email, phone,
address, what they need, the details and when; posts JSON with the honeypot to
`/api/intake/quotes/<key>`; and needs a phone or an email, as the intake does (a test runs
what it posts through the intake's own parser).

- **Wiring:** `wire_website_form` on a builder site with no `form_id` puts the quote form
  there, through each builder's existing form path:
  - WordPress: a Custom HTML block on the page.
  - Shopify: the page's body.
  - Wix: the embedded script's one parameter, on every page.
  - WordPress.com: when its plan keeps scripts.
  - Webflow: not possible; the agent gives the snippet by hand.

  It goes through the same card. The card says the current quote link stops working, since
  one live quote key per workspace is the rule. Undo works the same way.
- **The yes:** the fresh `qk_` key, written in the page and hashed on the change, becomes the
  business's live quote key with the site's origins (`swap_quote_intake_key`, 463). The old
  one is revoked in the same transaction, as the GitHub path's wiring does. Wiring the same
  page again replaces the key in place.
- **By hand:** `create_quote_form_link` now also answers `embed`, the snippet, for a site the
  owner pastes into themselves.
- **Who:** only an owner or admin, as for the GitHub path's wiring.
- **Not done:** Wix blog posts. Their text lives in Wix's rich-content nodes and an edit goes
  through a draft and a publish, so they are not covered by plain text edits; a later step.
