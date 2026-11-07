/**
 * The needle for a jsonb `@>` filter through supabase-js `.contains()`.
 *
 * postgrest-js encodes the value by its JavaScript shape
 * (`@supabase/postgrest-js` `contains(column, value)`): a string passes through
 * as-is, a plain object is JSON-encoded, and an ARRAY becomes a Postgres array
 * literal — `cs.{a,b}`. That literal is right for `text[]` / `uuid[]` columns
 * (`tags`, `prospect_list_ids`) and wrong for a jsonb column: an array of
 * objects turns into `cs.{[object Object]}`, PostgREST answers "invalid input
 * syntax for type json", and a caller that logs-and-continues silently matches
 * nothing. Passing the JSON text instead yields `cs.[{…}]`, jsonb containment.
 *
 * Use this for every jsonb `.contains()` whose needle is an array (a plain
 * object needle is already encoded correctly, but the helper is harmless there).
 */
export function jsonbNeedle(value: readonly unknown[] | Record<string, unknown>): string {
  return JSON.stringify(value)
}
