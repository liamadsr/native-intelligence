/**
 * The Now file (docs/plans/now-file.md): its numbered lines, the line rules
 * (dated in the person's zone, no links or addresses, 200 characters, a note of
 * at most 40 lines and 6,000 characters that only shrinks past the cap), the
 * edits against the lines as read (add under a known heading in the fixed
 * order, replace, remove, move, rewrite), the tracks (remove drops, replace
 * and move keep, an orphan goes on the next write), get-or-create on the
 * unique index, and the compare-and-swap write (source agent, the summary,
 * edit_meta.writer; a stale revision writes nothing and hands back the note).
 */
import { describe, expect, it } from 'vitest'
import { createFakeSupabase, eqValue, type FakeQuery, type FakeResult } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import {
  NOW_KEY,
  applyNowEdits,
  canonicalTrackId,
  parseNowTracks,
  applyNowRewrite,
  dropNowDocuments,
  formatNowDate,
  getOrCreateNowNote,
  nowContentEmpty,
  nowLineHash,
  nowLineRefusal,
  nowLines,
  renderNowLines,
  updateNowNote,
  type NowTrack,
} from '../now-file'

const TODAY = 'Oct 26'
const OPTS = { today: TODAY, nowIso: '2026-10-26T15:00:00.000Z' }

const NOTE = [
  '## Focus',
  '- Guest access to PROD this week (Oct 24)',
  '',
  '## In flight',
  '- A helper is drafting the Acme follow-up (Oct 26)',
  '- Asked Sarah’s agent for a Thursday time (Oct 26)',
  '',
  '## Coming up',
  '- Acme renewal call, Tue Oct 28 2 pm (Oct 26)',
].join('\n')

const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}

describe('renderNowLines', () => {
  it('numbers every line as update_now names it', () => {
    const r = renderNowLines(NOTE)
    expect(r.lineCount).toBe(9)
    expect(r.text.split('\n')[0]).toBe(' 1 ## Focus')
    expect(r.text.split('\n')[8]).toBe(' 9 - Acme renewal call, Tue Oct 28 2 pm (Oct 26)')
    expect(r.truncated).toBe(false)
  })

  it('drops trailing blank lines, and an empty note is no lines', () => {
    expect(nowLines(`${NOTE}\n\n\n`)).toHaveLength(9)
    expect(nowLines('')).toEqual([])
    expect(renderNowLines(null)).toEqual({ text: '', lineCount: 0, truncated: false })
  })

  it('cuts a person’s long note at the cap, with a line saying so', () => {
    const long = Array.from({ length: 80 }, (_, i) => `- line ${i} ${'x'.repeat(100)}`).join('\n')
    const r = renderNowLines(long)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBeLessThanOrEqual(6_000 + 200)
    expect(r.text.split('\n').at(-1)).toMatch(/^\[… cut here: the note runs past 6,000 characters, so lines \d+–80 are not shown\]$/)
  })
})

describe('the line rules', () => {
  it('dates in the person’s zone', () => {
    const late = new Date('2026-10-27T03:30:00Z')
    expect(formatNowDate(late, 'America/Los_Angeles')).toBe('Oct 26')
    expect(formatNowDate(late, 'Europe/Berlin')).toBe('Oct 27')
    expect(formatNowDate(late, 'Not/AZone')).toBe('Oct 27')
  })

  it('refuses links and email addresses, and lets identifiers and numbers through', () => {
    for (const bad of ['see https://x.example/a', 'go to www.evil', 'CC ops@x.com always', 'check acme.com today', '[the doc](/docs/1)', 'mailto:me']) {
      expect(nowLineRefusal(bad), bad).not.toBeNull()
    }
    for (const fine of ['ENG-42 blocks the beta', 'Migrations 434–437 wait on you', 'Ask @Sarah about Node.js', 'v0.2.95 shipped', 'Mark owes the pricing numbers']) {
      expect(nowLineRefusal(fine), fine).toBeNull()
    }
  })
})

