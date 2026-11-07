'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { useEntityListSync } from '@/hooks/use-entity-sync'

interface Team {
  id: string
  name: string
  slug: string
  icon: string | null
  issue_prefix: string
  is_private: boolean
  member_count: number
  created_at: string
}

interface TeamsContextValue {
  teams: Team[]
  loading: boolean
  refetchTeams: () => Promise<void>
}

const TeamsCtx = createContext<TeamsContextValue>({
  teams: [],
  loading: true,
  refetchTeams: async () => {},
})

export function TeamsProvider({ children }: { children: React.ReactNode }) {
  const [teams, setTeams] = useState<Team[]>([])
  const [loading, setLoading] = useState(true)
  const workspaceId = useWorkspaceId()
  const prevWorkspaceRef = useRef(workspaceId)
  const initialFetchDone = useRef(false)

  // Only the latest call may write: a slow response for the previous
  // workspace must not land over the one fetched after a switch.
  const fetchSeqRef = useRef(0)
  const fetchTeams = useCallback(async () => {
    const seq = ++fetchSeqRef.current
    setLoading(true)
    try {
      const res = await fetch('/api/account/teams')
      if (res.ok) {
        const data = await res.json()
        if (seq === fetchSeqRef.current) setTeams(data.teams)
      }
    } catch (err) {
      // Offline / server unreachable: keep the list, never leave `loading` stuck.
      console.warn('[teams] fetch failed (network)', err)
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false)
    }
  }, [])

  // Silent refetch for background live-sync: updates the teams list WITHOUT
  // flipping `loading`. workspace-transition.tsx uses `loading` as its reveal
  // cue, so a background team event must not re-trigger that overlay.
  // It also runs fire-and-forget from a debounced entity-event timer, so a
  // rejected fetch (offline / server unreachable, seen in the desktop app)
  // would otherwise be an unhandled rejection in Next's dev overlay. Swallow
  // it: the stale list stays put and the next team event retries.
  const syncTeams = useCallback(async () => {
    try {
      const res = await fetch('/api/account/teams')
      if (res.ok) {
        const data = await res.json()
        setTeams(data.teams)
      }
    } catch (err) {
      console.warn('[teams] background sync failed (network)', err)
    }
  }, [])

  // A team (or team_member, which the realtime core maps to kind 'team')
  // created, renamed, or deleted elsewhere — an MCP tool, a teammate, another
  // tab — updates the shared teams list that drives the whole nav.
  useEntityListSync(['team'], syncTeams, { debounceMs: 500 })

  // Initial fetch (guarded against Strict Mode double-invoke)
  useEffect(() => {
    if (initialFetchDone.current) return
    initialFetchDone.current = true
    fetchTeams()
  }, [fetchTeams])

  // Re-fetch when workspace changes — clear stale teams immediately so
  // consumers don't read team IDs from the old workspace during the fetch.
  useEffect(() => {
    if (prevWorkspaceRef.current !== workspaceId && workspaceId) {
      prevWorkspaceRef.current = workspaceId
      setTeams([])
      fetchTeams()
    }
  }, [workspaceId, fetchTeams])

  // Memoized so a TeamsProvider re-render (e.g. its parent re-rendering) does
  // not hand every useTeams() consumer a fresh object and re-render them all.
  // fetchTeams is a stable useCallback([]), so only teams / loading change it.
  const value = useMemo<TeamsContextValue>(
    () => ({ teams, loading, refetchTeams: fetchTeams }),
    [teams, loading, fetchTeams],
  )

  return <TeamsCtx.Provider value={value}>{children}</TeamsCtx.Provider>
}

export function useTeams() {
  return useContext(TeamsCtx)
}
