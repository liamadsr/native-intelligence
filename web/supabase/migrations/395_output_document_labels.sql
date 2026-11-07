-- 395: a loop's output document is labelled with its title (Liam, 2026-10-20).
--
-- A loop fire that wrote a document stored the deliverable as "Output
-- document" (src/lib/work/flow-results.ts), and the For you card and the card
-- it opens say that label: "Open “Output document”" for a Morning Brief. Fires
-- now store the document's title. This relabels the rows written before, from
-- the document's current title; a document with no title, or gone, keeps the
-- old label. Data only and idempotent; no code depends on it, so it is not a
-- merge gate.

update public.tracked_job t
set deliverables = (
  select jsonb_agg(
           case
             when e.d->>'type' = 'document'
              and e.d->>'label' = 'Output document'
              and nullif(btrim(doc.title), '') is not null
             then jsonb_set(e.d, '{label}', to_jsonb(regexp_replace(btrim(doc.title), '\s+', ' ', 'g')))
             else e.d
           end
           order by e.ord
         )
  from jsonb_array_elements(t.deliverables) with ordinality as e(d, ord)
  left join public.document doc on doc.id::text = e.d->>'id'
)
where t.deliverables @> '[{"type":"document","label":"Output document"}]';
