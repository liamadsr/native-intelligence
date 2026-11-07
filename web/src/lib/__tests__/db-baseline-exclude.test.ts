/**
 * The baseline's exclusion filter (scripts/db-baseline-exclude.mjs): it cuts objects no
 * migration creates and no code uses from a pg_dump script, with everything that hangs off
 * them, and leaves every other byte alone.
 */
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEV_GAPS, excludeFromDump, functionIdentity, gapSql, splitStatements } from '../../../scripts/db-baseline-exclude.mjs'

const DUMP = `SET row_security = off;

CREATE TYPE "public"."workflow_category" AS ENUM (
    'backlog',
    'won',
    'lost'
);

CREATE OR REPLACE FUNCTION "public"."keep_me"("p_a" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  -- a ; and a 'quote' inside the body;
  RETURN 1;
END;
$$;

CREATE OR REPLACE FUNCTION "public"."drop_me"("p_rows" "jsonb", "p_user_id" "uuid" DEFAULT NULL::"uuid", "p_model" "text" DEFAULT 'x'::"text") RETURNS integer
    LANGUAGE "sql"
    AS $$ select 1 $$;

ALTER FUNCTION "public"."drop_me"("p_rows" "jsonb", "p_user_id" "uuid", "p_model" "text") OWNER TO "postgres";

CREATE TABLE IF NOT EXISTS "public"."widget" (
    "id" "uuid" NOT NULL,
    "kind" "text" DEFAULT 'a'::"text" NOT NULL,
    "name" "text" NOT NULL,
    CONSTRAINT "widget_kind_check" CHECK (("kind" = ANY (ARRAY['a'::"text", 'b'::"text"])))
);

CREATE TABLE IF NOT EXISTS "public"."gone" (
    "id" "uuid" NOT NULL
);

CREATE TABLE IF NOT EXISTS "public"."gone_child" (
    "id" "uuid" NOT NULL
);

ALTER TABLE ONLY "public"."widget"
    ADD CONSTRAINT "widget_kind_name_key" UNIQUE ("kind", "name");

ALTER TABLE ONLY "public"."gone_child"
    ADD CONSTRAINT "gone_child_fkey" FOREIGN KEY ("id") REFERENCES "public"."gone"("id");

CREATE INDEX "widget_name_idx" ON "public"."widget" USING "btree" ("name");

CREATE POLICY "gone_select" ON "public"."gone" FOR SELECT USING (true);

ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."gone";

GRANT ALL ON FUNCTION "public"."drop_me"("p_rows" "jsonb", "p_user_id" "uuid", "p_model" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."keep_me"("p_a" "uuid") TO "authenticated";
GRANT ALL ON TABLE "public"."gone" TO "anon";
`

const EX = {
  tables: ['gone'],
  columns: ['widget.kind'],
  functions: ['drop_me(jsonb,uuid,text)'],
  enumLabels: ['workflow_category.lost'],
  restore: ['ALTER TABLE ONLY "public"."widget" ADD CONSTRAINT "widget_name_key" UNIQUE ("name");'],
}

describe('db baseline exclusion filter', () => {
  it('splits statements without breaking bodies or strings, and joins back byte for byte', () => {
    const parts = splitStatements(DUMP)
    expect(parts.join('')).toBe(DUMP)
    expect(parts.find((p: string) => p.includes('keep_me') && p.includes('LANGUAGE'))).toContain('RETURN 1;\nEND;\n$$;')
  })

  it('reads a function identity the way the dump writes grants', () => {
    expect(functionIdentity('GRANT ALL ON FUNCTION "public"."drop_me"("p_rows" "jsonb", "p_user_id" "uuid" DEFAULT NULL::"uuid") TO x;')).toBe(
      'drop_me(jsonb,uuid)',
    )
    expect(functionIdentity('ALTER FUNCTION "public"."f"() OWNER TO "postgres";')).toBe('f()')
  })

  it('changes nothing with empty lists', () => {
    expect(excludeFromDump(DUMP, { tables: [], columns: [], functions: [], enumLabels: [], restore: [] }).sql).toBe(DUMP)
  })

  it('cuts the listed objects and what hangs off them, keeps the rest, restores the migrations', () => {
    const { sql, unused } = excludeFromDump(DUMP, EX)
    expect(unused).toEqual([])
    expect(sql).not.toMatch(/"public"\."gone"/)
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."gone_child"')
    expect(sql).not.toContain('gone_child_fkey')
    expect(sql).not.toContain('drop_me')
    expect(sql).toContain('GRANT ALL ON FUNCTION "public"."keep_me"')
    expect(sql).not.toMatch(/"kind"/)
    expect(sql).toContain('    "name" "text" NOT NULL\n);')
    expect(sql).toContain('widget_name_idx')
    expect(sql).not.toContain("'lost'")
    expect(sql).toContain("'won'\n);")
    expect(sql).toContain('ADD CONSTRAINT "widget_name_key" UNIQUE ("name");')
  })

  it('names the entries that matched nothing', () => {
    expect(excludeFromDump(DUMP, { ...EX, tables: ['gone', 'never_there'] }).unused).toEqual(['table never_there'])
  })

  it("takes only the picked part of a partial DEV gap, from the latest definition", () => {
    const dir = path.join(process.cwd(), 'supabase/migrations')
    const files = readdirSync(dir).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
    const read = (f: string) => readFileSync(path.join(dir, f), 'utf8')
    for (const gap of DEV_GAPS as Array<{ file: string; only?: RegExp }>) {
      expect(files).toContain(gap.file)
      const sql = gapSql(gap, read, files)
      if (gap.only) expect(sql.length).toBeLessThan(read(gap.file).length)
    }
    const voice = gapSql({ file: '237_explicit_requester_rpcs.sql', only: /replace_user_voice_profile/ }, read, files)
    expect(voice).toContain('DROP FUNCTION IF EXISTS public.replace_user_voice_profile(jsonb);')
    expect(voice).toContain('GRANT  EXECUTE ON FUNCTION public.replace_user_voice_profile(jsonb, uuid) TO authenticated, service_role;')
    expect(voice).not.toContain('_resolve_requester(p_user_id uuid)\nRETURNS')
    // 237 redefines 201's replace_user_voice_profile, so 201 isn't its latest: refused.
    expect(() => gapSql({ file: '201_user_voice_profile.sql', only: /replace_user_voice_profile/ }, read, files)).toThrow(/redefines/)
  })
})
