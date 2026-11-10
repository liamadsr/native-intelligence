// @vitest-environment jsdom
/**
 * The shared composer state's pure pieces (composer-state.ts): what a send
 * builds from the attachments, and how a conversation that isn't the main
 * chat sends a turn's extras (bots v4):
 *   - a teammate's thread as the main chat does (its body: the turn's system
 *     context, the skill; no agent; no search settings: the agent picks each
 *     search's scope);
 *   - a run's chat as the run-chat route reads it (the skill, the uploads, the
 *     mentions).
 * Neither carries a model or a thinking level: the server picks the model per
 * turn. And the old picker's remembered thinking levels are dropped once.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  STALE_THINKING_STORAGE_KEY,
  attachedFilesText,
  chatAgentTurnBody,
  chatFilesMeta,
  chatFileUIParts,
  readyChatFiles,
  runChatTurnBody,
  type ComposerTurnExtras,
} from '../composer-state'
import type { ChatFileAttachment } from '../chat-panel'

const file = (name: string, type: string, size = 10) => new File(['x'.repeat(size)], name, { type })

const attachments: ChatFileAttachment[] = [
  { id: 'a', file: file('shot.png', 'image/png'), status: 'ready', url: 'https://s/shot.png', storagePath: 'u/chat-uploads/a.png' },
  { id: 'b', file: file('notes.md', 'text/markdown'), status: 'uploading' },
  { id: 'c', file: file('bad.exe', 'application/x-msdownload'), status: 'error', error: 'nope' },
]

const extras = (over: Partial<ComposerTurnExtras> = {}): ComposerTurnExtras => ({
  files: [],
  chatFiles: [],
  mentions: { noteIds: [], contactIds: [], companyIds: [] },
  skill: null,
  isDesktopClient: false,
  ...over,
})

describe('the attachments a send takes', () => {
  it('only the ready ones, as file parts and as storage facts', () => {
    const ready = readyChatFiles(attachments)
    expect(ready.map((f) => f.id)).toEqual(['a'])
    expect(chatFileUIParts(ready)).toEqual([{ type: 'file', mediaType: 'image/png', filename: 'shot.png', url: 'https://s/shot.png' }])
    expect(chatFilesMeta(ready)).toEqual([{ storagePath: 'u/chat-uploads/a.png', fileName: 'shot.png', fileSize: 10, mimeType: 'image/png' }])
  })

  it('a files-only turn reads as the main chat’s', () => {
    expect(attachedFilesText(1)).toBe('[Attached 1 file]')
    expect(attachedFilesText(3)).toBe('[Attached 3 files]')
  })
})

describe('chatAgentTurnBody — a teammate’s thread sends as the main chat does', () => {
  it('a bare turn: an empty system context, nothing else (no search settings)', () => {
    expect(chatAgentTurnBody(extras())).toEqual({
      systemContext: {},
    })
  })

  it('everything: the mentions and uploads in the system context, the skill (never a model)', () => {
    const body = chatAgentTurnBody(
      extras({
        mentions: { noteIds: ['n1'], contactIds: ['p1'], companyIds: ['c1'] },
        chatFiles: [{ storagePath: 'u/chat-uploads/a.png', fileName: 'shot.png', fileSize: 10, mimeType: 'image/png' }],
        skill: { id: 'skill-1', slug: 'brief', name: 'Brief' },
        isDesktopClient: true,
      }),
    )
    expect(body).toEqual({
      systemContext: {
        isDesktopClient: true,
        attachedNoteIds: ['n1'],
        attachedContactIds: ['p1'],
        attachedCompanyIds: ['c1'],
        chatFiles: [{ storagePath: 'u/chat-uploads/a.png', fileName: 'shot.png', fileSize: 10, mimeType: 'image/png' }],
      },
      skillId: 'skill-1',
    })
    // A teammate is its own agent: no agent ever rides it.
    expect(body).not.toHaveProperty('agentId')
  })

  it('the mentioned actions, docs, projects and initiatives: their ids by kind, as the main chat sends them', () => {
    const body = chatAgentTurnBody(
      extras({
        mentions: {
          noteIds: [],
          contactIds: [],
          companyIds: [],
          records: [
            { kind: 'action', id: 'a1', title: 'Pricing', identifier: 'GEN-42' },
            { kind: 'document', id: 'd1', title: 'Pricing v3' },
            { kind: 'action', id: 'a2', title: 'Ship' },
          ],
        },
      }),
    )
    expect(body).toEqual({ systemContext: { attachedActionIds: ['a1', 'a2'], attachedDocumentIds: ['d1'] } })
  })
})

describe('runChatTurnBody — a run’s chat sends what its route reads', () => {
  it('a bare turn carries nothing', () => {
    expect(runChatTurnBody(extras())).toEqual({})
  })

  it('everything: the skill, the uploads and the mentions', () => {
    const body = runChatTurnBody(
      extras({
        mentions: { noteIds: ['n1'], contactIds: [], companyIds: ['c1'] },
        chatFiles: [{ storagePath: 'u/chat-uploads/a.md', fileName: 'a.md', fileSize: 4, mimeType: 'text/markdown' }],
        skill: { id: 'skill-1', slug: 'brief', name: 'Brief' },
      }),
    )
    expect(body).toEqual({
      skillId: 'skill-1',
      files: [{ storagePath: 'u/chat-uploads/a.md', fileName: 'a.md', fileSize: 4, mimeType: 'text/markdown' }],
      mentions: { captureIds: ['n1'], companyIds: ['c1'] },
    })
    expect(body).not.toHaveProperty('model')
    expect(body).not.toHaveProperty('searchSettings')
    expect(body).not.toHaveProperty('thinking')
  })

  it('the mentioned records under the keys the run-chat parser reads; records alone are mentions', () => {
    expect(
      runChatTurnBody(
        extras({
          mentions: {
            noteIds: [],
            contactIds: [],
            companyIds: [],
            records: [
              { kind: 'project', id: 'p1', title: 'Website' },
              { kind: 'initiative', id: 'i1', title: 'Q4' },
            ],
          },
        }),
      ),
    ).toEqual({ mentions: { projectIds: ['p1'], initiativeIds: ['i1'] } })
  })
})

describe('clearStaleModelPicks — the old picker’s thinking levels go once', () => {
  it('removes ni.chat.thinking on the first call, and only then', async () => {
    vi.resetModules()
    const { clearStaleModelPicks } = await import('../composer-state')
    expect(STALE_THINKING_STORAGE_KEY).toBe('ni.chat.thinking')
    localStorage.setItem('ni.chat.thinking', JSON.stringify({ 'deepseek-v4-flash': 'max' }))
    localStorage.setItem('ni.other', 'kept')
    clearStaleModelPicks()
    expect(localStorage.getItem('ni.chat.thinking')).toBeNull()
    expect(localStorage.getItem('ni.other')).toBe('kept')
    // Once per page load: a later write (nothing writes it now) is left alone.
    localStorage.setItem('ni.chat.thinking', '{}')
    clearStaleModelPicks()
    expect(localStorage.getItem('ni.chat.thinking')).toBe('{}')
    localStorage.clear()
  })

  it('storage that throws is left alone, never a crash', async () => {
    vi.resetModules()
    const { clearStaleModelPicks } = await import('../composer-state')
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => clearStaleModelPicks()).not.toThrow()
    spy.mockRestore()
  })
})
