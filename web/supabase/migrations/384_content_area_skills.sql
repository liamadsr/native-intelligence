-- Migration 384: the content and marketing areas, and the content skills
-- (P8: content C0; docs/plans/content-skill-set.md §2 and §6,
-- eve-alignment.md §6 decisions 2, 3 and 4). Seed and CHECKs only.
--
-- 1. The area CHECKs learn two areas with no page of their own (decision 4:
--    content is its own area; marketing beside it): recipe.area (316),
--    area_memory.area and area_memory_learning_run.area (317),
--    tracked_job.area and chat_conversations.focus_area (318). The list is
--    AREA_KEYS in src/lib/packs/registry.ts.
-- 2. Three system skills in the content area:
--      240170e8…  content-playbook  the core: what a post may rest on, the
--                                    public-safe rule, the checks (lint_post,
--                                    review_post), slow-week ideas, and the
--                                    recipes the agent sets up only on request
--      75313979…  x-post            one X post or a short thread
--      cb4dd812…  linkedin-post     one LinkedIn post
--    The two surface skills are pack-only: they list inside the content pack,
--    which loads with its playbook or the first post check.
--
-- Nothing runs: no flow is seeded (§5b, capabilities not defaults). Dial8
-- never publishes a post (decision 2): the person posts from the compose
-- link, on the platform's own page.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the content and marketing areas can't tag a skill or a memory
-- line, and the content pack has no playbook.
--
-- DEPLOY ORDER (P8 review S5): 382, then 384, 385, 386 and 387, all on PROD
-- BEFORE the P8 code deploys. The code tags skills, memory lines and work
-- with the two new areas (a CHECK without them refuses the row), its
-- playbooks name the 384/385 skills, and its tool category needs 387 for
-- inherit-all personas.
--
-- Each CHECK is re-added NOT VALID and then validated: the add takes its
-- ACCESS EXCLUSIVE lock without scanning the table, and VALIDATE scans under
-- a SHARE UPDATE EXCLUSIVE lock that lets reads and writes go on. That only
-- shortens the exclusive window when the statements run one by one; inside a
-- single transaction the add's lock is held to commit either way (these
-- tables are small, and lock_timeout bounds the wait). Every existing row
-- already passes: the old list is a subset of the new one.
--
-- Idempotent, the 324 pattern: the CHECKs dropped and added again, fixed ids,
-- skills inserted when missing, else updated only where they differ. No
-- backslash anywhere in this file.

SET LOCAL lock_timeout = '5s';

-- ── 1. The area CHECKs ────────────────────────────────────────────────────

ALTER TABLE public.recipe DROP CONSTRAINT IF EXISTS recipe_area_check;
ALTER TABLE public.recipe ADD CONSTRAINT recipe_area_check CHECK (
  area IS NULL OR area IN ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library', 'content', 'marketing')
) NOT VALID;
ALTER TABLE public.recipe VALIDATE CONSTRAINT recipe_area_check;

ALTER TABLE public.area_memory DROP CONSTRAINT IF EXISTS area_memory_area_check;
ALTER TABLE public.area_memory ADD CONSTRAINT area_memory_area_check CHECK (
  area IN ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library', 'content', 'marketing')
) NOT VALID;
ALTER TABLE public.area_memory VALIDATE CONSTRAINT area_memory_area_check;

ALTER TABLE public.area_memory_learning_run DROP CONSTRAINT IF EXISTS area_memory_learning_run_area_check;
ALTER TABLE public.area_memory_learning_run ADD CONSTRAINT area_memory_learning_run_area_check CHECK (
  area IN ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library', 'content', 'marketing')
) NOT VALID;
ALTER TABLE public.area_memory_learning_run VALIDATE CONSTRAINT area_memory_learning_run_area_check;

ALTER TABLE public.tracked_job DROP CONSTRAINT IF EXISTS tracked_job_area_check;
ALTER TABLE public.tracked_job ADD CONSTRAINT tracked_job_area_check CHECK (
  area IS NULL OR area IN ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library', 'content', 'marketing')
) NOT VALID;
ALTER TABLE public.tracked_job VALIDATE CONSTRAINT tracked_job_area_check;

ALTER TABLE public.chat_conversations DROP CONSTRAINT IF EXISTS chat_conversations_focus_area_check;
ALTER TABLE public.chat_conversations ADD CONSTRAINT chat_conversations_focus_area_check CHECK (
  focus_area IS NULL OR (
    focus_area IN ('calendar', 'actions', 'captures', 'documents', 'knowledge', 'initiatives', 'projects', 'flows', 'mail', 'crm', 'prospecting', 'sequences', 'campaigns', 'evals', 'browser', 'library', 'content', 'marketing')
    AND ai_team_member_id IS NULL
    AND agent_teammate_id IS NULL
  )
) NOT VALID;
ALTER TABLE public.chat_conversations VALIDATE CONSTRAINT chat_conversations_focus_area_check;

COMMENT ON COLUMN public.recipe.area IS
  'The area of Dial8 a skill belongs to (the 16 pages, library = Agents & skills, plus content and marketing, 384). Its pack loads it. NULL: no area.';