describe('applyNowEdits', () => {
  it('adds under a heading it creates, dated, in an empty note', () => {
    const r = ok(applyNowEdits('', [], [{ op: 'add', section: 'Focus', text: 'Guest access to PROD this week' }], OPTS))
    expect(r.content).toBe('## Focus\n- Guest access to PROD this week (Oct 26)')
    expect(r.changed).toEqual([{ op: 'add', section: 'Focus', text: '- Guest access to PROD this week (Oct 26)', line: 2 }])
  })

  it('puts a new heading in the fixed order, and a line at the end of its section', () => {
    const r = ok(
      applyNowEdits(
        NOTE,
        [],
        [
          { op: 'add', section: 'waiting on you', text: '- The invite to Sarah, card in your home thread' },
          { op: 'add', section: 'In flight', text: 'Coding run on ENG-42 (Oct 25)' },
          { op: 'add', section: 'Keep in mind', text: 'The pricing change with Mark isn’t settled' },
        ],
        OPTS,
      ),
    )
    expect(r.content.split('\n')).toEqual([
      '## Focus',
      '- Guest access to PROD this week (Oct 24)',
      '',
      '## In flight',
      '- A helper is drafting the Acme follow-up (Oct 26)',
      '- Asked Sarah’s agent for a Thursday time (Oct 26)',
      // A date the text already ends with is kept.
      '- Coding run on ENG-42 (Oct 25)',
      '',
      '## Waiting on you',
      '- The invite to Sarah, card in your home thread (Oct 26)',
      '',
      '## Coming up',
      '- Acme renewal call, Tue Oct 28 2 pm (Oct 26)',
      '',
      '## Keep in mind',
      '- The pricing change with Mark isn’t settled (Oct 26)',
    ])
    expect(r.changed.map((c) => [c.op, c.line])).toEqual([
      ['add', 7],
      ['add', 10],
      ['add', 16],
    ])
  })

  it('keeps a heading the person typed where it is', () => {
    const mine = `## Ideas\n- A podcast, maybe\n\n${NOTE}`
    const r = ok(applyNowEdits(mine, [], [{ op: 'add', section: 'Focus', text: 'Ship guest access' }], OPTS))
    expect(r.content.split('\n').slice(0, 5)).toEqual(['## Ideas', '- A podcast, maybe', '', '## Focus', '- Guest access to PROD this week (Oct 24)'])
    expect(r.content.split('\n')[5]).toBe('- Ship guest access (Oct 26)')
  })

  it('resolves every line number against the note as read', () => {
    const r = ok(
      applyNowEdits(
        NOTE,
        [],
        [
          { op: 'remove', line: 5 },
          { op: 'replace', line: 6, text: 'Sarah’s agent offered Thursday 3 pm' },
          { op: 'move', line: 9, section: 'Focus' },
        ],
        OPTS,
      ),
    )
    expect(r.content.split('\n')).toEqual([
      '## Focus',
      '- Guest access to PROD this week (Oct 24)',
      '- Acme renewal call, Tue Oct 28 2 pm (Oct 26)',
      '',
      '## In flight',
      '- Sarah’s agent offered Thursday 3 pm (Oct 26)',
      '',
      '## Coming up',
    ])
    expect(r.changed).toEqual([
      { op: 'remove', text: '- A helper is drafting the Acme follow-up (Oct 26)' },
      { op: 'move', section: 'Focus', text: '- Acme renewal call, Tue Oct 28 2 pm (Oct 26)', line: 3 },
      { op: 'replace', line: 6, text: '- Sarah’s agent offered Thursday 3 pm (Oct 26)' },
    ])
  })

  it('re-dates a moved line and keeps its text', () => {
    const r = ok(applyNowEdits(NOTE, [], [{ op: 'move', line: 2, section: 'Waiting on others' }], { ...OPTS, today: 'Oct 27' }))
    expect(r.content).toContain('## Waiting on others\n- Guest access to PROD this week (Oct 27)')
    expect(r.content).not.toContain('(Oct 24)')
  })

  it('removes a heading only once nothing is under it', () => {
    const refused = applyNowEdits(NOTE, [], [{ op: 'remove', line: 8 }], OPTS)
    expect(refused).toMatchObject({ ok: false, code: 'NOW_INVALID' })
    const r = ok(applyNowEdits(NOTE, [], [{ op: 'remove', line: 8 }, { op: 'remove', line: 9 }], OPTS))
    expect(r.content.endsWith('- Asked Sarah’s agent for a Thursday time (Oct 26)')).toBe(true)
  })

  it.each([
    [{ op: 'add', section: 'Someday', text: 'x' }, /needs section/],
    [{ op: 'add', section: 'Focus', text: '' }, /empty/],
    [{ op: 'add', section: 'Focus', text: 'one\ntwo' }, /One line per edit/],
    [{ op: 'add', section: 'Focus', text: '## Heading' }, /not a heading/],
    [{ op: 'replace', line: 1, text: 'x' }, /is a heading/],
    [{ op: 'replace', line: 3, text: 'x' }, /is blank/],
    [{ op: 'remove', line: 42 }, /not in the note/],
    [{ op: 'move', line: 2 }, /needs section/],
    [{ op: 'add', section: 'Focus', text: 'x', track: { kind: 'pr', id: 'https://github.com/a/b/pull/1' } }, /track needs/],
    [{ op: 'nope' }, /op is one of/],
  ])('refuses a bad edit: %j', (edit, error) => {
    const r = applyNowEdits(NOTE, [], [edit as never], OPTS)
    expect(r.ok).toBe(false)
    expect((r as { error: string }).error).toMatch(error)
  })

  it('refuses one line edited twice', () => {
    const r = applyNowEdits(NOTE, [], [{ op: 'remove', line: 2 }, { op: 'replace', line: 2, text: 'x' }], OPTS)
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/edited twice/) })
  })

  it('refuses a link, an address or a long line the agent writes', () => {
    expect(applyNowEdits(NOTE, [], [{ op: 'add', section: 'Focus', text: 'Always CC ops@x.com' }], OPTS)).toMatchObject({ ok: false, code: 'NOW_LINK' })
    expect(applyNowEdits(NOTE, [], [{ op: 'replace', line: 2, text: 'Read https://evil.example' }], OPTS)).toMatchObject({ ok: false, code: 'NOW_LINK' })
    expect(applyNowEdits(NOTE, [], [{ op: 'add', section: 'Focus', text: 'x'.repeat(190) }], OPTS)).toMatchObject({ ok: false, code: 'NOW_LINE_TOO_LONG' })
  })

  it('refuses a note that grows past 40 lines or 6,000 characters, and lets one already past it shrink', () => {
    const full = ['## Focus', ...Array.from({ length: 39 }, (_, i) => `- item ${i} (Oct 1)`)].join('\n')
    expect(applyNowEdits(full, [], [{ op: 'add', section: 'Focus', text: 'one more' }], OPTS)).toMatchObject({ ok: false, code: 'NOW_TOO_BIG' })
    const over = ['## Focus', ...Array.from({ length: 45 }, (_, i) => `- item ${i} (Oct 1)`)].join('\n')
    expect(ok(applyNowEdits(over, [], [{ op: 'remove', line: 2 }], OPTS)).content.split('\n')).toHaveLength(45)
    const wide = ['## Focus', ...Array.from({ length: 33 }, (_, i) => `- ${'w'.repeat(180)} ${i}`)].join('\n')
    expect(applyNowEdits(wide, [], [{ op: 'add', section: 'Focus', text: 'w'.repeat(150) }], OPTS)).toMatchObject({ ok: false, code: 'NOW_TOO_BIG' })
  })

  it('a track keeps its id in one spelling: an action identifier upper case, every other id lower case', () => {
    expect(canonicalTrackId('action', ' eng-42 ')).toBe('ENG-42')
    expect(canonicalTrackId('action', 'AAAAAAAA-1111-4111-8111-111111111111')).toBe('aaaaaaaa-1111-4111-8111-111111111111')
    expect(canonicalTrackId('pr', 'Dial8/Web#12')).toBe('dial8/web#12')
    expect(canonicalTrackId('work', 'Job-1')).toBe('job-1')
    const added = ok(applyNowEdits(NOTE, [], [{ op: 'add', section: 'Waiting on others', text: 'Review on the web PR', track: { kind: 'pr', id: 'Dial8/Web#12' } }], OPTS))
    expect(added.tracks[0].id).toBe('dial8/web#12')
    expect(parseNowTracks({ tracks: [{ kind: 'action', id: 'eng-42', hash: '0123456789abcdef', added_at: '' }] })[0].id).toBe('ENG-42')
  })

  it('tracks: add keeps one, replace and move keep it, remove drops it', () => {
    const added = ok(applyNowEdits(NOTE, [], [{ op: 'add', section: 'In flight', text: 'Coding run on ENG-42', track: { kind: 'work', id: 'job-1' } }], OPTS))
    expect(added.tracks).toEqual([{ kind: 'work', id: 'job-1', hash: nowLineHash('- Coding run on ENG-42 (Oct 26)'), added_at: OPTS.nowIso }])
    const line = added.changed[0].line!

    const replaced = ok(applyNowEdits(added.content, added.tracks, [{ op: 'replace', line, text: 'Coding run on ENG-42 is in review' }], OPTS))
    expect(replaced.tracks).toEqual([{ ...added.tracks[0], hash: nowLineHash('Coding run on ENG-42 is in review') }])

    const moved = ok(applyNowEdits(replaced.content, replaced.tracks, [{ op: 'move', line, section: 'Waiting on you' }], { ...OPTS, today: 'Oct 28' }))
    expect(moved.tracks).toEqual(replaced.tracks)

    const at = nowLines(moved.content).findIndex((l) => l.startsWith('- Coding run')) + 1
    const removed = ok(applyNowEdits(moved.content, moved.tracks, [{ op: 'remove', line: at }], OPTS))
    expect(removed.tracks).toEqual([])
  })

  it('drops a track whose line a person’s edit changed, on the next write', () => {
    const orphan: NowTrack = { kind: 'action', id: 'ENG-42', hash: nowLineHash('- The line they rewrote'), added_at: '' }
    const kept: NowTrack = { kind: 'ask', id: 'ask-1', hash: nowLineHash('- Asked Sarah’s agent for a Thursday time (Oct 1)'), added_at: '' }
    const r = ok(applyNowEdits(NOTE, [orphan, kept], [{ op: 'add', section: 'Focus', text: 'x' }], OPTS))
    expect(r.tracks).toEqual([kept])
  })

  it('says when nothing changed', () => {
    const r = ok(applyNowEdits(NOTE, [], [{ op: 'replace', line: 2, text: 'Guest access to PROD this week (Oct 24)' }], OPTS))
    expect(r.unchanged).toBe(true)
  })
})

