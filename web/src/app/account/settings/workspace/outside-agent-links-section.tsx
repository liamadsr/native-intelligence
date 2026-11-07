'use client'

import { useEffect, useState } from 'react'
import { Bot, Loader2 } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

/**
 * The workspace admin's switch for agent links with people outside the
 * workspace (agent links decision 5; /api/account/workspace/outside-agent-links).
 * On by default. Turning it off ends those links, so it asks first. Members
 * see it read-only.
 */
export function OutsideAgentLinksSection() {
  const [state, setState] = useState<{ allowed: boolean; canEdit: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    let live = true
    fetch('/api/account/workspace/outside-agent-links')
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { allowed: boolean; canEdit: boolean } | null) => {
        if (live && data) setState({ allowed: data.allowed, canEdit: data.canEdit })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  async function save(allowed: boolean) {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const res = await fetch('/api/account/workspace/outside-agent-links', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowed }),
      })
      const data = (await res.json().catch(() => ({}))) as { allowed?: boolean; ended?: number; error?: string }
      if (!res.ok) throw new Error(data.error ?? 'Could not save')
      setState((s) => (s ? { ...s, allowed } : s))
      if (!allowed && data.ended) setNote(`Ended ${data.ended} ${data.ended === 1 ? 'link' : 'links'} with people outside this workspace.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save')
    } finally {
      setBusy(false)
    }
  }

  if (!state) return null

  return (
    <div className="mt-10" data-outside-agent-links>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Bot className="h-4 w-4" />
        Agents
      </div>
      <Separator className="mt-2 mb-4" />

      <div className="rounded-lg border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Agents outside this workspace</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Members can connect their agent with Dial8 users in other workspaces, so the two agents can ask each other things. Each member still
              chooses who and what. Links between members of this workspace aren&apos;t affected.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
            <Switch
              checked={state.allowed}
              disabled={!state.canEdit || busy}
              aria-label="Agents outside this workspace"
              onCheckedChange={(val) => (val ? save(true) : setConfirming(true))}
            />
          </div>
        </div>
      </div>
      {error && <p className="mt-1.5 text-sm text-destructive">{error}</p>}
      {note && <p className="mt-1.5 text-sm text-muted-foreground">{note}</p>}

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off agents outside this workspace?</AlertDialogTitle>
            <AlertDialogDescription>
              Links your members have with people outside this workspace end now, for both sides, and new ones can&apos;t be made until you turn this
              back on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                void save(false)
              }}
            >
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
