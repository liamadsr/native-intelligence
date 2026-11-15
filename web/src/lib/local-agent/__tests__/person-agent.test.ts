/**
 * Who may put work on the person's OWN coding agent (migration 658): only a
 * person's own click. A card's Start (the start-agent route, through
 * startActionOnMac → startActionMacJob → createSession) carries the choice
 * the person made for it (`agent`: an agent's id, or null), and only when
 * they made one; every other start (no choice sent, a loop's fire, a work
 * card settled for them) stays on Native Intelligence's own agent, whatever
 * the Mac's saved choice says. A
 * person's own agent runs its own shell and file tools, which the risky-call
 * reviewer never sees: the person who clicked is the guard.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/ai/decisions/run-decision', () => ({ runDecision: vi.fn() }))
const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { startActionMacJob, startUnattendedLocalAgent, type UnattendedDeps } from '../unattended'
import { startActionOnMac, startInEnvironment, startWorkOnMac } from '@/lib/environments/start'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const ACTION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const FLOW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const deps: UnattendedDeps = { reviewerMode: () => 'default', paused: async () => false, homeThread: async () => CONV }

let db: FakeDb
beforeEach(() => {
  db = seeded({
    environment: [
      {
        id: MAC_ENV, kind: 'mac', name: 'Studio Mac', owner_user_id: USER, device_id: DEVICE, workspace_id: null, archived_at: null,
        // The Mac's saved choice, and what it last said it offers.
        worker: 'codex',
        offered_workers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
        created_at: '2026-10-01', updated_at: '2026-10-01',
      },
    ],
    device_folder_setting: [{ device_folder_id: FOLDER, base_branch: null, repo_full_name: 'harbor/site' }],
    actions: [{ id: ACTION, workspace_id: WS, agent_run_status: null }],
  })
  for (const f of Object.values(ledger)) f.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const sessionWorker = () => db.tables.local_agent_session.at(-1)?.worker
const actionJob = (agent?: Parameters<typeof startActionMacJob>[1]['agent'], startId = 's1') =>
  startActionMacJob(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, request: 'Fix the export', mode: 'edit', origin: { actionId: ACTION, startId }, ...(agent ? { agent } : {}) }, deps)

describe('a card’s Start (a person’s click) may use their own agent', () => {
  it('one picked for the card, or our own agent chosen; never the Mac’s saved choice', async () => {
    expect(await actionJob({ worker: 'claude-code' })).toMatchObject({ status: 'started' })
    expect(sessionWorker()).toBe('claude-code')
    db.tables.local_agent_session.length = 0
    expect(await actionJob({ worker: null })).toMatchObject({ status: 'started' })
    expect(sessionWorker()).toBeUndefined()
  })

  it('a job on another agent working that folder is refused with a sentence naming it (the join rule)', async () => {
    await actionJob({ worker: 'claude-code' })
    db.tables.local_agent_session[0].status = 'running'
    const out = await actionJob({ worker: null }, 's2')
    expect(out).toMatchObject({ status: 'skipped', code: 'FOLDER_BUSY' })
    expect((out as { reason: string }).reason).toContain('on the person’s own coding agent (claude-code)')
  })

  it('startActionOnMac: an agent the Mac didn’t say it offers is refused, one it did starts and says so', async () => {
    const run = (worker: string | null) =>
      startActionOnMac(db as never, {
        userId: USER, workspaceId: WS, environmentId: MAC_ENV, repo: 'harbor/site',
        action: { id: ACTION, identifier: 'ENG-7', title: 'Fix the export', description: null },
        agent: { worker },
        deps,
      })
    const refused = await run('gemini-cli')
    expect(refused).toMatchObject({ status: 'refused', code: 'WORKER_NOT_OFFERED', httpStatus: 409 })
    expect((refused as { reason: string }).reason).toContain('doesn’t offer Gemini Cli right now')
    expect(db.tables.local_agent_session ?? []).toHaveLength(0)
    const started = await run('claude-code')
    expect(started).toMatchObject({ status: 'started', worker: 'claude-code', mac: 'Studio Mac' })
  })
})

describe('starts with no choice stay on Native Intelligence’s own agent, whatever the Mac saved (each layer)', () => {
  it('startActionMacJob without the person’s choice', async () => {
    expect(await actionJob()).toMatchObject({ status: 'started' })
    expect(sessionWorker()).toBeUndefined()
  })

  it('startActionOnMac without the person’s choice (the Start route with no `worker`)', async () => {
    const out = await startActionOnMac(db as never, {
      userId: USER, workspaceId: WS, environmentId: MAC_ENV, repo: 'harbor/site',
      action: { id: ACTION, identifier: 'ENG-7', title: 'Fix the export', description: null },
      deps,
    })
    expect(out).toMatchObject({ status: 'started', worker: null })
    expect(sessionWorker()).toBeUndefined()
  })

  it('startInEnvironment and createSession without macWorker or explicitWorker', async () => {
    const out = await startInEnvironment(db as never, {
      kind: 'mac', userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Look around', mode: 'read', startedBy: 'person',
    })
    expect(out.kind).toBe('mac')
    expect(sessionWorker()).toBeUndefined()
  })

  it('a loop’s fire', async () => {
    const out = await startUnattendedLocalAgent(
      db as never,
      { userId: USER, workspaceId: WS, folderId: FOLDER, request: 'Check the build', mode: 'read', origin: { flowId: FLOW, actionId: ACTION, fireKey: 'fire-1' } },
      deps,
    )
    expect(out).toMatchObject({ status: 'started' })
    expect(sessionWorker()).toBeUndefined()
  })

  it('a work card started in a folder it picked', async () => {
    const out = await startWorkOnMac(db as never, {
      userId: USER, workspaceId: WS, folderId: FOLDER,
      action: { id: ACTION, identifier: 'ENG-7', title: 'Tidy the README', task: 'Tidy it' },
      deps,
    })
    expect(out).toMatchObject({ status: 'started' })
    expect(sessionWorker()).toBeUndefined()
  })

  it('in the code: only these calls may hand a worker on (any key spelling, any spread, any argument passed whole)', () => {
    const root = join(process.cwd(), 'src')
    const STARTS = ['startActionOnMac', 'startActionMacJob', 'startUnattended', 'createSession', 'startInEnvironment']
    // Where the start functions live, or are imported from.
    const HOMES = /from '(@\/lib\/local-agent\/store|@\/lib\/environments\/start|@\/lib\/local-agent\/unattended|@\/lib\/environments|\.\/store|\.\/start|\.\/unattended|\.\.\/store|\.\.\/start|\.\.\/unattended)'/
    /** The text between a call's parentheses, by bracket matching. */
    const argsAt = (text: string, open: number): string => {
      let depth = 0
      for (let i = open; i < text.length; i++) {
        const c = text[i]
        if (c === '(' || c === '{' || c === '[') depth++
        else if (c === ')' || c === '}' || c === ']') {
          depth--
          if (depth === 0) return text.slice(open + 1, i)
        }
      }
      return text.slice(open + 1)
    }
    /** Could this call carry a worker: a worker-ish key, a spread, or an argument that isn't an object literal. */
    const mayCarry = (args: string): boolean => {
      if (/\b(worker|agent|macWorker|explicitWorker|chosenWorker)\b\s*[:,}]/.test(args)) return true
      if (/\.\.\./.test(args)) return true
      // The input argument passed whole (a variable), not an object literal: anything could ride in it.
      const parts = args.split(',').map((p) => p.trim())
      return parts.length >= 2 && !parts[1].startsWith('{')
    }
    const flagged = new Set<string>()
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(p)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name)) continue
        const rel = p.slice(root.length + 1)
        const text = readFileSync(p, 'utf8')
        const defines = /^lib\/(local-agent\/(store|unattended)|environments\/start)\.ts$/.test(rel)
        if (!defines && !HOMES.test(text)) continue
        for (const fn of STARTS) {
          const re = new RegExp(`(?<![\\w.])${fn}\\s*\\(`, 'g')
          for (const m of text.matchAll(re)) {
            // A definition, not a call.
            if (/function\s*$|async function\s*$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue
            if (mayCarry(argsAt(text, m.index! + m[0].length - 1))) flagged.add(`${rel} → ${fn}`)
          }
        }
      }
    }
    walk(root)
    expect([...flagged].sort()).toEqual([
      // A person's own click on a card's Start: their pick (or none).
      'app/api/account/actions/[id]/start-agent/route.ts → startActionOnMac',
      // A chat start (a person's typed turn): its Mac's saved choice.
      'lib/chat/local-agent-tools.ts → startInEnvironment',
      // startInEnvironment hands its input on whole; startActionOnMac hands the route's pick on.
      'lib/environments/start.ts → createSession',
      'lib/environments/start.ts → startActionMacJob',
      // createSession's own retry, with the same input.
      'lib/local-agent/store.ts → createSession',
      // startActionMacJob and the loop start hand their input on; startUnattended turns the pick into explicitWorker.
      'lib/local-agent/unattended.ts → createSession',
      'lib/local-agent/unattended.ts → startUnattended',
    ])
  })

})
