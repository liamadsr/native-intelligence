-- Migration 382: the two lens skills (flows F3; docs/plans/eve-alignment.md
-- §5b and §6 decision 6's amendment). Seed only.
--
-- A lens is how a post-call feature reads a call WITHOUT a second read: a
-- capture_processed flow whose skill carries agent_config.lens rides the one
-- Triage run on each call (src/lib/flows/lenses.ts, lens-plan.ts). These two
-- rows are the lens-capable skills such a flow names. Nothing runs them by
-- default: no flow is seeded (§5b, capabilities not defaults); the chat agent
-- builds one when the person asks ("watch my calls for post ideas", "keep our
-- product doc current from customer calls"), and it is on as they asked.
--
--   8ef0cb7e…  content-lens    post-worthy moments in the person's own words,
--                               from calls they were on → tags for the weekly
--                               post pass (lens_finding, migration 397).
--   b0a0af26…  marketing-lens  objections, competitors, customer language,
--                               contradictions and testimonial candidates on
--                               external calls → section edits on the product
--                               doc, at most one batch a day; testimonials stay
--                               internal.
--
-- The prompt here is what a lens flow's OWN run reads (Triage off, the
-- fallback). On Triage, the lens's section (lenses.ts) rides the triage
-- message instead; the delivery is the same code either way, and the lens's
-- conditions are checked in code before anything runs.
--
-- agent_config: `lens` names the lens; `enabled_tools` ["captures"] keeps a
-- lone run to reading the call. No area: they belong to flows, gated with the
-- Flows feature (FEATURES.flows.systemRecipeIds, src/lib/editions/manifest.ts).
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it, no lens skill exists to build a lens flow from; nothing else
-- changes.
--
-- Idempotent, the 324 pattern: fixed ids, inserted when missing, else updated
-- only where they differ. No backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30'::uuid,
    $name$Content lens$name$,
    $slug$content-lens$slug$,
    $icon$🎙️$icon$,
    $color$#0ea5e9$color$,
    $desc$Watches the person's calls for post-worthy moments in their own words and keeps them for the weekly post pass. Rides the one read of each call; never posts anything.$desc$,
    $pb$You read one meeting the person was on and pick out the moments worth a post, in their own words.

What counts: a lesson they learned, a decision they made and why, a result that surprised them, a strong opinion, something they built or shipped. Only what the person themselves said.

Public-safe, always: never another speaker's words, never a name, company, customer, price or deal, nothing said in confidence. When in doubt, leave it out.

Read the call with get_capture_content, and get_capture_transcript when you need their exact words. Keep at most three moments, each at most 280 characters, with a few words of theme. A call with nothing post-worthy gets nothing: that is a good outcome.

Your result is the lens section described in the message, never prose. Nothing you return is posted or drafted: it is kept for the person's weekly post drafts, which they always approve.$pb$,
    $cfg${"lens": "content", "output_contract": "prose", "enabled_tools": ["captures"]}$cfg$::jsonb,
    NULL::text
  ),
  (
    'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'::uuid,
    $name$Marketing lens$name$,
    $slug$marketing-lens$slug$,
    $icon$📣$icon$,
    $color$#f97316$color$,
    $desc$Watches external calls for what customers say: objections, competitors, their language, contradictions and testimonial candidates. Keeps the product doc current, at most one batch a day.$desc$,
    $pb$You read one call with people from outside the workspace and keep what the customer side said that the product doc should know.

Look only at what they said, never our own pitch:
- objection: a concern or reason not to buy that the doc should answer;
- competitor: a product, or what they use today, that they compared us with;
- customer_language: a phrase they used for the problem or the product, worth reusing;
- contradiction: something they said that the product doc gets wrong;
- testimonial: a strong outcome in their words. It stays internal until the customer says yes.

Read the call with get_capture_content, and get_capture_transcript for their exact words. Keep at most six items, each with a line in our own words (never quoting them) and their exact quote. Only what is new; nothing new means return nothing.

Your result is the lens section described in the message, never prose. The system adds your lines, in our words only, to the product doc (in its history, undoable); their quotes and the testimonials stay internal.$pb$,
    $cfg${"lens": "marketing", "output_contract": "prose", "enabled_tools": ["captures"]}$cfg$::jsonb,
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
