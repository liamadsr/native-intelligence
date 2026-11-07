/**
 * Migration 360: the workspace product doc can't be moved away by a plain
 * member. Pins: no backslash; create or replace only; move_document and
 * move_project are 221's bodies EXACTLY plus one product-doc check each
 * (placed right after _wsmove_gate, raising 42501), with the same
 * signatures, definer, search_path and grants.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const SQL = read('360_document_move_product_doc.sql')
const SQL_221 = read('221_workspace_move_engine.sql')

/** A function's full text, from its create line to the closing `$$;`. */
const fnText = (sql: string, name: string) => {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`)
  return sql.slice(start, sql.indexOf('\n$$;', start) + 4)
}

const GATE = '  PERFORM public._wsmove_gate(\n    v_user_id, v_source, p_destination_workspace_id, COALESCE(v_owns, false));\n'

/** The block 360 added right after the gate (up to the first line after its END IF;). */
const addedBlock = (body: string) => {
  const at = body.indexOf(GATE) + GATE.length
  const end = body.indexOf('  END IF;\n', at) + '  END IF;\n'.length
  return body.slice(at, end)
}

describe('migration 360', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('only creates or replaces; drops nothing', () => {
    expect(SQL).not.toMatch(/^\s*CREATE FUNCTION /im)
    expect(SQL).not.toMatch(/DROP /i)
    expect(SQL.match(/CREATE OR REPLACE FUNCTION/g)).toHaveLength(2)
  })

  for (const name of ['move_document', 'move_project']) {
    it(`${name} is 221's body exactly, plus one check after the gate`, () => {
      const body = fnText(SQL, name)
      const original = fnText(SQL_221, name)
      expect(original.length).toBeGreaterThan(1000)
      const block = addedBlock(body)
      expect(block).toContain("USING ERRCODE = '42501'")
      expect(block).toContain("NOT IN ('owner', 'admin')")
      expect(body.replace(block, '')).toBe(original)
    })
  }

  it('move_document refuses a non-admin on the product doc', () => {
    const block = addedBlock(fnText(SQL, 'move_document'))
    expect(block).toContain('WHERE m.workspace_id = v_source AND m.user_id = v_user_id')
    expect(block).toContain('AND public.is_product_doc(v_source, p_document_id) THEN')
  })

  it('move_project refuses a non-admin when its documents move and one is the product doc', () => {
    const block = addedBlock(fnText(SQL, 'move_project'))
    expect(block).toContain('IF p_move_documents')
    expect(block).toContain('WHERE m.workspace_id = v_source AND m.user_id = v_user_id')
    expect(block.replace(/\s+/g, ' ')).toContain(
      'AND EXISTS ( SELECT 1 FROM public.document d WHERE d.project_id = p_project_id AND d.workspace_id = v_source AND public.is_product_doc(d.workspace_id, d.id) ) THEN',
    )
  })

  it('signatures, definer, search_path and grants are unchanged', () => {
    for (const sig of ['public.move_document(uuid, uuid, boolean)', 'public.move_project(uuid, uuid, uuid, boolean)']) {
      const grants = [`REVOKE ALL ON FUNCTION ${sig} FROM PUBLIC, anon;`, `GRANT EXECUTE ON FUNCTION ${sig} TO authenticated;`]
      for (const g of grants) {
        expect(SQL_221).toContain(g)
        expect(SQL).toContain(g)
      }
    }
    expect(fnText(SQL, 'move_document')).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp')
    expect(fnText(SQL, 'move_project')).toContain('LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp')
  })

  it('no migration between 221 and 360 redefines either function', () => {
    // 360 must re-create the CURRENT bodies: 221's are the only ones before it.
    const between = readdirSync(join(process.cwd(), 'supabase/migrations')).filter((f) => {
      const n = Number.parseInt(f, 10)
      return f.endsWith('.sql') && n > 221 && n < 360
    })
    expect(between.length).toBeGreaterThan(100)
    for (const f of between) {
      expect(read(f), f).not.toMatch(/FUNCTION\s+public\.move_(document|project)\(/i)
    }
  })

  it('the header says why, what changes, and how it is applied', () => {
    expect(SQL).toMatch(/applied to DEV and then PROD BEFORE the app PR merges, after 359/)
  })
})