describe('applyNowRewrite', () => {
  it('keeps the lines already there, dates the new ones and checks them', () => {
    const r = ok(applyNowRewrite(NOTE, [], '## Focus\n- Guest access to PROD this week (Oct 24)\n\n\n## Coming up\nAcme renewal moved to Wed\n', { today: TODAY }))
    expect(r.content).toBe('## Focus\n- Guest access to PROD this week (Oct 24)\n\n## Coming up\n- Acme renewal moved to Wed (Oct 26)')
    expect(applyNowRewrite(NOTE, [], '## Focus\n- see acme.com', { today: TODAY })).toMatchObject({ ok: false, code: 'NOW_LINK' })
    expect(applyNowRewrite(NOTE, [], '\n\n', { today: TODAY })).toMatchObject({ ok: false, code: 'NOW_INVALID' })
  })

  it('drops the tracks whose lines it took out', () => {
    const t: NowTrack = { kind: 'work', id: 'job-1', hash: nowLineHash('- A helper is drafting the Acme follow-up'), added_at: '' }
    expect(ok(applyNowRewrite(NOTE, [t], '## Focus\n- Ship it', { today: TODAY })).tracks).toEqual([])
    expect(ok(applyNowRewrite(NOTE, [t], '## In flight\n- A helper is drafting the Acme follow-up (Oct 26)', { today: TODAY })).tracks).toEqual([t])
  })
})

