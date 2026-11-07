'use client'

/**
 * The workspace a composer reads its lists in: the skills its "/" picker and
 * chips offer, and the captures, people and companies its "@" picker finds.
 *
 * The main chat's composer reads the window's workspace (no provider: null).
 * A conversation that isn't the main chat can belong to another workspace
 * than the window's (a teammate's thread, a run's chat: the bot crew spans
 * workspaces), and its turn is checked there server-side, so its composer
 * names that workspace (ConversationComposer provides it) and the lists come
 * from it: a skill or a mention picked there is one the turn can use.
 */
import { createContext, useContext } from 'react'

export const ComposerWorkspaceContext = createContext<string | null>(null)

/** The workspace this composer's lists are read in (null: the window's). */
export function useComposerWorkspace(): string | null {
  return useContext(ComposerWorkspaceContext)
}

/** The header that reads a list in `workspaceId` ({} for the window's, which the fetch interceptor names). */
export function composerWorkspaceHeaders(workspaceId: string | null): Record<string, string> {
  return workspaceId ? { 'x-workspace-id': workspaceId } : {}
}
