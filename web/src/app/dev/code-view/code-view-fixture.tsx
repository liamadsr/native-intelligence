'use client'

/**
 * The Code view from fixtures (page.tsx says why). Everything here is made up:
 * a Codex job on "Test Mac" in a folder "acme-app", an action ACME-12.
 *
 * It draws the same pieces the Code view does: the conversation's rows
 * (ConversationRows, the panel's own, in the panel's log column, inside the
 * chat's reading column) and the right panel's cards (CodeChatSections, read
 * from the Code view's store, which this fills). The Review card's record and
 * the Action card's action come from a stubbed `fetch`.
 */
import { useEffect, useMemo, useState } from 'react'
import { ConversationRows, CONVERSATION_LOG_CLASS, drawnRows } from '@/components/local-agent/local-agent-panel'
import { BranchCardActions } from '@/components/local-agent/branch-card'
import { AgentWorkFixtureProvider } from '@/components/work/agent-work-provider'
import { CodeChatSections } from '@/app/account/(dashboard)/side-panels/code-chat-sections'
import { selectCodeChat, setCodeChatLive, type CodeChatLive } from '@/app/account/(dashboard)/chat/code-chat-live'
import type { PanelSession } from '@/components/local-agent/session-api'
import type { TranscriptItem } from '@/lib/local-agent/transcript-view'
import type { AgentWork } from '@/hooks/use-agent-work'
import type { UseAttentionItems } from '@/hooks/use-attention-items'

const SESSION_ID = 'fixture-session'
const JOB_ID = 'fixture-job'
const ACTION_ID = 'fixture-action'
const AGO = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SESSION: PanelSession = {
  id: SESSION_ID,
  folderId: 'fixture-folder',
  folderLabel: 'acme-app',
  deviceId: 'fixture-device',
  deviceName: 'Test Mac',
  conversationId: null,
  mode: 'edit',
  request: 'Add a retry with backoff to the invoice sync, and cover it with tests.',
  status: 'waiting',
  lastSignal: 'finish',
  lastSignalText: null,
  branch: 'dial8/acme-app-16fa2a5e',
  commitSha: '9c2f1e4b7a0d3c8e5f6a1b2c3d4e5f6a7b8c9d0e',
  error: null,
  trackedJobId: JOB_ID,
  createdAt: AGO(90),
  updatedAt: AGO(5),
  endedAt: null,
  lastDeviceSeq: null,
  startedBy: 'person',
  prUrl: 'https://github.com/acme/acme-app/pull/187',
  model: 'gpt-6.2-sol',
  effort: 'medium',
  worker: 'codex',
  actionId: ACTION_ID,
}

const tool = (key: string, name: string, input: Record<string, unknown>, ok = true, output = 'ok'): TranscriptItem => ({
  type: 'tool',
  key,
  callId: key,
  name,
  input: JSON.stringify(input),
  result: { ok, output },
})

const ITEMS: TranscriptItem[] = [
  tool('t0', 'report', { text: 'Tests running' }),
  {
    type: 'report',
    key: 'r1',
    text: 'All 35 focused tests passed. TypeScript verification is running.',
    teammate: true,
  },
  tool('t1', 'shell', { command: 'npx vitest run src/lib/invoices' }),
  tool('t2', 'read_file', { path: 'src/lib/invoices/sync.ts' }),
  tool('t3', 'apply_patch', { path: 'src/lib/invoices/sync.ts' }),
  tool('t4', 'apply_patch', { path: 'src/lib/invoices/__tests__/sync.test.ts' }),
  tool('t5', 'shell', { command: 'npm run typecheck' }),
  tool('t6', 'grep', { pattern: 'retryWithBackoff' }),
  tool('t7', 'shell', { command: 'git diff --stat' }),
  tool('t8', 'read_file', { path: 'src/lib/invoices/retry.ts' }),
  {
    type: 'assistant',
    key: 'a1',
    open: false,
    text:
      '**Done.** The invoice sync now retries with backoff.\n\n- `retryWithBackoff` waits 1s, 2s, then 4s before it gives up.\n- A 4xx answer is never retried.\n- Four new tests cover the waits and the give-up.\n\nAll 35 focused tests pass and the typecheck is clean.',
  },
  { type: 'branch', key: 'b1', name: 'dial8/acme-app-16fa2a5e', commit: '9c2f1e4', filesChanged: 4, insertions: 123, deletions: 16 },
  { type: 'status', key: 's1', status: 'waiting', reason: 'parked' },
  { type: 'inbound', key: 'i1', author: 'person', text: 'Open a pull request for this work.', policy: 'queue' },
  { type: 'assistant', key: 'a2', open: false, text: 'Opening a pull request for the branch now.' },
  tool('t9', 'finish', { pull_request: true }),
  {
    type: 'assistant',
    key: 'a3',
    open: false,
    text: 'Submitted **ACME-12** for approval on your Mac. Once you say yes there, I push the branch and open the pull request.',
  },
  { type: 'branch', key: 'b2', name: 'dial8/acme-app-16fa2a5e', commit: '9c2f1e4', filesChanged: 4, insertions: 123, deletions: 16 },
  { type: 'prompt', key: 'p1', id: 'p1', prompt: 'push', state: 'allowed', why: null },
  {
    type: 'pull_request',
    key: 'pr1',
    ok: true,
    url: 'https://github.com/acme/acme-app/pull/187',
    branch: 'dial8/acme-app-16fa2a5e',
    via: 'gh',
    pushed: true,
    error: null,
  },
  { type: 'status', key: 's2', status: 'waiting', reason: 'parked' },
]

