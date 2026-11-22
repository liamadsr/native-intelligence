import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROJECT_PRIORITIES, isProjectPriority, parseProjectPriority } from '../priority'
import { PRIORITY_OPTIONS } from '@/lib/views/property-options'

describe('a project’s priority', () => {
  it('is the actions’ five values', () => {
    expect([...PROJECT_PRIORITIES].sort()).toEqual(PRIORITY_OPTIONS.map((o) => o.value).sort())
  })

  // Cleared is stored as 'none', not null: production's column is NOT NULL
  // (default 'none'), so a null write would be refused there.
  it('parses a request: absent, cleared (as none), a value, or invalid', () => {
    expect(parseProjectPriority(undefined)).toBeUndefined()
    expect(parseProjectPriority(null)).toBe('none')
    expect(parseProjectPriority('')).toBe('none')
    expect(parseProjectPriority('none')).toBe('none')
    expect(parseProjectPriority('urgent')).toBe('urgent')
    expect(parseProjectPriority('Urgent')).toBe('invalid')
    expect(parseProjectPriority(2)).toBe('invalid')
    expect(isProjectPriority('none')).toBe(true)
  })
})

// supabase/tests/691_project_priority.sql runs the SQL; this pins the file's text.
describe('migration 691', () => {
  const raw = readFileSync(join(process.cwd(), 'supabase/migrations/691_project_priority.sql'), 'utf8')
  const sql = raw.replace(/--[^\n]*/g, '')

  it('carries its own transaction, once, and no backslash', () => {
    expect(sql.match(/^\s*begin\s*;/gim)).toHaveLength(1)
    expect(sql.match(/^\s*commit\s*;/gim)).toHaveLength(1)
    expect(sql.trim().endsWith('commit;')).toBe(true)
    expect(raw).not.toContain('\\')
  })

  it('adds the column only where it is missing, and checks the same five values the app sends', () => {
    expect(sql).toMatch(/add column if not exists priority text;/)
    const check = sql.match(/check \(priority is null or priority in \(([^)]*)\)\)/)?.[1] ?? ''
    expect([...check.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort()).toEqual([...PROJECT_PRIORITIES].sort())
  })

  it('touches no policy, trigger or function', () => {
    expect(sql).not.toMatch(/\b(create|drop|alter)\s+(policy|trigger|function)\b/i)
    expect(sql).not.toMatch(/create or replace/i)
  })
})
