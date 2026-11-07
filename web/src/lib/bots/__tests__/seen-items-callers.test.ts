// @vitest-environment jsdom
/**
 * Who reads what (docs/plans/bots-v4.md, "What the bubble lists: new, then
 * seen", the caller table). `bubbleItems` stays new only; `seenItems` (what
 * still waits on you but isn't new) is read only by the bot's page, the chat's
 * For you column and the main agent's "what's pending", each after
 * `bubbleItems`.
 *
 *   • new only, by behaviour: a teammate whose only waiting work is seen (a
 *     question you opened, a review you opened) has nothing new, and no dot
 *     (countByOwner's `beckoning`);
 *   • by source: no file outside the table names `seenItems`.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { countByOwner } from '@/lib/work/agent-work-lanes'
import type { LightWorkRow } from '@/lib/work/queries'
import { bubbleItems, seenItems } from '../bubble-items'

function light(id: string, over: Partial<LightWorkRow> = {}): LightWorkRow {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_review',
    origin: 'loop',
    ai_team_member_id: 'writer',
    parent_id: null,
    root_id: null,
    flow_run_id: null,
    source: {},
    opened_at: null,
    needs: null,
    created_at: '2026-10-03T08:00:00.000Z',
    teammate: null,
    ...over,
  }
}

/** Only seen work: a question and a review, each opened since it started waiting. */
const SEEN_ONLY = [
  light('opened-question', { status: 'needs_input', opened_at: '2026-10-03T09:00:00.000Z' }),
  light('quiet-draft', { kind: 'email_drafts', opened_at: '2026-10-03T09:05:00.000Z' }),
]

describe('seenItems vs bubbleItems, per caller', () => {
  it('the source the callers read: all of it seen, none of it new', () => {
    const counts = countByOwner(SEEN_ONLY)
    expect(seenItems('writer', SEEN_ONLY).map((i) => i.id)).toEqual(['opened-question', 'quiet-draft'])
    expect(bubbleItems('writer', counts, SEEN_ONLY, [])).toEqual([])
    const withNew = [...SEEN_ONLY, light('new-review')]
    expect(bubbleItems('writer', countByOwner(withNew), withNew, []).map((i) => i.id)).toEqual(['new-review'])
  })

  it('the dot (countByOwner beckoning): new only', () => {
    expect(countByOwner(SEEN_ONLY).get('tm:writer')).toMatchObject({ needsYou: 2, beckoning: [] })
  })

  it('no file outside the caller table names seenItems', () => {
    const src = join(process.cwd(), 'src')
    // The table's callers that read both (bots-v4.md): the bot's page, the
    // main agent's "what's pending" (Phase A1), the chat's For you column
    // (always-on-agent.md decision 13: every bot's For you, bubbleItems then
    // seenItems). And its home (bubble-items.ts).
    const allowed = [
      'lib/bots/bubble-items.ts',
      'lib/bots/bot-work-server.ts',
      'lib/bots/for-you-column.ts',
      'components/bots/bot-page/',
    ]
    const naming: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry)
        if (statSync(path).isDirectory()) {
          if (entry !== '__tests__' && entry !== 'node_modules') walk(path)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry)) continue
        if (/\bseenItems\b/.test(readFileSync(path, 'utf8'))) naming.push(relative(src, path).split(sep).join('/'))
      }
    }
    walk(src)
    expect(naming).toContain('lib/bots/bubble-items.ts')
    // The main agent's "what's pending" reads it (Phase A1).
    expect(naming).toContain('lib/bots/bot-work-server.ts')
    // The bot's page reads it, in For you (Phase 1b).
    expect(naming).toContain('components/bots/bot-page/for-you.tsx')
    // The chat's For you column reads it the same way (decision 13).
    expect(naming).toContain('lib/bots/for-you-column.ts')
    expect(naming.filter((file) => !allowed.some((ok) => (ok.endsWith('/') ? file.startsWith(ok) : file === ok)))).toEqual([])
  })
})
