-- Migration 388: the weekly-posts skill, the skill of the opt-in "weekly X
-- posts" recipe (P9: content C1; docs/plans/content-skill-set.md §4,
-- eve-alignment.md §5b and §6 decisions 2 and 3). Seed only.
--
-- Nothing runs it by default: no flow is seeded (§5b, capabilities not
-- defaults). The chat agent builds the recipe when the person asks ("draft X
-- posts for me every week": create_flow { recipe: weekly_posts }, on as they
-- asked). Each run:
--   - is told the week's material by the SERVER (agent_config.material
--     post_week, src/lib/content/post-week.ts): the person's own moments from
--     their calls (the content lens's rows, never a re-read of a call), what
--     shipped, what was published, their brief;
--   - returns post drafts (deliver_to post_drafts): For you cards the person
--     posts themselves, at most the loop's slots waiting at once (3 by
--     default), each gone after 7 days. Nothing is ever posted for them;
--   - on a slow week brings ideas, marked as ideas (decision 3: never an
--     empty week). The server marks every post of a week with no material an
--     idea, whatever the run says, and refuses a post that names someone from
--     the person's calls.
--
--   80d160c4…  weekly-posts
--
-- agent_config: `material` asks for the week's material; `enabled_tools`
-- content (lint_post, and the content playbook in the run), documents
-- (get_document on a published document), actions and projects (what
-- shipped). No area: it belongs to a loop, gated with the Flows feature
-- (FEATURES.flows.systemRecipeIds, src/lib/editions/manifest.ts), like the
-- lens skills (382).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the weekly_posts recipe refuses (no such skill; recipes bind it by its fixed id);
-- nothing else changes.
--
-- Idempotent, the 324 pattern: a fixed id, inserted when missing, else
-- updated only where it differs. No backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '80d160c4-1b4a-481d-8b76-aa7fc1609326'::uuid,
    $name$Weekly posts$name$,
    $slug$weekly-posts$slug$,
    $icon$🗓️$icon$,
    $color$#0ea5e9$color$,
    $desc$Drafts the week's posts for the person's own account from what they shipped, published and said on their calls; a slow week brings ideas. Each is a card they post themselves.$desc$,
    $pb$You draft this week's posts for the person's own account, in their voice, from the material in the message. Each post becomes a card they read; they post it themselves, or skip it. Nothing is ever published for them.

What a post may rest on: the moments from their own calls (their words, kept as themes), what shipped, the documents published this week, and how the product doc describes the product (read_canon product: state a proven claim, hedge a plausible one, never post an assumption as fact). Never mail, the CRM or a private call, and never a name, a company, a customer, a price or a deal: the server refuses a post that names someone from their calls.

Their brief, when the message carries it, wins on themes, voice and what never to post.

The craft follows the content playbook: the hook in line one, one idea, concrete (a number, a before and after, the thing that shipped), the platform's limit counted its way, no hashtag pile, no bait. Read a document with get_document before you quote it. Check each post with lint_post (its sources: the action, document or call it rests on) and fix what it finds.

Each post says in `based_on` what it rests on, in a few words, and names in `uses` the moment keys it drew on.

A slow week is never an empty week. When the material can't fill a slot honestly, bring an idea instead and mark it `idea: true`: a theme from the brief, a lesson in their voice, a past post revisited, or a question for their audience. An idea is never presented as this week's work, and never filler.$pb$,
    $cfg${"material": "post_week", "output_contract": "prose", "enabled_tools": ["content", "documents", "actions", "projects"], "preferred_tools": ["lint_post", "read_canon", "get_document"]}$cfg$::jsonb,
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
