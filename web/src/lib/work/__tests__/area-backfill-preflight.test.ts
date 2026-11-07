/**
 * The work-area back-fill stops before writing anything when the database
 * lacks what migrations 316, 317 and 318 add (S3 review): each missing column,
 * and 318's area faces, is named with its migration; with all of them there
 * it may run. The script runs the preflight before its first step.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { areaBackfillPreflight } from '../area-backfill-preflight'

/** A client whose tables have the given columns (a select naming any other errors, as PostgREST does). */
function client(columns: Record<string, string[]>, captures = true) {
  return {
    from(table: string) {
      const chain = {
        _col: '',
        select(col: string) {
          chain._col = col
          return chain
        },
        eq() {
          return chain
        },
        async limit() {
          const has = columns[table]?.includes(chain._col) || (table === 'ai_team_member' && chain._col === 'id')
          if (!has) return { data: null, error: { message: `column ${table}.${chain._col} does not exist` } }
          return { data: table === 'ai_team_member' ? (captures ? [{ id: 'tm-captures' }] : []) : [], error: null }
        },
      }
      return chain
    },
  } as never
}

const ALL = { recipe: ['area'], area_memory: ['area'], tracked_job: ['area'], chat_conversations: ['focus_area'] }

describe('areaBackfillPreflight', () => {
  it('passes when 316, 317 and 318 are all in', async () => {
    expect(await areaBackfillPreflight(client(ALL))).toEqual([])
  })

  it('a database with none of them (PROD before the runbook) names all three migrations', async () => {
    const missing = (await areaBackfillPreflight(client({}, false))).map((m) => m.missing)
    expect(missing.some((m) => m.includes('recipe.area') && m.includes('316_skill_area_and_playbooks.sql'))).toBe(true)
    expect(missing.some((m) => m.includes('area_memory.area') && m.includes('317_area_memory.sql'))).toBe(true)
    expect(missing.some((m) => m.includes('tracked_job.area') && m.includes('318_area_faces.sql'))).toBe(true)
    expect(missing.some((m) => m.includes('chat_conversations.focus_area'))).toBe(true)
    expect(missing.some((m) => m.includes('the area faces'))).toBe(true)
  })

  it('318’s columns without its fold (no Captures teammate) still stops', async () => {
    const missing = await areaBackfillPreflight(client(ALL, false))
    expect(missing.map((m) => m.missing)).toEqual([expect.stringContaining('the area faces (apply 318_area_faces.sql')])
  })
})

describe('the back-fill script', () => {
  it('runs the preflight before its first step, and returns on a miss', () => {
    const src = readFileSync(join(process.cwd(), 'scripts/backfill-work-area.ts'), 'utf8')
    const main = src.slice(src.indexOf('async function main()'))
    const preflight = main.indexOf('await areaBackfillPreflight(supabase)')
    expect(preflight).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(main.indexOf('await stepKinds()'))
    expect(main.slice(preflight, main.indexOf('await stepKinds()'))).toContain('return')
  })
})
