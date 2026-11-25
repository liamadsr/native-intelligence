// @vitest-environment jsdom
/**
 * A coding chat's row in Recent (home-recents.tsx openRecent) opens it
 * through the current chat's one way in (chat/current-chat-store.ts): the
 * current chat IS that chat, so the composer's tab follows it. Before, the
 * row set the Code view and the chat by themselves and the composer stayed on
 * the agent: its box under a coding chat (docs/plans/one-home.md, "Today").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/workspace-fetch', () => ({ getClientWorkspaceId: () => 'ws-1' }))
vi.mock('@/components/desktop-titlebar', () => ({ useHasTrafficLights: () => false, useIsDesktop: () => false }))
vi.mock('@/components/files/global-file-viewer', () => ({ openAttachmentById: vi.fn() }))

import { openRecent } from '../home-recents'
import { __resetCurrentChatForTests, getCurrentChat } from '../../chat/current-chat-store'
import { __resetCodeViewForTests } from '../../chat/code-view-store'
import { getSidePanelState, resetSidePanelStore } from '../../side-panels/side-panel-store'

beforeEach(() => {
  localStorage.clear()
  resetSidePanelStore()
  __resetCodeViewForTests()
  __resetCurrentChatForTests()
})
afterEach(() => {
  __resetCurrentChatForTests()
  __resetCodeViewForTests()
  resetSidePanelStore()
})

describe('a coding chat’s row in Recent', () => {
  it('makes it the current chat, through the one way in', () => {
    expect(openRecent({ type: 'code_job', id: 'sess-7', title: 'Fix the export' })).toBe(true)
    expect(getCurrentChat()).toEqual({ kind: 'code', sessionId: 'sess-7' })
    // The panels' mirror agrees: the view and the chat, set together.
    expect(getSidePanelState().codeView).toBe(true)
    expect(getSidePanelState().codeChat).toBe(true)
  })
})
