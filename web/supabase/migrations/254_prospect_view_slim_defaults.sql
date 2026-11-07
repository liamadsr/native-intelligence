-- Migration 254: existing prospect views go slim.
--
-- The prospect list row was redesigned to read "favicon · name · grade" with
-- the rationale, signals, employee range, confidence and citation moved into
-- the details side panel. That strip now hangs off the "Why" display property
-- (fit_rationale), and DEFAULT_DISPLAY_PROPERTIES.prospect_list_entry became
-- {fit_tier, stage} (src/lib/views/types.ts). New views pick that up; views
-- already saved carry the OLD default ({fit_tier, fit_rationale, stage, kind})
-- and would keep rendering the wide row forever. There are ~0 users and the
-- wide row is one picker tick away, so existing prospect views are moved to
-- the new default rather than grandfathered.
UPDATE public.view
SET display_properties = array_remove(array_remove(display_properties, 'fit_rationale'), 'kind')
WHERE entity_type = 'prospect_list_entry'
  AND (display_properties @> ARRAY['fit_rationale']::text[] OR display_properties @> ARRAY['kind']::text[]);
