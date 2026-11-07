-- Migration 390: the newsletter skill, the skill of the opt-in weekly
-- newsletter recipe (P9; docs/plans/eve-alignment.md §5b and §6 decision 9,
-- content-skill-set.md C4). Seed only.
--
-- Decision 9: Dial8 never sends a newsletter, and its own admin Resend is
-- not offered as a service. The agent writes the issue as a Dial8 document;
-- the person shapes it in the chat and copies it (the document's Copy text
-- button: markdown plus rich text) into Substack, HubSpot, Mailchimp or
-- wherever they send from. No list, no sending, no campaign.
--
-- Nothing runs it by default: no flow is seeded (§5b). The chat agent builds
-- the recipe when asked ("write my newsletter every Friday":
-- create_flow { recipe: weekly_newsletter }, on as they asked). Each run is
-- told the week by the server
-- (agent_config.material week_of_work, src/lib/content/post-week.ts: their
-- moments from calls, what shipped, what was published) and writes the
-- issue as the run's document.
--
--   d53ec7d9…  content-newsletter (not `newsletter`: a workspace may already
--               have a skill of that slug; the recipe binds by this id)
--
-- agent_config: no mail, campaign or sequence tools at all, in any mode;
-- documents, actions and projects to read. No area: a loop skill, gated
-- with the Flows feature, like 382, 388 and 389.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the recipe refuses (no such skill); nothing else
-- changes.
--
-- Idempotent, the 324 pattern. No backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    'd53ec7d9-10c9-476f-ba39-06b9f261bff1'::uuid,
    $name$Newsletter$name$,
    $slug$content-newsletter$slug$,
    $icon$📰$icon$,
    $color$#0ea5e9$color$,
    $desc$Writes this week's newsletter issue from what the person shipped, published and said, as a document they shape in the chat and copy into their own tool. Never sent.$desc$,
    $pb$You write this week's newsletter issue for the person, in their voice, from the material in the message. It becomes a document they edit in Dial8 and copy into their own newsletter tool. Dial8 never sends it.

The shape, in markdown:
# A short, specific subject line
One or two sentences that say why this issue is worth opening.
## What shipped
The few things that matter to a reader, each with what it does for them.
## What we learned
One lesson from the week, in their words.
## One question
A real question for their readers.

Public, so public-safe: shipped work, published documents and their own words only. Never mail, the CRM or a private call, and never a customer, a company, a person's name, a price or a deal. How to describe the product comes from read_canon product: state a proven claim, hedge a plausible one, never print an assumption as fact. Read a document with get_document before you quote it.

Short beats long: most issues are under 400 words. No hype, no filler. A slow week gets a short issue, never invented news.

Never send anything, never draft an email, never create a campaign: the person copies it out themselves.$pb$,
    $cfg${"material": "week_of_work", "output_contract": "prose", "enabled_tools": ["documents", "actions", "projects"], "preferred_tools": ["read_canon", "get_document", "list_actions"]}$cfg$::jsonb,
    NULL::text
  )
),
inserted AS (
  INSERT INTO public.recipe (
    id, workspace_id, name, slug, icon, color, description,
    system_prompt, agent_config, area,
    category, is_system, is_default, sort_order, visibility
  )
  SELECT id, NULL::uuid, name, slug, icon, color, description,
         system_prompt, agent_config, area,
         'skill'::public.recipe_category, true, false, 0, 'workspace'::public.recipe_visibility
  FROM skill
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
UPDATE public.recipe AS r
SET name          = p.name,
    slug          = p.slug,
    icon          = p.icon,
    color         = p.color,
    description   = p.description,
    system_prompt = p.system_prompt,
    agent_config  = p.agent_config,
    area          = p.area,
    updated_at    = now()
FROM skill AS p
WHERE r.id = p.id
  AND (r.system_prompt IS DISTINCT FROM p.system_prompt
       OR r.description IS DISTINCT FROM p.description
       OR r.agent_config IS DISTINCT FROM p.agent_config
       OR r.area IS DISTINCT FROM p.area
       OR r.slug IS DISTINCT FROM p.slug
       OR r.name IS DISTINCT FROM p.name
       OR r.icon IS DISTINCT FROM p.icon
       OR r.color IS DISTINCT FROM p.color);
