'use client'

import { useSyncExternalStore } from 'react'
import { getCodeView, subscribeCodeView, type CodeViewState } from './code-view-store'

const SERVER: CodeViewState = { selected: null, live: null, error: null, attempt: 0 }
const getServer = () => SERVER

/** The Code view's selected coding chat, live (code-view-store.ts). */
export function useCodeView(): CodeViewState {
  return useSyncExternalStore(subscribeCodeView, getCodeView, getServer)
}
