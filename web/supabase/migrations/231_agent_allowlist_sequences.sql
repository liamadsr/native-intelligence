-- 231_agent_allowlist_sequences.sql
--
-- Agent tool allowlists (recipe.agent_config->enabled_tools) snapshot the
-- category universe as of when they were saved — an agent configured before
-- the 'sequences' category existed is permanently blind to every sequences
-- tool, even though an inherit-all agent (no allowlist) picks new categories
-- up automatically. Observed live: the Sales Copilot persona — the one agent
-- that plainly SHOULD run outreach — could not see create_sequence.
--
-- Product rule this encodes: NEW tool categories default ON for existing
-- agents, keeping pinned-allowlist agents at parity with inherit-all ones;
-- owners can still disable the category in the agent editor. Any future
-- category addition needs the same one-line backfill.

UPDATE public.recipe
SET agent_config = jsonb_set(
  agent_config,
  '{enabled_tools}',
  (agent_config -> 'enabled_tools') || '"sequences"'::jsonb
)
WHERE category = 'agent'
  AND agent_config ? 'enabled_tools'
  AND jsonb_typeof(agent_config -> 'enabled_tools') = 'array'
  AND NOT (agent_config -> 'enabled_tools') @> '"sequences"'::jsonb;
