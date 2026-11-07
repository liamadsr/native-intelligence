'use client'

/**
 * The agent's own chat as a hand-off (one face, docs/plans/always-on-agent.md
 * §2c): the person's home thread has ONE Chat in a window, the chat strip's
 * home tab (dashboard-shell.tsx), since two would drift apart and both send
 * (#681). So the agent's face (its bubble, its page, the desktop bubble's
 * relay) mounts none: this stands in for useTeammateChat there, with no
 * messages, and a send opens the home thread in the strip with the text
 * (openHomeThread), sent there as the person's message; the item it's about
 * rides along (a card as `cardIds`, a work item's ids in the text:
 * homeHandoffAbout). Its name is the person's assistant name, else
 * "Assistant".
 */
import { useCallback, useMemo, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { homeHandoffAbout } from '@/lib/chat/teammate-about-ref'
import { handOffToHome, openHomeThread } from '@/lib/chat/home-thread-client'
import { agentName } from '@/lib/bots/agent-face'
import { useAssistantName } from '@/lib/voice/assistant-name-store'
import type { TeammateChat, TeammateSendOptions } from './use-teammate-chat'

const NO_MESSAGES: UIMessage[] = []
const noop = () => {}
const OPEN_HOME_ACTION = { label: 'Open the conversation', run: () => openHomeThread() }

/** The agent's own chat as a hand-off (see the module note). */
export function useHomeHandoff(workspaceId: string | null): TeammateChat {
  const assistant = useAssistantName()
  const name = agentName(assistant.saved ? assistant.name : null)
  // Why the last hand-off didn't go (shown as the chat's error; cleared by one that does).
  const [failure, setFailure] = useState<Error | undefined>(undefined)
  const sendMessage = useCallback(
    async (text: string, opts?: TeammateSendOptions) => {
      const trimmed = text.trim()
      if (!trimmed) return false
      // Sent only once the strip's home thread took it (handOffToHome): the
      // caller keeps the text and says why when it didn't.
      const result = await handOffToHome({ ...homeHandoffAbout(trimmed, opts?.about), workspaceId })
      setFailure(result.ok ? undefined : new Error(result.reason))
      return result.ok
    },
    [workspaceId],
  )
  return useMemo(
    () => ({
      messages: NO_MESSAGES,
      sendMessage,
      status: 'ready' as const,
      stop: noop,
      error: failure,
      conversationId: null,
      workspaceId,
      teammateName: name,
      loading: false,
      note: `Your conversation with ${name} is in the chat: what you send here goes there.`,
      noteAction: OPEN_HOME_ACTION,
    }),
    [sendMessage, workspaceId, name, failure],
  )
}
