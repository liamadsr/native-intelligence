'use client'

/**
 * The user's assistant name (./assistant-name), kept on the account so each
 * account has its own on every device (`user_metadata.assistant_name`), with a
 * copy on this device in localStorage (ASSISTANT_NAME_STORAGE_KEY) that is
 * read synchronously, never fetched, so the wake word works the moment
 * Interactive mode listens, offline or not (Liam, 2026-10-02: "it should not
 * be dependent on anything else"). The copy follows the account
 * (lib/account-setting.ts). Another Dial8 window adopting or saving a name
 * arrives as a `storage` event. Wherever neither holds a name (or storage
 * can't be read: a private window, blocked site data), the name is the
 * default, DEFAULT_ASSISTANT_NAME.
 *
 * Interactive mode reads it each time it checks a transcript for the wake word
 * (getAssistantName), so a new name applies from the next thing said; the
 * dashboard puts a saved one on each chat turn's systemContext
 * (`assistantName`), which is how the chat agent knows it.
 */

import { useSyncExternalStore } from 'react'
import { createAccountSetting } from '../account-setting'
import {
  ASSISTANT_NAME_PROFILE_FIELD,
  ASSISTANT_NAME_STORAGE_KEY,
  DEFAULT_ASSISTANT_NAME,
  checkAssistantName,
  sanitizeAssistantName,
  type AssistantNameCheck,
} from './assistant-name'

interface NameState {
  /** The name in effect. */
  name: string
  /** The user saved this name (false: the default stands in). */
  saved: boolean
  /** Always true: a local read never waits (kept for the settings field). */
  loaded: boolean
}

const DEFAULT_STATE: NameState = Object.freeze({ name: DEFAULT_ASSISTANT_NAME, saved: false, loaded: true }) as NameState

const setting = createAccountSetting<string>({
  field: ASSISTANT_NAME_PROFILE_FIELD,
  storageKey: ASSISTANT_NAME_STORAGE_KEY,
  parse: sanitizeAssistantName,
  same: (a, b) => a === b,
})

/** The state for the saved name it was made from, kept while that name stands. */
let derived: { from: string | null; state: NameState } | null = null

function current(): NameState {
  const saved = setting.get()
  if (!derived || derived.from !== saved) {
    derived = { from: saved, state: saved ? { name: saved, saved: true, loaded: true } : DEFAULT_STATE }
  }
  return derived.state
}

const getServerState = () => DEFAULT_STATE

/** The assistant's name in effect now (the saved one, else the default). */
export function getAssistantName(): string {
  return current().name
}

/** The name the user saved, or null while the default stands in. */
export function getSavedAssistantName(): string | null {
  return setting.get()
}

/** Kept for callers that warm the store up front: a local read needs nothing. */
export function ensureAssistantNameLoaded(): void {
  current()
}

/** The assistant's name and whether the user saved it, live. */
export function useAssistantName(): NameState {
  return useSyncExternalStore(setting.subscribe, current, getServerState)
}

/** Save a typed name to the account. Resolves with the tidied name, or why it
 *  wasn't saved (invalid, or the account didn't take it). */
export async function saveAssistantName(raw: string): Promise<AssistantNameCheck> {
  const checked = checkAssistantName(raw)
  if (!checked.ok) return checked
  if (!(await setting.save(checked.name))) return { ok: false, error: 'Couldn’t save the name. Try again.' }
  return checked
}

/** Tests only: a fresh page (read again from storage on next use). */
export function __resetAssistantNameForTests(): void {
  setting.resetForTests()
  derived = null
}