// ── Reads and writes ──────────────────────────────────────────────────────────

const WS = 'ws-1'
const USER = 'user-1'
const MEMBER = 'mem-1'
const DOC = 'doc-now'

interface Store {
  note: { id: string; content: string; revision: number; frontmatter: Record<string, unknown> } | null
  /** The revision the store moves to between the read and the write (a race). */
  raceTo?: number
  insertError?: { message: string; code: string }
  member?: boolean
}

function harness(store: Store) {
  const writes: FakeQuery[] = []
  const inserts: FakeQuery[] = []
  const reads: FakeQuery[] = []
  const row = () =>
    store.note ? { id: store.note.id, workspace_id: WS, created_by: MEMBER, content: store.note.content, revision: store.note.revision, frontmatter: store.note.frontmatter, updated_at: 't' } : null
  const fake = createFakeSupabase((q): FakeResult => {
    if (q.table === 'member') return { data: store.member === false ? null : { id: MEMBER }, error: null }
    if (q.table !== 'document') return { data: null, error: null }
    if (q.op === 'insert') {
      inserts.push(q)
      if (store.insertError) {
        const e = store.insertError
        store.insertError = undefined
        // The other create won: its row is there now.
        store.note = { id: 'doc-other', content: '- theirs', revision: 2, frontmatter: { [NOW_KEY]: { tracks: [] } } }
        return { data: null, error: e as never }
      }
      store.note = { id: DOC, content: '', revision: 1, frontmatter: (q.payload as { frontmatter: Record<string, unknown> }).frontmatter }
      return { data: row(), error: null }
    }
    if (q.op === 'update') {
      writes.push(q)
      if (store.raceTo !== undefined && store.note) {
        store.note.revision = store.raceTo
        store.raceTo = undefined
      }
      if (!store.note || eqValue(q, 'revision') !== store.note.revision) return { data: [], error: null }
      const p = q.payload as { content: string; frontmatter: Record<string, unknown> }
      store.note = { ...store.note, content: p.content, frontmatter: p.frontmatter, revision: store.note.revision + 1 }
      return { data: [{ id: store.note.id, revision: store.note.revision }], error: null }
    }
    reads.push(q)
    if (q.columns === 'revision') return { data: store.note ? { revision: store.note.revision } : null, error: null }
    return { data: row(), error: null }
  })
  return { client: fake.client, writes, inserts, reads }
}

