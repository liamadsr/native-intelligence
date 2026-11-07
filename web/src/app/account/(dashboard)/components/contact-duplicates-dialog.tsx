'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Loader2, Users } from 'lucide-react'

interface DuplicateCandidate {
  id: string
  full_name: string | null
  email: string | null
  secondary_emails: string[]
  tier: 'auto' | 'suggest'
  match_type: string
  score: number
  reasons: string[]
}

interface ContactDuplicatesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  contactId: string
  contactName: string
  /** Called after a successful merge so the parent can refresh the contact. */
  onMerged: () => void
}

export function ContactDuplicatesDialog({
  open,
  onOpenChange,
  contactId,
  contactName,
  onMerged,
}: ContactDuplicatesDialogProps) {
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([])
  const [mergingId, setMergingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/contacts/${contactId}/duplicates`)
      if (res.ok) {
        const data = await res.json()
        setCandidates(data.duplicates || [])
      } else {
        setError('Could not load duplicates.')
      }
    } catch {
      setError('Could not load duplicates.')
    }
    setLoading(false)
  }, [contactId])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  async function handleMerge(sourceId: string) {
    setMergingId(sourceId)
    setError(null)
    try {
      const res = await fetch(`/api/account/contacts/${contactId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_id: sourceId }),
      })
      if (res.ok) {
        setCandidates((prev) => prev.filter((c) => c.id !== sourceId))
        onMerged()
      } else {
        const data = await res.json().catch(() => ({}))
        setError(data.error || 'Merge failed.')
      }
    } catch {
      setError('Merge failed.')
    }
    setMergingId(null)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-4 w-4" />
            Possible duplicates
          </DialogTitle>
          <DialogDescription>
            Other contacts that look like the same person as{' '}
            <span className="font-medium text-foreground">{contactName}</span>. Merging keeps this
            contact and folds the other&apos;s emails, meetings and history into it.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Scanning…
          </div>
        ) : candidates.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No likely duplicates found.</p>
        ) : (
          <div className="max-h-[55vh] space-y-2 overflow-y-auto">
            {candidates.map((c) => (
              <div
                key={c.id}
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{c.full_name || 'Unnamed contact'}</span>
                    {c.tier === 'auto' && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">Strong match</Badge>
                    )}
                  </div>
                  {c.email && <p className="truncate text-xs text-muted-foreground">{c.email}</p>}
                  {c.secondary_emails?.length > 0 && (
                    <p className="truncate text-xs text-muted-foreground">
                      +{c.secondary_emails.join(', ')}
                    </p>
                  )}
                  {c.reasons?.length > 0 && (
                    <p className="mt-1 text-[11px] text-muted-foreground">{c.reasons.join(' · ')}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={mergingId !== null}
                  onClick={() => handleMerge(c.id)}
                >
                  {mergingId === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Merge'}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
