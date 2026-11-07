-- Migration 256: one fit score, written by the full profile.
--
-- Discovery no longer scores a company. The old discovery-time tier (A–D), its
-- confidence grade and its per-criterion signals were a substring match over a
-- one-sentence blurb — measured on 2026-09-05 as noise on 16 of 21 recorded
-- candidates — and the tier gated which companies got the full profile, the
-- only step that could have produced the evidence the score needed. The
-- pipeline now matches Exa's own demo: discover, prune, profile what is left,
-- and score ONCE from the profile (the synthesis model's 0–100 `fitScore`,
-- read in the bands hot / warm / moderate / cold). See src/lib/prospecting/fit.ts.
--
-- Three columns go. `fit_score` and `fit_rationale` stay: the score is now the
-- profile's rating (NULL until a company is profiled), the rationale is
-- discovery's why-match sentence until the profile's why-fit replaces it.

ALTER TABLE public.prospect_list_entry
  DROP COLUMN IF EXISTS fit_tier,
  DROP COLUMN IF EXISTS fit_signals,
  DROP COLUMN IF EXISTS fit_confidence;

-- Existing scores were the rule engine's number and mean something different
-- from the profile's rating (a 43 there was a top company; a 43 here is
-- "moderate"), so they are cleared rather than re-read. Every such row shows
-- Enrich again; a re-profile is one deep search and returns a real score. The
-- rationale text is kept — it is the "why" a row shows before it has a score.
UPDATE public.prospect_list_entry
SET fit_score = NULL
WHERE fit_score IS NOT NULL;

-- Saved views cannot display, filter, group or sort on a column that no
-- longer exists. There are ~0 users, so they are moved rather than
-- grandfathered.
UPDATE public.view
SET display_properties = array_replace(array_remove(display_properties, 'fit_score'), 'fit_tier', 'fit_score')
WHERE entity_type = 'prospect_list_entry'
  AND display_properties @> ARRAY['fit_tier']::text[];

UPDATE public.view
SET display_properties = array_remove(display_properties, 'fit_confidence')
WHERE entity_type = 'prospect_list_entry'
  AND display_properties @> ARRAY['fit_confidence']::text[];

UPDATE public.view
SET board_group_by = 'stage'
WHERE entity_type = 'prospect_list_entry'
  AND board_group_by IN ('fit_tier', 'fit_confidence');

UPDATE public.view
SET grouping = NULL
WHERE entity_type = 'prospect_list_entry'
  AND grouping->>'field' IN ('fit_tier', 'fit_confidence');

UPDATE public.view
SET sub_grouping = NULL
WHERE entity_type = 'prospect_list_entry'
  AND sub_grouping->>'field' IN ('fit_tier', 'fit_confidence');

UPDATE public.view
SET filters = COALESCE(
  (SELECT jsonb_agg(f) FROM jsonb_array_elements(filters) AS f
    WHERE NOT (f->>'field' IN ('fit_tier', 'fit_confidence'))),
  '[]'::jsonb)
WHERE entity_type = 'prospect_list_entry'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(filters) AS f
              WHERE f->>'field' IN ('fit_tier', 'fit_confidence'));

-- Hottest first is the point of the score, so every prospect view opens on it
-- (unscored rows sink to the bottom: the query engine orders NULLS LAST).
UPDATE public.view
SET ordering = '[{"field":"fit_score","direction":"desc"},{"field":"created_at","direction":"desc"}]'::jsonb
WHERE entity_type = 'prospect_list_entry';
