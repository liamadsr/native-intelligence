// @vitest-environment jsdom
/**
 * The Scout-activity publisher (C2), at the ChatPanel.
 *
 * The list page beside this strip has no other way to learn that a tool in HERE
 * saved fourteen rows to the CRM — its own fetches are driven by its own
 * buttons. This spec pins the seam that tells it:
 *
 *   • one activity per list the conversation touched, with the save's counts
 *     folded per list (a save CAN span lists, and a summary that attributed all
 *     of it to the first would lie about the rest);
 *   • the enroll — whose own output names a sequence and never a list —
 *     attaching to the list this conversation just saved to, which is the only
 *     reason "14 enrolled in Q4 Outbound" can reach the list page at all;
 *   • `version` bumping ONLY for a toolCallId this mount hasn't seen, because
 *     handleLoadConversation replays a resumed transcript in full through
 *     setMessages and the page refetches on every version change — without this
 *     every reopened tab would re-tell a story from last week;
 *   • unmount withdrawing this panel's contribution for every list it touched,
 *     so a dead panel never keeps a list looking busy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import type { UIMessage } from '@ai-sdk/react'
// The save tool's own per-entry types — see saveOutput() for why the fixture
// binds to them instead of restating their fields.
import type { PromotedEntry, SkippedEntry } from '@/lib/prospecting/lists'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

/** The transcript the mocked useChat hands back — swapped per test/rerender. */
let chatMessages: UIMessage[] = []

vi.mock('@ai-sdk/react', () => ({
  useChat: () => ({
    messages: chatMessages,
    sendMessage: vi.fn(),
    setMessages: vi.fn(),
    addToolResult: vi.fn(),
    status: 'ready',
    stop: vi.fn(),
    error: undefined,
    regenerate: vi.fn(),
  }),
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => {},
  }),
}))

// The composer's Capture button needs the recording + tabs providers, which
// these tests don't mount; it has its own tests (capture-bar-button-calendar).
vi.mock('@/app/account/(dashboard)/top-bar/capture-bar-button', () => ({ CaptureBarButton: () => null }))

vi.mock('@/hooks/recording-context', () => ({
  useRecordingStable: () => ({
    flushTranscriptForAgent: async () => {},
    getSegmentsForAgent: () => [],
  }),
}))

vi.mock('../slash-command-picker', () => ({
  useRecipeCommands: () => [],
  SlashCommandPicker: () => null,
}))

// The transcript itself is not under test here — the publisher that READS it
// is. Rendering the real list would drag in ChatMessage's dependencies for no
// coverage.
vi.mock('../chat-message-list', () => ({
  ChatMessageList: () => null,
}))

import { ChatPanel } from '../chat-panel'
import {
  readScoutActivity,
  __resetScoutActivityStore,
} from '../../prospecting/scout-activity'

let callSeq = 0

/** One completed tool call, as the AI SDK shapes it in `message.parts`. */
function toolPart(toolName: string, output: unknown, toolCallId?: string) {
  return {
    type: `tool-${toolName}`,
    toolCallId: toolCallId ?? `call-${++callSeq}`,
    state: 'output-available' as const,
    input: {},
    output,
  }
}

function assistant(parts: unknown[], id?: string): UIMessage {
  return {
    id: id ?? `m-${++callSeq}`,
    role: 'assistant',
    parts: parts as UIMessage['parts'],
  } as UIMessage
}

const DISCOVERY = {
  success: true,
  run: { id: 'run-1', list_id: 'list-1', list_name: 'Series A fintech' },
}

/**
 * The save shape this publisher parses, built from `save_prospect_entries`'s
 * REAL per-entry types rather than a hand-written echo of them.
 *
 * The binding is the point: this extractor reads fields it does not own, so the
 * failure it must never allow is the silent one — P1 renames `list_id` or drops
 * a `kind`, this fixture keeps describing the old world, and every assertion
 * below stays green while the store goes blind in production. Annotating the
 * arrays makes that a compile error here instead.
 *
 * The `by_list` roll-up and the flat counts are the tool's own literal (there
 * is no exported type for them) and stay mirrored by hand — the sibling case
 * 'falls back to the per-item list_id when by_list is absent' is what keeps
 * this readable if they ever drift.
 */
