-- ============================================================
-- 361: the flows playbook stops saying agents have faces. Seed text only.
-- ============================================================
-- Persona removal (PRs #751 to #753) took the faces away: the app draws none,
-- and every agent wears the one agent icon. The seeded flows-playbook
-- (324_workflows_skill.sql, rewritten by 338_skill_helper_lines.sql) still
-- tells the model that `bot_character` "picks one by its face".
--
-- `bot_character` is still a real create_flow / update_flow field
-- (src/lib/ai/tools/flows.ts, resolved by src/lib/flows/flow-bot.ts): a
-- character id. A teammate the editor can reach that already holds that id
-- fronts the loop; otherwise a new work agent is made holding it, named after
-- the character unless `bot_name` says otherwise. So the clause stays and
-- says that, without faces.
--
-- One sentence, replaced whole by exact replace(), in every wording a row can
-- hold today:
--   PROD before 357   "Every loop has a bot, ..."   (338)
--   DEV before 357    "Every loop has a bird, ..."  (338, then the unmerged 350)
--   after 357         "Every loop has an agent, ..." (357_agent_not_bot.sql)
-- All three end on the same new sentence. The rest of the playbook is
-- untouched (a row that never got 357 keeps 357's other two lines for 357).
--
-- Same row and column as 357: public.recipe.system_prompt, by id and slug,
-- system row only.
--
-- Applied by hand, from this file: to DEV, then to PROD on the owner's word.
-- Without it the playbook keeps the stale clause; nothing else changes.
--
-- Idempotent: the UPDATE is fenced on an old sentence being present, and the
-- new sentence contains none of them, so a second run changes nothing. This
-- file holds no backslash anywhere: one MCP transport decodes escapes, so the
-- applied SQL would differ from the file.
-- ============================================================

-- SET LOCAL holds for the transaction MCP apply_migration wraps this file in.
SET LOCAL lock_timeout = '5s';

UPDATE public.recipe
SET system_prompt =
      replace(replace(replace(system_prompt,
        'Every loop has a bot, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.',
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its character id (a teammate already holding it, or else a new agent named after the character), or leave it out for the default.'),
        'Every loop has a bird, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.',
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its character id (a teammate already holding it, or else a new agent named after the character), or leave it out for the default.'),
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.',
        'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its character id (a teammate already holding it, or else a new agent named after the character), or leave it out for the default.'),
    updated_at = now()
WHERE id = '1ef0c12f-5d78-41ef-ab12-714512fa03cd'::uuid
  AND slug = 'flows-playbook'
  AND is_system
  AND (strpos(system_prompt, 'Every loop has a bot, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.') > 0
       OR strpos(system_prompt, 'Every loop has a bird, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.') > 0
       OR strpos(system_prompt, 'Every loop has an agent, the teammate who tells the person about its runs: `bot_character` picks one by its face, or leave it out for the default.') > 0);
