'use client'

import { createContext, useContext } from 'react'

/**
 * Whether live identifier chips are active in this subtree. Chips are ON by
 * default; a public / unauthenticated surface (the shared-view page) wraps its
 * Markdown in `<EntityRefsProvider enabled={false}>` so a share never calls the
 * authenticated resolve endpoint.
 */
const EntityRefsEnabledContext = createContext<boolean>(true)

export function EntityRefsProvider({
  enabled,
  children,
}: {
  enabled: boolean
  children: React.ReactNode
}) {
  return (
    <EntityRefsEnabledContext.Provider value={enabled}>
      {children}
    </EntityRefsEnabledContext.Provider>
  )
}

export function useEntityRefsEnabled(): boolean {
  return useContext(EntityRefsEnabledContext)
}