function saveOutput(listId: string) {
  const saved: PromotedEntry[] = [
    { entry_id: 'e1', kind: 'company', list_id: listId, company_id: 'c1' },
    { entry_id: 'e2', kind: 'company', list_id: listId, company_id: 'c2' },
    { entry_id: 'e3', kind: 'person', list_id: listId, contact_id: 'p1' },
  ]
  const skipped: SkippedEntry[] = [
    { entry_id: 'e4', reason: 'needs_review', list_id: listId },
    { entry_id: 'e5', reason: 'no_domain', list_id: listId },
  ]
  return {
    success: true,
    saved,
    skipped,
    saved_count: 3,
    skipped_count: 2,
    sequenceable_contact_ids: ['p1'],
    list_ids: [listId],
    by_list: [
      {
        list_id: listId,
        list_name: 'Series A fintech',
        saved_companies: 2,
        saved_people: 1,
        needs_review: 1,
        skipped_other: 1,
      },
    ],
  }
}

const ENROLL = {
  success: true,
  enrolled: ['p1', 'p2'],
  skipped: [{ contact_id: 'p3', reason: 'no_email' }],
  enrolled_count: 2,
  skipped_count: 1,
  sequence_id: 'seq-1',
  sequence_name: 'Q4 Outbound',
  url: '/account/sequences/seq-1',
}

