/**
 * Migration 480 (team chat record mentions): an additive, idempotent column,
 * capped like `mentions`, and 474's guard re-made with record_mentions beside
 * mentions: cleared by a delete, stamping edited_at when changed, every one of
 * 474's refusals kept. Pins the file's text (applied on DEV with the PR).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/480_team_chat_record_mentions.sql'), 'utf8')
const BODY = SQL.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const OLD = readFileSync(join(process.cwd(), 'supabase/migrations/474_team_chat.sql'), 'utf8')

function guardOf(sql: string): string {
  const start = sql.indexOf('create or replace function public.team_chat_message_guard(')
  expect(start).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}

describe('migration 480', () => {
  it('adds the column idempotently, an array of at most 50', () => {
    expect(BODY).toContain("add column if not exists record_mentions jsonb not null default '[]'::jsonb")
    expect(BODY).toContain('drop constraint if exists team_chat_message_record_mentions')
    expect(BODY).toContain("jsonb_typeof(record_mentions) = 'array' and jsonb_array_length(record_mentions) <= 50")
    expect(BODY).not.toContain('\\')
  })

  it('keeps every refusal of 474’s guard and handles record_mentions like mentions', () => {
    const guard = guardOf(BODY)
    for (const line of guardOf(OLD).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('or new.') || l.startsWith('raise exception'))) {
      expect(guard, line).toContain(line)
    }
    expect(guard).toContain("new.record_mentions := '[]'::jsonb;")
    expect(guard).toContain('or new.record_mentions is distinct from old.record_mentions then')
  })
})
