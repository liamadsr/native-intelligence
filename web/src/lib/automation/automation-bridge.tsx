'use client'

import { useEffect, useRef } from 'react'
import { activeComposer } from '@/app/account/(dashboard)/chat/active-composer'
import { useMainChatActions } from '@/app/account/(dashboard)/main-chat/main-chat-context'
import { storedChatSummary } from '@/app/account/(dashboard)/main-chat/main-chat-storage'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { createClient } from '@/lib/supabase/client'
import { createAutomationApi } from './api'

/**
 * Registers `window.__niAutomation` (README.md) for as long as it is
 * mounted, inside the dashboard's providers so the API reads the same state
 * the app does. Loaded on demand by AutomationMount, only when flagged.
 */
export function AutomationBridge() {
  const { readChat, resetChat } = useMainChatActions()
  const workspaceId = useWorkspaceId()
  const workspaceRef = useRef(workspaceId)
  workspaceRef.current = workspaceId

  useEffect(() => {
    const api = createAutomationApi({
      workspaceId: () => workspaceRef.current,
      signedIn: async () => {
        try {
          const { data } = await createClient().auth.getSession()
          return !!data.session
        } catch {
          return false
        }
      },
      chat: () => ({ chatSessionId: readChat().chatSessionId }),
      resetChat,
      storedChat: storedChatSummary,
      composer: () => activeComposer()?.querySelector<HTMLTextAreaElement>('[data-testid="chat-composer-input"]') ?? null,
    })
    window.__niAutomation = api
    // TODO(rename-compat): the older name, for a recorder written before the rename (flag.ts).
    window.__dial8Automation = api
    return () => {
      if (window.__niAutomation === api) delete window.__niAutomation
      if (window.__dial8Automation === api) delete window.__dial8Automation
    }
  }, [readChat, resetChat])

  return null
}
