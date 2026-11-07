'use client'

/**
 * The agent's look (./agent-look), kept on the account like the agent's name
 * (lib/voice/assistant-name-store.ts), so each account has its own on every
 * device: `user_metadata.agent_look`, with a copy on this device in
 * localStorage (AGENT_LOOK_STORAGE_KEY) that is read synchronously, never
 * waited on (lib/account-setting.ts). Another Dial8 window adopting or saving
 * a look arrives as a `storage` event. Wherever neither holds a look, the
 * default stands in (DEFAULT_AGENT_LOOK).
 */
import { useSyncExternalStore } from 'react'
import { createAccountSetting } from '../account-setting'
import { AGENT_LOOK_PROFILE_FIELD, DEFAULT_AGENT_LOOK, parseAgentLook, sameAgentLook, type AgentLook } from './agent-look'

/** Where this device keeps its copy of the look. */
export const AGENT_LOOK_STORAGE_KEY = 'dial8:agent-look'

const setting = createAccountSetting<AgentLook>({
  field: AGENT_LOOK_PROFILE_FIELD,
  storageKey: AGENT_LOOK_STORAGE_KEY,
  parse: parseAgentLook,
  same: sameAgentLook,
})

const current = () => setting.get() ?? DEFAULT_AGENT_LOOK
const getServerState = () => DEFAULT_AGENT_LOOK

/** The agent's look, live. */
export function useAgentLook(): AgentLook {
  return useSyncExternalStore(setting.subscribe, current, getServerState)
}

/** Save a look to the account; false when it wasn't taken (the old look stays). */
export function saveAgentLook(look: AgentLook): Promise<boolean> {
  return setting.save(look)
}

/** Tests only: a fresh page (read again from storage on next use). */
export function __resetAgentLookForTests(): void {
  setting.resetForTests()
}