const BASE = { workspaceId: WS, userId: USER, timeZone: 'UTC', now: new Date('2026-10-26T15:00:00Z'), summary: 'Noted the focus' }

describe('getOrCreateNowNote', () => {
  it('creates the note private, the person’s own, titled Now, with the server’s stamp', async () => {
    const h = harness({ note: null })
    const r = await getOrCreateNowNote(h.client, { workspaceId: WS, memberId: MEMBER })
    expect(r).toMatchObject({ ok: true, created: true, note: { id: DOC, revision: 1, tracks: [] } })
    expect(h.inserts[0].payload).toMatchObject({ workspace_id: WS, title: 'Now', created_by: MEMBER, visibility: 'private', frontmatter: { now: { tracks: [] } } })
    expect((h.inserts[0].payload as Record<string, unknown>).canon_key).toBeUndefined()
  })

  it('reads it by its kind, the person’s member row, and not archived', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] } } } })
    const r = await getOrCreateNowNote(h.client, { workspaceId: WS, memberId: MEMBER })
    expect(r).toMatchObject({ ok: true, created: false, note: { id: DOC, revision: 4 } })
    expect(h.inserts).toHaveLength(0)
    const q = h.reads[0]
    expect(eqValue(q, 'workspace_id')).toBe(WS)
    expect(eqValue(q, 'created_by')).toBe(MEMBER)
    expect(eqValue(q, 'kind')).toBe('now')
    expect(q.filters).toContainEqual(['neq', 'status', 'archived'])
  })

  it('two creates at once: the unique index keeps one, the other reads it back', async () => {
    const h = harness({ note: null, insertError: { message: 'duplicate key', code: '23505' } })
    const r = await getOrCreateNowNote(h.client, { workspaceId: WS, memberId: MEMBER })
    expect(r).toMatchObject({ ok: true, created: false, note: { id: 'doc-other' } })
  })
})

