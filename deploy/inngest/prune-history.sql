-- Deletes the history of Inngest runs that finished more than :days days ago.
-- Run through prune-history.sh, which passes :days, :batch and :apply.
--
-- The rules are the Inngest server's own (docs/POSTGRES_RETENTION.md in
-- inngest/inngest, read at v1.51.0 and checked against that version's schema):
--
--   * A run's rows go only when the run has ENDED and ended before the cutoff.
--     Age alone is never enough: a run can sleep or wait for months, and its
--     state in Redis still points at these rows.
--   * Two tables say a run has ended, and each child table shares the run id
--     encoding of one of them:
--       trace_runs         (status is a terminal code)  -> spans, traces,
--                                                          event_batches
--       function_finishes  (a row exists once finished) -> history,
--                                                          function_runs
--   * Children are deleted before the row that proves the run ended.
--   * An event goes by its own age, unless a run that is being kept was
--     started by it.
--
-- Where that guide repeats one DELETE ... LIMIT until it finds nothing, this
-- walks the list of ended runs once, :batch runs per transaction, so the work
-- stays proportional to what is deleted and no index has to be added to
-- Inngest's tables.

\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
SET TIME ZONE 'UTC';
SET client_min_messages = warning;

CREATE TEMP TABLE prune_cutoff AS
SELECT
	now() - make_interval(days => :days) AS at,
	(extract(epoch FROM now()) * 1000)::bigint - :days::bigint * 86400000 AS at_ms;

-- Ended runs, by the tracing tables. Terminal status codes, from
-- pkg/enums/run_status.go: 50 overflowed, 300 completed, 400 failed,
-- 500 cancelled, 600 skipped. (100 scheduled and 200 running are kept, and
-- ended_at means nothing until the status is terminal.)
CREATE TEMP TABLE doomed_trace_runs AS
SELECT row_number() OVER () AS n, t.run_id::text AS run_id
FROM trace_runs t, prune_cutoff c
WHERE t.status IN (50, 300, 400, 500, 600)
	AND t.ended_at < c.at_ms;
CREATE UNIQUE INDEX ON doomed_trace_runs (n);
CREATE INDEX ON doomed_trace_runs (run_id);

-- Ended runs, by the history tables.
CREATE TEMP TABLE doomed_finishes AS
SELECT row_number() OVER () AS n, run_id
FROM (
	SELECT DISTINCT f.run_id
	FROM function_finishes f, prune_cutoff c
	WHERE f.run_id IS NOT NULL
		AND f.created_at < c.at
) finished;
CREATE UNIQUE INDEX ON doomed_finishes (n);
CREATE INDEX ON doomed_finishes (run_id);

ANALYZE doomed_trace_runs;
ANALYZE doomed_finishes;

\echo
\echo 'Cutoff (UTC):'
SELECT '  ' || to_char(at, 'YYYY-MM-DD HH24:MI:SS') FROM prune_cutoff;
\echo
\echo 'Rows past the cutoff / rows in the table:'
SELECT format('  %-18s %10s / %s', name, doomed, total)
FROM (
	SELECT 1 AS n, 'spans' AS name,
		(SELECT count(*) FROM spans s JOIN doomed_trace_runs d ON d.run_id = s.run_id) AS doomed,
		(SELECT count(*) FROM spans) AS total
	UNION ALL
	SELECT 2, 'traces',
		(SELECT count(*) FROM traces s JOIN doomed_trace_runs d ON d.run_id::bpchar = s.run_id),
		(SELECT count(*) FROM traces)
	UNION ALL
	SELECT 3, 'event_batches',
		(SELECT count(*) FROM event_batches s JOIN doomed_trace_runs d ON d.run_id::bpchar = s.run_id),
		(SELECT count(*) FROM event_batches)
	UNION ALL
	SELECT 4, 'trace_runs', (SELECT count(*) FROM doomed_trace_runs), (SELECT count(*) FROM trace_runs)
	UNION ALL
	SELECT 5, 'history',
		(SELECT count(*) FROM history s JOIN doomed_finishes d ON d.run_id = s.run_id),
		(SELECT count(*) FROM history)
	UNION ALL
	SELECT 6, 'function_runs',
		(SELECT count(*) FROM function_runs s JOIN doomed_finishes d ON d.run_id = s.run_id),
		(SELECT count(*) FROM function_runs)
	UNION ALL
	SELECT 7, 'function_finishes',
		(SELECT count(*) FROM function_finishes s JOIN doomed_finishes d ON d.run_id = s.run_id),
		(SELECT count(*) FROM function_finishes)
	UNION ALL
	-- Old events that no kept run was started by. A kept run is one that has
	-- not finished, or finished inside the window.
	SELECT 8, 'events',
		(SELECT count(*) FROM events e, prune_cutoff c
			WHERE e.received_at < c.at
				AND NOT EXISTS (
					SELECT 1 FROM function_runs fr
					WHERE fr.event_id = e.internal_id
						AND NOT EXISTS (SELECT 1 FROM doomed_finishes d WHERE d.run_id = fr.run_id))),
		(SELECT count(*) FROM events)
) counts
ORDER BY n;
\echo
\echo 'Runs kept whatever their age, because they have not ended:'
SELECT format('  %s by trace_runs, %s by function_finishes',
	(SELECT count(*) FROM trace_runs WHERE status NOT IN (50, 300, 400, 500, 600)),
	(SELECT count(*) FROM function_runs fr
		WHERE NOT EXISTS (SELECT 1 FROM function_finishes ff WHERE ff.run_id = fr.run_id)));