-- ── 2. The content skills ─────────────────────────────────────────────────

WITH skill (id, name, slug, icon, color, description, system_prompt, agent_config, area) AS (
  VALUES
  (
    '240170e8-53d5-4f79-accd-19725eecee21'::uuid,
    $name$Content playbook$name$,
    $slug$content-playbook$slug$,
    $icon$✍️$icon$,
    $color$#0ea5e9$color$,
    $desc$How to write posts for the person's own X, LinkedIn, Threads and Bluesky from their work, checked and cited; they post each one themselves. Loads by itself when you draft a post.$desc$,
    $pb$How posts work in Dial8, and how to help the person write for their own accounts on X, LinkedIn, Threads and Bluesky.

## What's here
- Dial8 drafts; the person posts. Nothing is ever published for them, now or later, whatever trust is earned: every post goes out by their own click on the platform's page, from the post link. Never call a post published, scheduled or sent.
- Two checks, revealed with `search_tools`: `lint_post` (no model call: the writing rules, the platform's limits counted its way, the public-safe screen over the text and its sources, and that it cites what it rests on) on every version, and `review_post` once on the version you mean to show (a reviewer from another model vendor reads only the post: ready or revise, with quoted issues). Both only read.
- The platforms: X 280 characters (a link counts as 23), LinkedIn 3,000 with the hook in the first 140, Threads 500 and one topic tag, Bluesky 300 (a link doesn't count). How each one reads is in its skill: `x-post`, `linkedin-post`. Threads and Bluesky follow `x-post`.
- Nothing runs by itself. A standing loop is a flow the person asks for (Recipes below).

## How to find things
What a post may rest on, and nothing else:
- shipped work: `list_actions` with `status` completed, `time_field` updated_at and `since` a week ago; a project's progress with `get_project_context`;
- published documents: `list_documents`, then `get_document`;
- how to describe the product: `read_canon` with key product. Its claims are graded: state a proven one plainly, hedge a plausible one ("we think", "early users tell us"), and never post an assumption as fact;
- the person's own words: this chat, and what they said on a call (`get_capture_content`), as a theme in their words, never another speaker's;
- their brief, when they keep one: `read_canon` with key content-brief:x (themes, voice, never-post list).
Never mail, the CRM, sequences, prospecting or a private call. Not even a name from them: a customer, a company, a person, a price or a deal never goes in a post.

## Doing it well
1. The platform: X when they don't say. Load its skill.
2. The one thing worth saying: a result, a number, a before and after, the thing that shipped. Read the sources first; every fact in the post comes from one of them. A fact you can't find is a gap: ask in one line, never guess it.
3. Draft in their voice: first person, plain, specific, no hype. The house writing rules hold.
4. `lint_post` with every source (its kind and id, and a note on which part). Fix what it finds, check again.
5. `review_post` once. Fix its high and medium issues without changing a fact or a source, then `lint_post` again.
6. Answer with the post, one line on what it's based on, and the post link as a markdown link ("Post on X"). One version, unless they asked for options.
7. "Punchier", "drop the number": change only that, and check again.

A slow week is never an empty week. When their work has nothing worth a post, still bring ideas: a theme from their brief, a lesson in their voice, a past post revisited, a question for their audience, or public industry news from a web search. Pass `idea` true to the checks and say it's an idea, not this week's work.

## Recipes (only when they ask; nothing is seeded for anyone)
- "Draft X posts every week": `create_flow` with a weekly schedule and one `run_skill` step with `deliver_to` post_drafts. Each post is a For you card they post with one click; at most 3 wait at once, and an untouched one goes after 7 days. Defaults: 3 posts a week, slow weeks bring ideas.
- "Watch my calls for post ideas": a `capture_processed` flow on the `content-lens` skill. It rides the one read of each call and keeps their own moments for the weekly posts.
- "Write my newsletter every Friday": a schedule flow whose output is a document they shape in the chat and copy into their own tool. Dial8 never sends a newsletter.
Build it with `enabled` true (they asked, so it is on) and say it in one line.

## Pitfalls
- No post link means the public-safe screen found something: fix it first. Never hand them text to post that failed it.
- One idea per post. On X a link cuts reach: last line, or say it goes in the first reply.
- Never invent a metric, and never read a trend into a couple of posts.

## When to hand to a helper
If you have `helpers` (main chat only), split work across them where this playbook or the skill you're running says to; without them (a loop, or any run without that tool), do the work here.$pb$,
    $cfg${"enabled_tools": ["content", "actions", "documents", "projects", "captures", "flows"], "preferred_tools": ["lint_post", "review_post", "list_actions", "read_canon", "list_documents", "get_document"]}$cfg$::jsonb,
    'content'
  ),
  (
    '75313979-5de2-4f21-9660-f321f84d1c61'::uuid,
    $name$X post$name$,
    $slug$x-post$slug$,
    $icon$𝕏$icon$,
    $color$#111827$color$,
    $desc$Write one X post (or a short thread) in the person's voice from their own work, cited, linted and reviewed, with the link that opens X to post it. Also for Threads and Bluesky.$desc$,
    $pb$One post (or a short thread) for X in the person's voice, from their own work, checked before they see it. Reveal `lint_post` and `review_post` with `search_tools` first. For Threads or Bluesky, the same craft with that surface in the checks.

## The craft
- The hook is line one: the point, the result or the surprise. Never "A thread on…", never a question nobody asked. A hook promises only what the post delivers.
- One idea. Concrete: a number, a before and after, the thing that shipped and what it does for someone.
- At most 280 characters; aim for about 240 to 259. A link counts as 23. Plain text: no markdown, no "1/" numbering.
- A link cuts reach: put it on the last line, or tell them it goes in the first reply.
- Hashtags: 0 to 2, usually none. No engagement bait ("RT if you agree", "let that sink in", "follow me for more"). End on a takeaway or a real question.
- Their voice: first person, plain, a little dry. Their brief and voice notes beat these defaults.
- Claims: a proven line of the product doc can be stated; a plausible one is hedged; an assumption is never posted as fact. No "the first" or "the only" without proof.

## Threads
Only when one post can't hold it. The first post stands alone, since most people read only that one; one beat per post; close on the payoff. Pass the posts as `parts`. The post link opens the first; they post the rest as replies.

## Steps
1. Find the moment and its sources: `list_actions` (completed this week), the document or call they name, `read_canon` for product facts. Keep each source's id.
2. Write it.
3. `lint_post` with surface x, the text and its `sources`. Fix and check again until it passes.
4. `review_post` once. Fix its high and medium issues, keeping every fact, then `lint_post` again.
5. Answer: the post in a quote block, "Based on: …" in one line, and the post link as [Post on X](link). Add a line only when the review raised something only they can decide.

## The bar
Weak: "Excited to announce our new feature! It's a game-changer for teams. #AI #productivity"
Strong: "We cut our signup form from 9 fields to 1 this week. More people now finish it than drop off. The hard part was deciding what we could stop asking."
The strong one says what changed, by how much, and one true thing about doing it.$pb$,
    $cfg${"enabled_tools": ["content", "actions", "documents", "projects", "captures"], "preferred_tools": ["lint_post", "review_post", "list_actions", "read_canon"], "pack_only": true}$cfg$::jsonb,
    'content'
  ),
  (
    'cb4dd812-f165-4355-a006-91c7d0f4a5ac'::uuid,
    $name$LinkedIn post$name$,
    $slug$linkedin-post$slug$,
    $icon$💼$icon$,
    $color$#0a66c2$color$,
    $desc$Write one LinkedIn post in the person's voice from their own work: the hook before "see more", a short story, cited, linted and reviewed, with the link that opens LinkedIn to post it.$desc$,
    $pb$One LinkedIn post in the person's voice, from their own work, checked before they see it. Reveal `lint_post` and `review_post` with `search_tools` first.

## The craft
- About 140 characters show before "see more". The hook lives there: one short line that makes the next one worth reading, then a blank line.
- A short story beats a list of claims: the situation, what they tried, what happened, what they'd tell someone else. One lesson per post.
- Short paragraphs, a blank line between them. Plain text: no markdown, no bold, no bullet symbols pasted in.
- At most 3,000 characters; most good ones are far shorter. Cut anything the story doesn't need.
- Concrete: a number, a before and after, the thing that shipped. No "I'm humbled to announce", no "Agree?" bait, no tagging people for reach.
- Hashtags at the end, at most three, often none. A link cuts reach: last line, or say it goes in the first comment.
- Claims: a proven line of the product doc can be stated; a plausible one is hedged ("we think", "early users tell us"); an assumption is never posted as fact.
- Their voice wins: their brief and voice notes beat these defaults. Never write about a customer, a deal or someone else's words, even with a good outcome: that needs the customer's yes first.

## Steps
1. Find the moment and its sources: `list_actions` (completed recently), a project with `get_project_context`, the document they name, `read_canon` for product facts. Keep each source's id.
2. Write it: the hook line, then the story in three to six short paragraphs, then the takeaway.
3. `lint_post` with surface linkedin, the text and its `sources`. Fix and check again until it passes. A note about the hook means the first line runs past what shows before "see more".
4. `review_post` once. Fix its high and medium issues, keeping every fact, then `lint_post` again.
5. Answer: the post in a quote block, "Based on: …" in one line, and the post link as [Post on LinkedIn](link). Nothing posts until they post it there.

## The bar
Weak: "Thrilled to share that we launched something huge today. So proud of this team! #innovation #growth #leadership #startups"
Strong, with a blank line between its three parts:
"We stopped asking new users nine questions."
"For a year our signup form had nine fields, because each one answered a question someone on the team had once. This week we cut it to one. More people now finish signing up than leave."
"The lesson: every field you add is a question you're asking a stranger before they trust you."$pb$,
    $cfg${"enabled_tools": ["content", "actions", "documents", "projects", "captures"], "preferred_tools": ["lint_post", "review_post", "list_actions", "read_canon"], "pack_only": true}$cfg$::jsonb,
    'content'
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
