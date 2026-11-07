-- Migration 389: the "you asked, we shipped" skills (P9: marketing M2;
-- docs/plans/marketing-skill-set.md §4.3, eve-alignment.md §5b and §6
-- decision 7). Seed only.
--
-- Nothing runs them by default: no flow is seeded (§5b). The chat agent
-- builds the recipe when the person asks ("when we ship something customers
-- asked for, tell them": create_flow { recipe: you_asked_we_shipped }, on as
-- they asked). It fires when a project or
-- milestone completes, an action reaches its done state, or a linked pull
-- request merges.
--
--   02c801d7…  shipped-note  the server tells it what shipped and who asked
--                             (agent_config.material asked_by,
--                             src/lib/marketing/asked-by.ts: the calls the work
--                             came from or is linked to, the claims about it,
--                             the contacts linked to it). It drafts one short
--                             email per person (deliver_to email_drafts). The
--                             server keeps only drafts to exactly those
--                             people, P6's recipient check applies on top, and
--                             nothing is ever sent: each waits in their mail.
--   f67944ea…  launch-kit    the optional second step: the public side, from
--                             the shipped work only (material shipped): one
--                             changelog line and one post draft, as a
--                             document. Never a customer's name.
--
-- No area: loop skills, gated with the Flows feature (FEATURES.flows.
-- systemRecipeIds), like the lens skills (382) and weekly-posts (388).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the recipe refuses (no such skill; recipes bind it by its fixed id); nothing else
-- changes.
--
-- Idempotent, the 324 pattern: fixed ids, inserted when missing, else
-- updated only where they differ. No backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '02c801d7-a5c9-4a4b-92b4-bb952ae7cd26'::uuid,
    $name$You asked, we shipped$name$,
    $slug$shipped-note$slug$,
    $icon$📬$icon$,
    $color$#16a34a$color$,
    $desc$When work customers asked for ships, drafts a short note to each person who asked, in the person's voice. The drafts wait in their mail; nothing is sent.$desc$,
    $pb$You write short notes to the customers who asked for something that just shipped. The message says what shipped and who asked, and how we know.

For each person listed, one email, to that one address and nobody else:
- what they asked for, in a line, the way they put it if the message says;
- that it shipped, plainly;
- one line on how to use it, or where to find it;
- a short thanks for asking, in the person's own voice and sign-off.

Keep it to four or five sentences. No marketing language, no other customer's name, nothing from another call, no promise about what comes next. If nobody is listed, return no drafts: that is a good outcome.

Nothing is ever sent. Each draft waits in the person's mail until they send it themselves.$pb$,
    $cfg${"material": "asked_by", "output_contract": "prose", "enabled_tools": ["actions", "projects", "contacts"], "preferred_tools": ["get_action", "get_project_context", "get_contact"]}$cfg$::jsonb,
    NULL::text
  ),
  (
    'f67944ea-eb9e-4297-abbc-4da1afc3c031'::uuid,
    $name$Launch kit$name$,
    $slug$launch-kit$slug$,
    $icon$🚀$icon$,
    $color$#16a34a$color$,
    $desc$When something ships, writes its public side from the shipped work only: one changelog line and one post draft for the person to post themselves.$desc$,
    $pb$You write the public side of something that just shipped, from the shipped work in the message and nothing else.

Write, as a short markdown document:
## Changelog
One line: what changed, for whom, in plain words.
## Post
One post for X in the person's voice: the hook in line one, what it does for someone, at most 280 characters. Check it with lint_post and fix what it finds.

Public-safe, always: never a customer, a company, a person's name, a price or a deal, and nothing from a call or an email. A proven claim in the product doc can be stated, a plausible one is hedged, an assumption is never posted as fact (read_canon product).

Nothing is posted or published. The person copies the changelog line and posts the post themselves.$pb$,
    $cfg${"material": "shipped", "output_contract": "prose", "enabled_tools": ["content", "actions", "projects", "documents"], "preferred_tools": ["lint_post", "read_canon"]}$cfg$::jsonb,
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