describe('ChatPanel → scout-activity store', () => {
  let container: HTMLDivElement
  let root: Root

  async function mount(messages: UIMessage[], chatSessionId = 'sess-scout') {
    chatMessages = messages
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => {
      root.render(
        h(ChatPanel, {
          chatSessionId,
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
    })
  }

  /** Re-render with a new transcript, the way a stream (or a resume) would. */
  async function rerender(messages: UIMessage[], chatSessionId = 'sess-scout') {
    chatMessages = messages
    await act(async () => {
      root.render(
        h(ChatPanel, {
          chatSessionId,
          userAvatarUrl: null,
          userInitials: 'LA',
          alwaysShowMessages: true,
        }),
      )
    })
  }

  async function unmount() {
    await act(async () => root.unmount())
    container.remove()
  }

  beforeEach(() => {
    __resetScoutActivityStore()
    callSeq = 0
    chatMessages = []
  })

  afterEach(() => {
    container?.remove()
  })

  it('publishes nothing for a conversation with no prospecting tools', async () => {
    await mount([assistant([{ type: 'text', text: 'Hello.' }])])
    expect(readScoutActivity('list-1')).toBeNull()
    await unmount()
  })

  it('a discovery run marks the list touched, with no counts to retell yet', async () => {
    await mount([assistant([toolPart('run_prospect_discovery', DISCOVERY)])])
    const snap = readScoutActivity('list-1')
    expect(snap?.touched).toBe(true)
    expect(snap?.version).toBe(1)
    expect(snap?.lastSave).toBeNull()
    expect(snap?.lastEnroll).toBeNull()
    await unmount()
  })

  it('folds a save into per-list counts the page can retell', async () => {
    await mount([
      assistant([
        toolPart('run_prospect_discovery', DISCOVERY),
        toolPart('save_prospect_entries', saveOutput('list-1'), 'call-save'),
      ]),
    ])
    expect(readScoutActivity('list-1')?.lastSave).toEqual({
      toolCallId: 'call-save', published: false,
      saved_companies: 2,
      saved_people: 1,
      needs_review: 1,
      skipped_other: 1,
      sequenceable_count: 1,
    })
    await unmount()
  })

  it('a save spanning two lists lands one activity per list, counts kept apart', async () => {
    const split = {
      success: true,
      saved: [
        { entry_id: 'a1', kind: 'company', list_id: 'list-1' },
        { entry_id: 'b1', kind: 'person', list_id: 'list-2' },
        { entry_id: 'b2', kind: 'person', list_id: 'list-2' },
      ],
      skipped: [{ entry_id: 'b3', reason: 'needs_review', list_id: 'list-2' }],
      saved_count: 3,
      skipped_count: 1,
      sequenceable_contact_ids: ['x'],
      list_ids: ['list-1', 'list-2'],
      by_list: [
        {
          list_id: 'list-1',
          list_name: 'A',
          saved_companies: 1,
          saved_people: 0,
          needs_review: 0,
          skipped_other: 0,
        },
        {
          list_id: 'list-2',
          list_name: 'B',
          saved_companies: 0,
          saved_people: 2,
          needs_review: 1,
          skipped_other: 0,
        },
      ],
    }
    await mount([assistant([toolPart('save_prospect_entries', split, 'call-split')])])
    expect(readScoutActivity('list-1')?.lastSave).toMatchObject({
      saved_companies: 1,
      saved_people: 0,
      needs_review: 0,
    })
    expect(readScoutActivity('list-2')?.lastSave).toMatchObject({
      saved_companies: 0,
      saved_people: 2,
      needs_review: 1,
    })
    await unmount()
  })

  it('folds a PUBLISH into the same per-list counts, marked published', async () => {
    // The page tells a save and a publish with one banner; `published` is
    // what decides whether it says "saved to the list" or "added to your CRM".
    await mount([
      assistant([
        toolPart(
          'publish_prospect_list',
          { ...saveOutput('list-1'), published: true, list_id: 'list-1', list_name: 'Series A fintech' },
          'call-pub',
        ),
      ]),
    ])
    expect(readScoutActivity('list-1')?.lastSave).toMatchObject({
      toolCallId: 'call-pub',
      published: true,
      saved_companies: 2,
      saved_people: 1,
    })
    await unmount()
  })

  it('falls back to the per-item list_id when by_list is absent', async () => {
    const noRollup = { ...saveOutput('list-1'), by_list: undefined, list_ids: undefined }
    await mount([assistant([toolPart('save_prospect_entries', noRollup, 'call-save')])])
    expect(readScoutActivity('list-1')?.lastSave).toEqual({
      toolCallId: 'call-save', published: false,
      saved_companies: 2,
      saved_people: 1,
      needs_review: 1,
      skipped_other: 1,
      sequenceable_count: 1,
    })
    await unmount()
  })

  it('attaches the enroll to the list this conversation just saved to', async () => {
    await mount([
      assistant([
        toolPart('run_prospect_discovery', DISCOVERY),
        toolPart('save_prospect_entries', saveOutput('list-1'), 'call-save'),
      ]),
      assistant([toolPart('enroll_contacts_in_sequence', ENROLL, 'call-enroll')]),
    ])
    expect(readScoutActivity('list-1')?.lastEnroll).toEqual({
      toolCallId: 'call-enroll',
      sequence_id: 'seq-1',
      sequence_name: 'Q4 Outbound',
      enrolled_count: 2,
      skipped_count: 1,
    })
    await unmount()
  })

  it('an enroll with no preceding save in this conversation attaches to nothing', async () => {
    await mount([assistant([toolPart('enroll_contacts_in_sequence', ENROLL, 'call-enroll')])])
    expect(readScoutActivity('list-1')).toBeNull()
    await unmount()
  })

  it('carries a dismiss’s updated count', async () => {
    await mount([
      assistant([
        toolPart(
          'dismiss_prospect_entries',
          { success: true, updated: 4, failed: [], list_ids: ['list-1'] },
          'call-dismiss',
        ),
      ]),
    ])
    expect(readScoutActivity('list-1')?.lastDismiss).toEqual({
      toolCallId: 'call-dismiss',
      updated: 4,
    })
    await unmount()
  })

  it('ignores a tool call that has not returned yet', async () => {
    await mount([
      assistant([
        {
          type: 'tool-save_prospect_entries',
          toolCallId: 'call-pending',
          state: 'input-available',
          input: {},
        },
      ]),
    ])
    expect(readScoutActivity('list-1')).toBeNull()
    await unmount()
  })

  /**
   * The resume trap: handleLoadConversation replays the whole transcript
   * through setMessages. Re-rendering with the SAME history must not look like
   * new work, or the list page refetches (and re-tells the save story) on every
   * reopened tab.
   */
  it('version bumps only for toolCallIds this mount has not seen', async () => {
    const first = [
      assistant([toolPart('save_prospect_entries', saveOutput('list-1'), 'call-save')], 'm1'),
    ]
    await mount(first)
    expect(readScoutActivity('list-1')?.version).toBe(1)

    // Same history, replayed — nothing new happened.
    await rerender([...first])
    expect(readScoutActivity('list-1')?.version).toBe(1)

    // A genuinely new call does bump it.
    await rerender([
      ...first,
      assistant([toolPart('enroll_contacts_in_sequence', ENROLL, 'call-enroll')], 'm2'),
    ])
    expect(readScoutActivity('list-1')?.version).toBe(2)
    expect(readScoutActivity('list-1')?.lastEnroll?.sequence_name).toBe('Q4 Outbound')
    await unmount()
  })

  it('unmount withdraws this panel’s contribution for every list it touched', async () => {
    await mount([
      assistant([
        toolPart('run_prospect_discovery', DISCOVERY, 'call-run'),
        toolPart('save_prospect_entries', saveOutput('list-2'), 'call-save'),
      ]),
    ])
    expect(readScoutActivity('list-1')).not.toBeNull()
    expect(readScoutActivity('list-2')).not.toBeNull()

    await unmount()
    expect(readScoutActivity('list-1')).toBeNull()
    expect(readScoutActivity('list-2')).toBeNull()
  })
})