\echo
-- The server also writes one `traces` row per received event and per cron
-- tick under an all-zero run id. No run ends for them, the retention guide
-- does not mention them, and this script leaves them alone. The count is
-- printed so their growth is seen (an open item in ../README.md).
\echo 'Never pruned: trace rows that belong to no run (one per event and cron tick):'
SELECT format('  %s rows, %s', count(*), pg_size_pretty(coalesce(sum(pg_column_size(t.*)), 0)))
FROM traces t
WHERE t.run_id = '00000000000000000000000000';
\echo

\if :apply
\else
	\echo 'Dry run: nothing was deleted. Pass --apply to delete.'
	\quit
\endif

CREATE TEMP TABLE prune_result (n serial, name text, deleted bigint);

-- spans, then the trace_runs row that proved the run ended.
CREATE PROCEDURE pg_temp.prune_traced_runs(chunk int)
LANGUAGE plpgsql
AS $$
DECLARE
	last bigint;
	lo bigint := 1;
	c bigint;
	n_spans bigint := 0;
	n_runs bigint := 0;
BEGIN
	SELECT coalesce(max(n), 0) INTO last FROM doomed_trace_runs;
	WHILE lo <= last LOOP
		DELETE FROM spans s USING doomed_trace_runs d
		WHERE d.n >= lo AND d.n < lo + chunk AND s.run_id = d.run_id;
		GET DIAGNOSTICS c = ROW_COUNT;
		n_spans := n_spans + c;

		-- The status is checked again on the row itself.
		DELETE FROM trace_runs t USING doomed_trace_runs d
		WHERE d.n >= lo AND d.n < lo + chunk AND t.run_id = d.run_id::bpchar
			AND t.status IN (50, 300, 400, 500, 600);
		GET DIAGNOSTICS c = ROW_COUNT;
		n_runs := n_runs + c;

		COMMIT;
		lo := lo + chunk;
	END LOOP;
	INSERT INTO prune_result (name, deleted) VALUES ('spans', n_spans), ('trace_runs', n_runs);
END
$$;

-- history and function_runs, then the function_finishes row.
CREATE PROCEDURE pg_temp.prune_finished_runs(chunk int)
LANGUAGE plpgsql
AS $$
DECLARE
	last bigint;
	lo bigint := 1;
	c bigint;
	n_history bigint := 0;
	n_runs bigint := 0;
	n_finishes bigint := 0;
BEGIN
	SELECT coalesce(max(n), 0) INTO last FROM doomed_finishes;
	WHILE lo <= last LOOP
		DELETE FROM history h USING doomed_finishes d
		WHERE d.n >= lo AND d.n < lo + chunk AND h.run_id = d.run_id;
		GET DIAGNOSTICS c = ROW_COUNT;
		n_history := n_history + c;

		DELETE FROM function_runs r USING doomed_finishes d
		WHERE d.n >= lo AND d.n < lo + chunk AND r.run_id = d.run_id;
		GET DIAGNOSTICS c = ROW_COUNT;
		n_runs := n_runs + c;

		DELETE FROM function_finishes f USING doomed_finishes d
		WHERE d.n >= lo AND d.n < lo + chunk AND f.run_id = d.run_id;
		GET DIAGNOSTICS c = ROW_COUNT;
		n_finishes := n_finishes + c;

		COMMIT;
		lo := lo + chunk;
	END LOOP;
	INSERT INTO prune_result (name, deleted)
	VALUES ('history', n_history), ('function_runs', n_runs), ('function_finishes', n_finishes);
END
$$;

-- These two have no index on run_id, so each is one pass, not a loop.
WITH gone AS (
	DELETE FROM traces t USING doomed_trace_runs d WHERE t.run_id = d.run_id::bpchar RETURNING 1
)
INSERT INTO prune_result (name, deleted) SELECT 'traces', count(*) FROM gone;

WITH gone AS (
	DELETE FROM event_batches b USING doomed_trace_runs d WHERE b.run_id = d.run_id::bpchar RETURNING 1
)
INSERT INTO prune_result (name, deleted) SELECT 'event_batches', count(*) FROM gone;

CALL pg_temp.prune_traced_runs(:batch);
CALL pg_temp.prune_finished_runs(:batch);

-- Last, once the finished runs' function_runs rows are gone: an old event
-- stays if any run that still has a function_runs row was started by it.
WITH gone AS (
	DELETE FROM events e USING prune_cutoff c
	WHERE e.received_at < c.at
		AND NOT EXISTS (SELECT 1 FROM function_runs fr WHERE fr.event_id = e.internal_id)
	RETURNING 1
)
INSERT INTO prune_result (name, deleted) SELECT 'events', count(*) FROM gone;

\echo 'Deleted:'
SELECT format('  %-18s %10s', name, deleted) FROM prune_result ORDER BY n;
\echo

VACUUM (ANALYZE) spans, traces, event_batches, trace_runs, history, function_runs, function_finishes, events;
\echo 'Done. Table statistics refreshed.'
