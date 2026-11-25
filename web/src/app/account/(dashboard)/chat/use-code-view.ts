'use client'

import { useSyncExternalStore } from 'react'
import { getCodeView, subscribeCodeView, type CodeViewState } from './code-chat-live'

const SERVER: CodeViewState = { selected: null, live: null, error: null, attempt: 0 }
const getServer = () => SERVER

/** The Code view's selected coding chat, live (code-chat-live.ts). */
export function useCodeView(): CodeViewState {
  return useSyncExternalStore(subscribeCodeView, getCodeView, getServer)
}
