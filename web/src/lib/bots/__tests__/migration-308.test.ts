/**
 * Migration 308 (bots-v4 B2) and the app agree: a bot's voice is a nullable
 * column (null = Automatic) holding a voice id in the desktop catalogue's
 * shape, the same shape the routes check (voice-id.ts), and it is NOT one of
 * the limits columns migration 305 keeps to owners, admins and the server: a
 * team lead sets a bot's voice as they set its face. The SQL was applied to
 * DEV and probed there inside rolled-back blocks (a team lead's voice change
 * through the client passed the 305 trigger; a bad shape was refused by the
 * CHECK); this pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { VOICE_ERROR, VOICE_ID_PATTERN, asVoiceId, isVoiceId, parseVoice } from '../voice-id'

const migration = (file: string) => readFileSync(resolve(__dirname, '../../../../supabase/migrations', file), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')

const BODY = statements(migration('308_bot_voice.sql'))
/** Migration 305's guard function's body, alone. */
const GUARD_305 = /create or replace function public\.ai_team_member_guard_limits\(\).*?\$\$(.*?)\$\$;/.exec(statements(migration('305_teammate_limits_and_skills_guard.sql')))?.[1] ?? ''

/** The voices the desktop's catalogue lists today (dial8-desktop, local-tts voices.json). */
const DESKTOP_VOICES = ['aba', 'cha', 'ush', 'chichi', 'lori', 'lowli', 'tana', 'milton']

describe('migration 308', () => {
  it('adds a nullable text column, again and again without harm', () => {
    expect(BODY).toContain('alter table public.ai_team_member add column if not exists voice text null;')
  })

  it('holds the voice to the same shape the routes check, null for Automatic', () => {
    const check = /add constraint ai_team_member_voice_check check \(voice is null or voice ~ '([^']*)'\);/.exec(BODY)?.[1]
    expect(check).toBe(VOICE_ID_PATTERN.source)
    // Dropped by name first, so a second run re-adds it rather than failing.
    expect(BODY.indexOf('drop constraint if exists ai_team_member_voice_check')).toBeLessThan(BODY.indexOf('add constraint ai_team_member_voice_check'))
    expect(BODY).toContain('comment on column public.ai_team_member.voice is')
  })

  it('is no limits column: it leaves migration 305’s guard alone, and the guard never names it', () => {
    expect(GUARD_305).not.toBe('')
    expect(GUARD_305).not.toMatch(/\bvoice\b/)
    expect(BODY).not.toMatch(/create (or replace )?(function|trigger)/)
    expect(BODY).not.toMatch(/ai_team_member_guard_limits/)
    expect(BODY).not.toMatch(/\b(policy|grant|revoke)\b/)
  })

  it('touches no row: additive only', () => {
    expect(BODY).not.toMatch(/\b(update|delete from|insert into)\b/)
  })
})

describe('a voice id (voice-id.ts)', () => {
  it('takes every voice the desktop lists today', () => {
    for (const id of DESKTOP_VOICES) {
      expect(isVoiceId(id), id).toBe(true)
      expect(parseVoice(id)).toEqual({ ok: true, voice: id })
    }
  })

  it('is the catalogue’s shape: lowercase letters, digits and hyphens, a letter or digit first, at most 32', () => {
    for (const id of ['a', '7', 'x-1', 'voice-2026-10', 'a'.repeat(32)]) expect(isVoiceId(id), id).toBe(true)
    for (const id of ['', 'Aba', '-aba', 'a b', 'a_b', 'aba\n', 'a'.repeat(33), 'tana;drop', 'émile']) expect(isVoiceId(id), JSON.stringify(id)).toBe(false)
  })

  it('a request: one voice id, or null for Automatic; anything else is refused', () => {
    expect(parseVoice(null)).toEqual({ ok: true, voice: null })
    for (const bad of ['', 'Tana', 42, true, {}, ['aba'], undefined]) {
      expect(parseVoice(bad), JSON.stringify(bad)).toEqual({ ok: false, error: VOICE_ERROR })
    }
  })

  it('a stored value that isn’t one reads as Automatic', () => {
    expect(asVoiceId('lori')).toBe('lori')
    for (const bad of [null, undefined, '', 'Lori', 7]) expect(asVoiceId(bad)).toBeNull()
  })
})