const JOB = {
  item: {
    id: JOB_ID,
    workspace_id: 'fixture-workspace',
    member_id: 'fixture-member',
    kind: 'local_agent',
    title: 'Codex on Test Mac · acme-app: Open a pull request for this work: call finish with pull_request set, and say what you did in a line',
    status: 'done',
    actor: 'agent',
    current_step: null,
    progress: {
      steps: [
        { at: AGO(80), text: 'Started on Test Mac' },
        { at: AGO(76), text: 'Finished: ready for your review' },
      ],
    },
    result_summary:
      'Added retryWithBackoff to the invoice sync (1s, 2s, 4s, then it gives up; a 4xx is never retried) and four tests for it. All 35 focused tests pass and the typecheck is clean. Pull request #187 is open for ACME-12.',
    error_message: null,
    skip_reason: null,
    deliverables: [],
    needs: null,
    source: { local_agent_session_id: SESSION_ID },
    run_key: null,
    agent_run_id: null,
    flow_run_id: null,
    created_at: AGO(80),
    started_at: AGO(80),
    finished_at: AGO(78.75),
    reviewed_at: AGO(60),
    last_beat_at: AGO(78),
    deadline_at: null,
    opened_at: AGO(60),
  },
  run: null,
  drafts: [],
}

/** The record's and the action's reads, answered here; everything else reaches the dev server as ever. */
function useStubbedFetch() {
  useEffect(() => {
    const real = window.fetch
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))
      if (url.includes(`/api/account/activity/${JOB_ID}`)) return json(JOB)
      if (url.includes(`/api/account/actions/${ACTION_ID}`)) return json({ action: { identifier: 'ACME-12', title: 'Retry the invoice sync with backoff' } })
      return real(input, init)
    }
    return () => {
      window.fetch = real
    }
  }, [])
}

const WORK = {
  rows: [],
  cardRows: [],
  roster: [],
  workspaceIds: ['fixture-workspace'],
  currentWorkspaceId: 'fixture-workspace',
  loading: false,
  failed: false,
} as unknown as AgentWork
const ATTENTION = { items: [], asks: [], isLoading: false, loaded: true } as unknown as UseAttentionItems

const ok = async () => ({ ok: true as const })

export default function CodeViewFixture() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const dark = params.get('theme') === 'dark'
  const empty = params.get('view') === 'new'
  useStubbedFetch()
  const [ready, setReady] = useState(false)
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
    if (!empty) {
      selectCodeChat(SESSION_ID)
      const live: CodeChatLive = { session: SESSION, stopping: false, send: ok, stop: ok, promptOpen: false, noChanges: false, filesChanged: 4, insertions: 123, deletions: 16 }
      setCodeChatLive(SESSION_ID, live)
    }
    setReady(true)
  }, [dark, empty])
  const rows = useMemo(() => drawnRows(ITEMS), [])
  const branchActions = useMemo(() => ({ quiet: true }), [])
  if (!ready) return null
  return (
    <AgentWorkFixtureProvider work={WORK} attention={ATTENTION}>
      <div data-code-view-fixture={empty ? 'new' : 'chat'} className="flex h-dvh w-full text-foreground">
        <main className="relative flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 justify-center">
            <div className="chat-reading-col flex h-full min-h-0 w-full flex-col px-5 pb-2 pt-4">
              {!empty && (
                <BranchCardActions.Provider value={branchActions}>
                  <div role="log" className={`${CONVERSATION_LOG_CLASS} scrollbar-hide`}>
                    <ConversationRows request={{ author: 'person', text: SESSION.request }} rows={rows} live={false} last={ITEMS[ITEMS.length - 1]} />
                  </div>
                </BranchCardActions.Provider>
              )}
            </div>
          </div>
          {/* Where the main composer stands (chat-input.tsx, not mounted here: it needs the whole shell). */}
          <div className="chat-reading-col mx-auto w-full px-5 pb-4">
            <div className="flex h-[92px] items-center justify-center rounded-[24px] border border-dashed border-border/70 text-xs text-muted-foreground">
              Composer (the app&apos;s own, not drawn in the fixture)
            </div>
          </div>
        </main>
        {!empty && (
          <aside className="flex w-[360px] shrink-0 flex-col gap-2.5 overflow-y-auto p-2.5 scrollbar-hide">
            <CodeChatSections />
          </aside>
        )}
      </div>
    </AgentWorkFixtureProvider>
  )
}
