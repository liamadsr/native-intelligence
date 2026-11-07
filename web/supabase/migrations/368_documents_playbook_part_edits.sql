-- ============================================================
-- 368: the documents playbook learns the documents phase 1 tools. Seed text only.
-- ============================================================
-- Documents phase 1 (migrations 364 to 367, PR #798) gave agents partial
-- reads, part edits, safe writes and version history. The chat system prompt
-- and the tool descriptions already say so; the documents playbook, seeded by
-- 327_docs_goals_tools_skills.sql and rewritten by 338_skill_helper_lines.sql,
-- still teaches only `edit_document_content` and a whole-body
-- `update_document`, and says things that are no longer true:
--   "Publishing keeps the old version as a revision; a live edit keeps none."
--   "Neither keeps a revision."
--   "A live edit is overwritten if the person later publishes an older draft."
--   `find` needs `all_time: true` to reach older documents.
--
-- The new text, the same five sections:
--   - read part of a long page: `get_document` with `section`, `lines`,
--     `match` or `outline: true`; it returns the `revision`;
--   - change part of a page: `edit_document_content`, `edit_document_lines`
--     (with `base_revision`) and the section tools `replace_section`,
--     `append_to_section`, `remove_section`, `insert_section_after`, rather
--     than rewriting the whole body;
--   - every write is safe against someone else's edit and returns the new
--     `revision`; a conflict means read again and redo the change;
--   - `update_document` replaces the whole body and needs `base_revision`;
--   - history: `list_document_revisions`, `get_document_revision`, and
--     `restore_document_revision`, which is attended-only
--     (ATTENDED_ONLY_TOOL_NAMES): only in a chat, when the person asks;
--   - `publish_draft` refuses a stale draft unless the person says
--     `overwrite`;
--   - documents are searched in full (365); reports and preps are left out of
--     the lists unless asked for (367: `include_reports`, `include_preps`, the
--     card's `kind` filter).
-- The draft-versus-live rule stays, said for the part tools: a change the
-- person spelled out goes live, your own wording on someone's page (a
-- rewrite, a section you write) goes in as a draft.
-- The helper section keeps 338's line.
--
-- Same row and column as 338: public.recipe.system_prompt, by id and slug,
-- system row only. Every other column stays as 327 left it.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word,
-- after 364 to 367 (the tools it names need them). Without it the playbook
-- keeps teaching the old tools; nothing else changes.
--
-- src/lib/packs/__tests__/migration-368.test.ts pins this file: one row, the
-- documents playbook, rewriting the text 338 left; every phase 1 tool named;
-- the stale sentences gone; the parts it doesn't touch byte for byte; no
-- backslash anywhere (one MCP transport decodes escapes, so the applied SQL
-- would differ from the file).
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
  -- documents-playbook: the text 338_skill_helper_lines.sql wrote, taught the phase 1 tools.
  ('e8d88dec-0326-41b0-971e-f974c21cdefb'::uuid, $slug$documents-playbook$slug$, $pb$How documents work in Dial8, and how to write and edit them so the person stays in control.

## What's here
- A document is a markdown page in the workspace: specs, notes, plans, briefs, the team wiki. It can belong to a project and a team, and be linked to actions. Archived pages drop out of the lists, and so do skill and loop reports and meeting preps unless you ask for them.
- Each document has a slug, and [[slug]] (or [[slug|label]]) in a page links to another; the links become graph edges and backlinks, and links to missing pages show red.
- Two ways to change one: straight to the live page, or as a draft the person reviews and publishes. Each person has at most one pending draft per document, opened on its page with Publish and Discard.
- Every change to a page's title or body, live or published, is kept as a numbered revision: who made it (a person, or Dial8 for one), what and when. The page's History shows them, and any one can be put back.

## How to find things
Every documents tool needs `search_tools` first; `find` and `show` are always there.
1. "What do we have on pricing": `find` with the topic ranks documents alongside meetings and knowledge (`types` document narrows it). Documents are searched in full; `all_time: true` widens meetings and mail past recent weeks too. Look here, or in `list_documents` with `search`, before creating a page.
2. `list_documents` lists them (20 by default, `limit` for more), pinned first, then newest edited, narrowed by `project_id`, a `search` over their text, or `since`/`until` with `time_field` updated_at or created_at. Reports and preps only with `include_reports` or `include_preps`.
3. `get_document` returns the live content with its backlinks and outbound links, and its `revision`. A long page comes back as its outline: read just the part you need with `section` (a heading), `lines` (from and to) or `match` (a phrase: the lines around each place it appears). `outline: true` gives the outline of any page. It doesn't show a pending draft.
4. `list_action_documents` lists the documents linked to an action.
5. `show` with `entity_type: document` puts them in the chat: filter `project_id`, `created_by` (@me works), `title` contains, `is_pinned`, `kind` (report or prep; docs only otherwise), and `status` is active to leave out archived ones. `kind: record` opens one.
6. What changed: `list_document_revisions` lists a page's history, newest first; `get_document_revision` shows one version and what that change did.

## Doing it well
Writing:
- `create_document` publishes at once: use it for a new page the person asked for. Give it a clear `title`, the `project_id` when it belongs to one (or a `team_id`), and real structure: a one-line purpose, headings, short paragraphs, decisions and open questions called out. The `write-a-document` skill walks drafting one from a meeting, a project or what's known.
- Lead with the point: a reader should know in two lines what the page is and what it asks of them. Specs get acceptance criteria, plans get owners and dates, notes get the decisions at the top.
- Write from the workspace's sources (meetings, decisions, the CRM, what's known) and cite them ("decided in the Oct 2 pricing call") rather than inventing.

Editing:
- Change the part, not the page. A change the person spelled out (fix this typo, add this line, drop that section), or any change to a page you just created, goes straight to the live page with a part tool:
  - `edit_document_content` replaces one exact passage: its `old_text` must appear exactly once (a miss or several matches is refused; quote more of the passage).
  - `edit_document_lines` replaces, inserts or deletes lines by number. It needs `base_revision`, the revision you read the numbers from.
  - `replace_section`, `append_to_section`, `remove_section` and `insert_section_after` work on one section by its heading; when two headings match, name the path ("Parent > Heading").
- `update_document` replaces the whole body and needs `base_revision`; it also sets the title, project or pin. Don't rewrite a whole page to change part of it.
- Every write is safe against someone else's edit: pass the `revision` you read as `base_revision`. If the page changed since and your change no longer fits, nothing is written and you get a conflict: read it again and redo the change on the new text. Each write returns the new `revision` and takes a `change_summary`, one line for the history.
- Your own wording on someone's page (a rewrite, a section you write) goes in as a draft: `propose_document_edit` with the whole new `content` and the `revision` you read as `base_revision` (read it first with `get_document`, apply your change, pass the full body). The live page doesn't change until the person publishes; tell them the draft is waiting on the document's page.
- `publish_draft` publishes the person's pending draft as a new revision, with an optional `change_summary`. Only when they ask to publish. If the page changed since the draft was made, it's refused: tell them, and pass `overwrite` only when they say so.
- Undo: `restore_document_revision` puts an earlier version back as a new revision, so the restore can be undone too. Only in a chat, when the person asks for it. Check what it would change first: `get_document_revision` with `compare_to: current`.
- Keep edits surgical in someone else's writing: change what was asked, keep their voice and structure, and say what you changed.

Linking to work:
- `link_document_to_action` attaches a page to an action (a spec to its ticket) with the action's `id` (look up an identifier like ENG-42 with `get_action` first); `unlink_document_from_action` removes the link. A page joins a project through `update_document` with `project_id` (an empty value unlinks it).
- Links written by an edit appear in backlinks once the page is published or saved in the editor; a live edit through these tools doesn't refresh them.
- When a page names work to do, offer to make the actions (`create_action`) and link them.

## Pitfalls
- Your drafts are the person's drafts. Nothing you can read shows whether they have unpublished edits there. Unless they just asked for this change, ask first: `propose_document_edit` replaces any unpublished draft of theirs on that page.
- After proposing, don't read the page back and conclude the edit failed: the change is in the draft.
- After a conflict, read the page again before you write. Never just retry with the newer revision: that would throw away what the other person wrote.
- Don't duplicate: `find` before creating, and extend the page that exists.
- These tools don't archive or delete a page: the person does that on the page.

## When to hand to a helper
If you have `helpers` (main chat only), split work across them where this playbook or the skill you're running says to; without them (a loop, or any run without that tool), do the work here.$pb$)
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
     WHERE id = 'e8d88dec-0326-41b0-971e-f974c21cdefb'::uuid
       AND slug = 'documents-playbook'
       AND is_system
  ) THEN
    RAISE EXCEPTION '368: the system documents playbook (e8d88dec-0326-41b0-971e-f974c21cdefb, documents-playbook) is not there';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.recipe
     WHERE id = 'e8d88dec-0326-41b0-971e-f974c21cdefb'::uuid
       AND system_prompt LIKE '%edit_document_lines%'
       AND system_prompt LIKE '%restore_document_revision%'
  ) THEN
    RAISE EXCEPTION '368: the documents playbook was not rewritten';
  END IF;
END
$guard$;