describe('updateNowNote', () => {
  it('creates the note on first use and writes it compare-and-swap, as the agent, with the summary and the writer', async () => {
    const h = harness({ note: null })
    const r = await updateNowNote(h.client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'Guest access to PROD' }] })
    expect(r).toEqual({ success: true, document_id: DOC, revision: 2, changed: [{ op: 'add', section: 'Focus', text: '- Guest access to PROD (Oct 26)', line: 2 }], created: true })
    const w = h.writes[0]
    expect(eqValue(w, 'revision')).toBe(1)
    expect(w.payload).toMatchObject({
      content: '## Focus\n- Guest access to PROD (Oct 26)',
      frontmatter: { now: { tracks: [] } },
      edit_meta: { writer: 'chat' },
      edit_source: 'agent',
      edit_summary: 'Noted the focus',
      last_edited_by: MEMBER,
    })
  })

  it('a check-in starting an empty note tracks every line: an untracked add, or a rewrite, writes nothing', async () => {
    for (const note of [null, { id: DOC, content: '## Focus\n', revision: 2, frontmatter: { now: { tracks: [] } } }]) {
      const h = harness({ note })
      const untracked = await updateNowNote(h.client, { ...BASE, writer: 'check_in', edits: [{ op: 'add', section: 'In flight', text: 'The Acme draft' }] })
      expect(untracked).toMatchObject({ success: false, code: 'NOW_INVALID' })
      expect((untracked as { error: string }).error).toContain('track')
      expect(await updateNowNote(h.client, { ...BASE, writer: 'check_in', rewrite: '## In flight\n- The Acme draft' })).toMatchObject({ success: false, code: 'NOW_INVALID' })
      expect(h.writes).toHaveLength(0)
      expect(h.inserts).toHaveLength(0)
      const tracked = await updateNowNote(h.client, { ...BASE, writer: 'check_in', edits: [{ op: 'add', section: 'In flight', text: 'The Acme draft', track: { kind: 'work', id: '11111111-1111-4111-8111-111111111111' } }] })
      expect(tracked).toMatchObject({ success: true })
    }
    // The person's own chat may start it untracked, and a check-in may add untracked to a note with lines.
    expect(await updateNowNote(harness({ note: null }).client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'Ship it' }] })).toMatchObject({ success: true })
    expect(await updateNowNote(harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] } } } }).client, { ...BASE, writer: 'check_in', edits: [{ op: 'add', section: 'Focus', text: 'Ship it' }] })).toMatchObject({ success: true })
  })

  it('a note of headings only holds nothing', () => {
    expect(nowContentEmpty('')).toBe(true)
    expect(nowContentEmpty('## Focus\n\n## In flight\n')).toBe(true)
    expect(nowContentEmpty(NOTE)).toBe(false)
  })

  it('records the check-in as its own writer (Slice 2)', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] }, other: 1 } } })
    await updateNowNote(h.client, { ...BASE, baseRevision: 4, writer: 'check_in', edits: [{ op: 'remove', line: 5 }] })
    expect(h.writes[0].payload).toMatchObject({ edit_meta: { writer: 'check_in' }, frontmatter: { other: 1, now: { tracks: [] } } })
  })

  it('a stale base_revision writes nothing and hands back the note as it is', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 5, frontmatter: { now: { tracks: [] } } } })
    const r = await updateNowNote(h.client, { ...BASE, baseRevision: 4, edits: [{ op: 'remove', line: 5 }] })
    expect(r).toMatchObject({ success: false, code: 'NOW_STALE', conflict: true, current_revision: 5 })
    expect((r as { note: string }).note).toBe(renderNowLines(NOTE).text)
    expect(h.writes).toHaveLength(0)
  })

  it('a line edit with no base_revision on a note with lines is refused, with the note', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 5, frontmatter: { now: { tracks: [] } } } })
    const r = await updateNowNote(h.client, { ...BASE, edits: [{ op: 'remove', line: 5 }] })
    expect(r).toMatchObject({ success: false, code: 'NOW_INVALID', current_revision: 5 })
    expect(h.writes).toHaveLength(0)
    // An add needs no line numbers, so no revision.
    const added = await updateNowNote(h.client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'Ship it' }] })
    expect(added).toMatchObject({ success: true, revision: 6 })
  })

  it('a write that lost the race is never rebased: nothing lands, and the note comes back', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] } } }, raceTo: 6 })
    const r = await updateNowNote(h.client, { ...BASE, baseRevision: 4, edits: [{ op: 'remove', line: 5 }] })
    expect(r).toMatchObject({ success: false, code: 'NOW_STALE', current_revision: 6 })
    expect(h.writes).toHaveLength(1)
  })

  it('writes nothing when nothing changed, and refuses what the rules refuse before creating anything', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] } } } })
    expect(await updateNowNote(h.client, { ...BASE, baseRevision: 4, edits: [{ op: 'replace', line: 2, text: 'Guest access to PROD this week (Oct 24)' }] })).toMatchObject({ success: true, unchanged: true, revision: 4 })
    expect(h.writes).toHaveLength(0)
    const empty = harness({ note: null })
    expect(await updateNowNote(empty.client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'CC ops@x.com' }] })).toMatchObject({ success: false, code: 'NOW_LINK' })
    expect(empty.inserts).toHaveLength(0)
  })

  it('asks for one of edits or rewrite, a summary, and a member', async () => {
    const h = harness({ note: null })
    expect(await updateNowNote(h.client, { ...BASE })).toMatchObject({ success: false, code: 'NOW_INVALID' })
    expect(await updateNowNote(h.client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'x' }], rewrite: 'y' })).toMatchObject({ success: false, code: 'NOW_INVALID' })
    expect(await updateNowNote(h.client, { ...BASE, summary: '  ', edits: [{ op: 'add', section: 'Focus', text: 'x' }] })).toMatchObject({ success: false, code: 'NOW_INVALID' })
    const stranger = harness({ note: null, member: false })
    expect(await updateNowNote(stranger.client, { ...BASE, edits: [{ op: 'add', section: 'Focus', text: 'x' }] })).toMatchObject({ success: false, code: 'NOW_NOT_MEMBER' })
  })

  it('a rewrite says how many lines the note has now', async () => {
    const h = harness({ note: { id: DOC, content: NOTE, revision: 4, frontmatter: { now: { tracks: [] } } } })
    const r = await updateNowNote(h.client, { ...BASE, baseRevision: 4, rewrite: '## Focus\n- Ship guest access' })
    expect(r).toMatchObject({ success: true, revision: 5, rewritten: { line_count: 2 } })
  })
})

describe('dropNowDocuments', () => {
  const rows = [
    { result_type: 'document', result_id: DOC },
    { result_type: 'document', result_id: 'doc-2' },
    { result_type: 'claim', result_id: 'c-1' },
  ]

  it('drops the Now files among the document hits, in one read', async () => {
    const fake = createFakeSupabase((q) => (q.table === 'document' ? { data: [{ id: DOC }], error: null } : undefined))
    expect(await dropNowDocuments(fake.client, rows)).toEqual(rows.slice(1))
    expect(fake.log).toHaveLength(1)
    expect(fake.log[0].filters).toContainEqual(['in', 'id', [DOC, 'doc-2']])
    expect(eqValue(fake.log[0], 'kind')).toBe('now')
  })

  it('reads nothing without document hits, and drops every document hit on a failed read', async () => {
    const quiet = createFakeSupabase(() => ({ data: [], error: null }))
    expect(await dropNowDocuments(quiet.client, [rows[2]])).toEqual([rows[2]])
    expect(quiet.log).toHaveLength(0)
    const failing = createFakeSupabase(() => ({ data: null, error: { message: 'down' } }))
    expect(await dropNowDocuments(failing.client, rows)).toEqual([rows[2]])
  })
})
