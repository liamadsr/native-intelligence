-- ============================================================
-- 370: the write-a-document skill learns the documents phase 1 tools. Seed text only.
-- ============================================================
-- Documents phase 1 (migrations 364 to 367, PR #798) gave agents partial
-- reads, part edits, safe writes and version history, and 368 taught them in
-- the documents playbook. The pack-only `write-a-document` skill, seeded by
-- 327_docs_goals_tools_skills.sql and never rewritten since, still says:
--   `find` needs `all_time: true` ("otherwise it searches only recent
--   weeks"), but since 365 documents are searched in full;
--   `propose_document_edit` takes only the whole new `content`, but it now
--   needs `base_revision` too (src/lib/ai/tools/documents.ts), or it refuses;
--   `edit_document_content` is the only live edit, for a small fix.
--
-- The new text changes step 1 and "Changing an existing page", and keeps
-- every other line:
--   - step 1: `find` with the topic, with no `all_time`;
--   - `get_document` returns the `revision` every write takes as
--     `base_revision`;
--   - your own wording on someone's page (a rewrite, a section you write) is
--     a draft: `propose_document_edit` with the whole body (`full: true` on a
--     long page) and the `revision` as `base_revision`;
--   - a change the person spelled out, or any change to a page you just
--     created, goes live with a part tool: `edit_document_content`,
--     `edit_document_lines`, or the section tools `replace_section`,
--     `append_to_section`, `remove_section`, `insert_section_after`;
--   - a conflict means read again and redo the change.
-- The draft-versus-live rule is 368's, word for word where it can be.
--
-- One row and column: public.recipe.system_prompt, by id and slug, system
-- row only. Every other column (the description, agent_config, area) stays
-- as 327 left it.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- after 364 to 367 (the tools it names need them). Without it the skill keeps
-- teaching the old steps, and its drafts are refused for want of
-- `base_revision` until the model reads the tool's error; nothing else
-- changes.
--
-- src/lib/packs/__tests__/migration-370.test.ts pins this file: one row, the
-- write-a-document skill, rewriting the text 327 seeded; the part tools
-- named, each argument it names a real field of that tool; the stale
-- sentences gone; the lines it doesn't touch byte for byte; no backslash
-- anywhere (one MCP transport decodes escapes, so the applied SQL would
-- differ from the file).
--
-- Idempotent: updated by id, guarded by slug and is_system, and only where
-- the text differs, so a second run changes nothing. Then a check fails the
-- apply if that row isn't there or doesn't hold the new text.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '5s';

UPDATE public.recipe AS r
SET system_prompt = p.system_prompt,
    updated_at    = now()
FROM (VALUES
  -- write-a-document: the text 327_docs_goals_tools_skills.sql seeded, taught the phase 1 tools.
  ('a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb'::uuid, $slug$write-a-document$slug$, $pb$Write a document from a request or from its sources, file it on the right project and link it to the work. Reveal the documents tools with `search_tools` first, and the projects, captures, knowledge or actions tools (`get_action`) when the work needs them.

## Steps
1. Check it doesn't exist: `find` with the topic (documents are searched in full), or `list_documents` with `search`. When a page already covers it, change that one instead (below).
2. Gather only the sources the request names:
   - a meeting: `list_captures` (a `project_id` or a date window narrows it), then `get_capture_content` with its `capture_id`;
   - a project: `list_projects` with `search`, then `get_project_context` with its `project_id` for the milestones, recent meetings and open work;
   - what's known, when the Knowledge tools are there: `list_claims` about the entity, or `get_context_bundle` around it.
   With nothing to go on, ask what it should cover rather than inventing.
3. The home: the project the sources belong to (the meeting's, or the one the request names). Ask when it could be two; leave it unfiled only when nothing fits.
4. Write it: a one-line purpose, headings, short paragraphs, decisions and open questions called out; owners and dates on a plan, acceptance criteria on a spec. Cite the sources ("from the Oct 2 pricing call"), and link related pages with [[slug]].
5. Save: `create_document` with the `title`, the `content` and the `project_id`. It's live at once: when the person wants to review it before the team sees it, show the text in chat first and save on their yes.
6. Link: `link_document_to_action` with the action's `id` for each action it specifies (a spec to its ticket; look up an identifier like ENG-42 with `get_action` first). When it names new work, offer the actions, and link them once made.

## Changing an existing page
Never replace someone's page with a new one. Read it with `get_document`: it returns the `revision` you pass as `base_revision` when you write.
- Your own wording on their page (a rewrite, a section you write) goes in as a draft: apply the change to the full body (`full: true` on a long page), then `propose_document_edit` with the whole new `content` and the `revision` you read as `base_revision`. They publish it from the page. Nothing you can read shows whether they have unpublished edits there. Unless they just asked for this change, ask first: proposing replaces any unpublished draft of theirs on that page.
- A change they spelled out (fix this typo, add this line, drop that section), or any change to a page you just created, goes live with a part tool: `edit_document_content` for one exact passage, `edit_document_lines` for lines by number, or `replace_section`, `append_to_section`, `remove_section` and `insert_section_after` for one section by its heading. If the page changed since you read it, you get a conflict: read it again and redo the change.
- `publish_draft` only when they ask to publish.

## The answer
One line: the title, where it lives, what it links to, and whether it's live or a draft waiting on its page. Then the open questions the page leaves for the person.$pb$)
) AS p (id, slug, system_prompt)
WHERE r.id = p.id
  AND r.slug = p.slug
  AND r.is_system
  AND r.system_prompt IS DISTINCT FROM p.system_prompt;

-- Fail loudly, never silently: the row this rewrites must be there (a wrong
-- id would update nothing), and must now hold the new text. A second run
-- updates nothing and passes both checks.
DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.recipe
     WHERE id = 'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb'::uuid
       AND slug = 'write-a-document'
       AND is_system
  ) THEN
    RAISE EXCEPTION '370: the system write-a-document skill (a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb, write-a-document) is not there';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.recipe
     WHERE id = 'a4b9263b-eb4d-4c57-afcc-7f8cd40bf1bb'::uuid
       AND system_prompt LIKE '%edit_document_lines%'
       AND system_prompt LIKE '%base_revision%'
  ) THEN
    RAISE EXCEPTION '370: the write-a-document skill was not rewritten';
  END IF;
END
$guard$;
