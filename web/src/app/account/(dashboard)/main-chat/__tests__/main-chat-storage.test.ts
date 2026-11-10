// @vitest-environment jsdom
/**
 * What the device keeps of the main chat (main-chat-storage.ts):
 *   • one chat per workspace under `ni-chat:<ws>`, read back validated and
 *     bounded, its session id first in the blob;
 *   • the tabs' old keys (`ni-tabs:*`, `ni-tabs-chat:*`,
 *     `ni-tabs-head:*`) swept, while the in-app browser's
 *     `ni-tabs-browser*` stays; with nothing left to sweep it removes nothing;
 *   • the retired local Claude Code pipeline's keys swept once per device,
 *     never the in-app browser's `ni-device-id`;
 *   • no stored mail: a mail tool's output is written as its pointer (ids,
 *     counts), never the bodies or subjects the model saw live.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_LIVE_MESSAGES } from '@/lib/chat/message-retention'
import {
  CLAUDE_CODE_KEYS_SWEPT_KEY,
  readStoredChat,
  storedChatSummary,
  sweepClaudeCodeKeys,
  sweepLegacyTabKeys,
  writeStoredChat,
} from '../main-chat-storage'

const msg = (id: string) => ({ id, role: 'user' as const, parts: [{ type: 'text' as const, text: id }] })

beforeEach(() => localStorage.clear())

describe('the stored chat', () => {
  it('keeps one chat per workspace, its session id first, and reads it back', () => {
    expect(writeStoredChat('ws-1', { chatSessionId: 'sess-1', chatMessages: [msg('m1')] as never, chatInput: 'draft', conversationId: 'home-1' })).toBe(true)
    expect(localStorage.getItem('ni-chat:ws-1')!.startsWith('{"chatSessionId":"sess-1"')).toBe(true)
    expect(readStoredChat('ws-1')).toEqual({ chatSessionId: 'sess-1', chatMessages: [msg('m1')], chatInput: 'draft', conversationId: 'home-1' })
    expect(storedChatSummary('ws-1')).toEqual({ chatSessionId: 'sess-1' })
    expect(readStoredChat('ws-2')).toBeNull()
  })

  it('a corrupt or shapeless blob reads as none', () => {
    localStorage.setItem('ni-chat:ws-1', '{not json')
    expect(readStoredChat('ws-1')).toBeNull()
    localStorage.setItem('ni-chat:ws-1', JSON.stringify({ chatMessages: [] }))
    expect(readStoredChat('ws-1')).toBeNull()
  })

  it('bounds the thread on the way in and out', () => {
    const long = Array.from({ length: MAX_LIVE_MESSAGES + 20 }, (_, i) => msg(`m${i}`))
    writeStoredChat('ws-1', { chatSessionId: 's', chatMessages: long as never, chatInput: '' })
    expect(readStoredChat('ws-1')!.chatMessages).toHaveLength(MAX_LIVE_MESSAGES)
  })

  it('keeps a mail tool output as its pointer, never the mail text', () => {
    const mailTurn = {
      id: 'a1',
      role: 'assistant' as const,
      parts: [
        { type: 'text' as const, text: 'Here it is.' },
        {
          type: 'tool-read_email',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { thread_id: 'thr-1' },
          output: {
            success: true,
            thread_id: 'thr-1',
            message_count: 1,
            messages: [{ message_id: 'm1', subject: 'Offer letter', body_text: 'We are pleased to offer you' }],
          },
        },
      ],
    }
    expect(writeStoredChat('ws-1', { chatSessionId: 's', chatMessages: [msg('m0'), mailTurn] as never, chatInput: '' })).toBe(true)
    const raw = localStorage.getItem('ni-chat:ws-1')!
    expect(raw).not.toContain('Offer letter')
    expect(raw).not.toContain('pleased to offer')
    const [user, assistant] = readStoredChat('ws-1')!.chatMessages as unknown as Array<{ parts: Array<Record<string, unknown>> }>
    expect(user).toEqual(msg('m0'))
    expect(assistant.parts[0]).toEqual({ type: 'text', text: 'Here it is.' })
    expect(assistant.parts[1].output).toEqual({ scrubbed: 'mail', success: true, thread_id: 'thr-1', message_count: 1, message_ids: ['m1'] })
  })
})

describe('sweepLegacyTabKeys', () => {
  it('frees the tabs’ keys once, keeping the browser’s and the main chats’', () => {
    localStorage.setItem('ni-tabs', '{}')
    localStorage.setItem('ni-tabs-chat', '{}')
    localStorage.setItem('ni-tabs:ws-1', JSON.stringify({ tabs: [{ id: 't1' }], activeTabId: 't1' }))
    localStorage.setItem('ni-tabs:last-workspace', JSON.stringify('ws-1'))
    localStorage.setItem('ni-tabs-chat:ws-1:t1', JSON.stringify({ chatSessionId: 'tab-sess', chatMessages: [] }))
    localStorage.setItem('ni-tabs-head:ws-1:t1', JSON.stringify({ chatSessionId: 'tab-sess' }))
    localStorage.setItem('ni-tabs-browser', JSON.stringify([]))
    localStorage.setItem('ni-tabs-browser-routing:ws-1', '{}')
    writeStoredChat('ws-2', { chatSessionId: 'kept-sess', chatMessages: [], chatInput: '' })

    expect(sweepLegacyTabKeys()).toBe(6)
    expect(Object.keys(localStorage).sort()).toEqual([
      'ni-chat:ws-2',
      'ni-tabs-browser',
      'ni-tabs-browser-routing:ws-1',
    ])
  })

  it('with no tab key left removes nothing', () => {
    writeStoredChat('ws-1', { chatSessionId: 's', chatMessages: [], chatInput: '' })
    expect(sweepLegacyTabKeys()).toBe(0)
    expect(Object.keys(localStorage)).toEqual(['ni-chat:ws-1'])
  })

  it('frees the copies the storage rename script left under the old names too', () => {
    for (const key of ['ni-tabs', 'dial8-tabs', 'ni-tabs:ws-1', 'dial8-tabs:ws-1', 'dial8-tabs-chat:ws-1:t1', 'dial8-tabs-head:ws-1:t1']) localStorage.setItem(key, '{}')
    // Not the tabs': the browser's saved tabs, a main chat, and a key that only contains the old name.
    for (const key of ['dial8-tabs-browser', 'dial8-chat:ws-2', 'x-dial8-tabs:ws-1']) localStorage.setItem(key, '{}')
    expect(sweepLegacyTabKeys()).toBe(6)
    expect(Object.keys(localStorage).sort()).toEqual(['dial8-chat:ws-2', 'dial8-tabs-browser', 'x-dial8-tabs:ws-1'])
  })
})

describe('sweepClaudeCodeKeys', () => {
  const CC_KEYS = [
    'ni_chat_use_claude_code',
    'ni_claude_live_session_enabled',
    'ni_claude_mcp_configured',
    'ni_claude_mcp_strict',
    'ni_claude_code_model',
    'ni_claude_session:sess-1',
    'ni_device_id',
    'ni_claude_code_enabled',
    'ni_preferred_terminal',
    'ni_claude_directory',
    'ni_claude_dir_history',
    'ni_claude_system_prompt',
  ]

  it('removes every key the local Claude Code pipeline wrote, and nothing else', () => {
    for (const key of CC_KEYS) localStorage.setItem(key, 'x')
    // The in-app browser's own device id and saved tabs stay.
    localStorage.setItem('ni-device-id', 'browser-device')
    localStorage.setItem('ni-tabs-browser', JSON.stringify([]))
    localStorage.setItem('ni-tabs-browser-routing:ws-1', '{}')
    writeStoredChat('ws-1', { chatSessionId: 's', chatMessages: [], chatInput: '' })

    expect(sweepClaudeCodeKeys()).toBe(CC_KEYS.length)
    expect(Object.keys(localStorage).sort()).toEqual(
      [CLAUDE_CODE_KEYS_SWEPT_KEY, 'ni-chat:ws-1', 'ni-device-id', 'ni-tabs-browser', 'ni-tabs-browser-routing:ws-1'].sort(),
    )
  })

  it('removes the copies the storage rename script left under the old names too', () => {
    for (const key of ['ni_claude_directory', 'dial8_claude_directory', 'dial8_claude_session:sess-1', 'dial8_device_id', 'dial8_chat_use_claude_code']) localStorage.setItem(key, 'x')
    // Someone else's: the browser's device id, and an older build's own swept flag.
    localStorage.setItem('dial8-device-id', 'browser-device')
    localStorage.setItem('dial8:claude-code-keys-swept', '1')
    expect(sweepClaudeCodeKeys()).toBe(5)
    expect(Object.keys(localStorage).sort()).toEqual([CLAUDE_CODE_KEYS_SWEPT_KEY, 'dial8-device-id', 'dial8:claude-code-keys-swept'].sort())
  })

  it('runs once per device: a later boot walks nothing', () => {
    localStorage.setItem('ni_device_id', 'd1')
    expect(sweepClaudeCodeKeys()).toBe(1)
    localStorage.setItem('ni_device_id', 'd2')
    expect(sweepClaudeCodeKeys()).toBe(0)
    expect(localStorage.getItem('ni_device_id')).toBe('d2')
  })
})
