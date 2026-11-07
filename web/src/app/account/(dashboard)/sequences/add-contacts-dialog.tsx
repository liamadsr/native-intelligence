'use client'

/**
 * "Add contacts" picker on the sequence detail page: search workspace
 * contacts (only ones with an email are selectable), multi-select, enroll,
 * then toast the per-reason skip summary from the enroll response.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { SequenceStatus } from '@/lib/sequences/types'
import { summarizeEnrollResult } from '@/lib/sequences/ui-helpers'
import { enrollContacts } from './api'

interface ContactOption {
  id: string
  full_name: string | null
  email: string | null
}

export function AddContactsDialog({
  sequenceId,
  sequenceStatus,
  open,
  onOpenChange,
  onEnrolled,
}: {
  sequenceId: string
  /** Enrolling into an already-launched sequence only STAGES contacts (they
   *  are inert until Review & launch runs again) — the toast must say so. */
  sequenceStatus: SequenceStatus
  open: boolean
  onOpenChange: (open: boolean) => void
  onEnrolled: () => void
}) {
  const [search, setSearch] = useState('')
  const [options, setOptions] = useState<ContactOption[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<Map<string, ContactOption>>(new Map())
  const [enrolling, setEnrolling] = useState(false)
  const requestSeq = useRef(0)

  // Debounced server-side search (the contacts list is workspace-sized).
  useEffect(() => {
    if (!open) return
    const seq = ++requestSeq.current
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ limit: '50' })
        if (search.trim()) params.set('search', search.trim())
        const res = await fetch(`/api/account/contacts?${params}`)
        if (!res.ok) return
        const data = (await res.json()) as { contacts: ContactOption[] }
        if (requestSeq.current === seq) setOptions(data.contacts ?? [])
      } finally {
        if (requestSeq.current === seq) setLoading(false)
      }
    }, 200)
    return () => clearTimeout(timer)
  }, [open, search])

  // Fresh dialog per open.
  useEffect(() => {
    if (open) {
      setSearch('')
      setSelected(new Map())
    }
  }, [open])

  const toggle = (contact: ContactOption) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(contact.id)) next.delete(contact.id)
      else next.set(contact.id, contact)
      return next
    })
  }

  const handleEnroll = async () => {
    if (selected.size === 0) return
    setEnrolling(true)
    try {
      const result = await enrollContacts(sequenceId, [...selected.keys()])
      toast.success(
        summarizeEnrollResult(result, {
          requiresLaunch: sequenceStatus === 'active' || sequenceStatus === 'paused',
        }),
      )
      onEnrolled()
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to enroll contacts')
    } finally {
      setEnrolling(false)
    }
  }

  const selectableCount = useMemo(
    () => options.filter((o) => o.email).length,
    [options],
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0 sm:max-w-[420px]">
        <DialogHeader className="px-4 pb-2 pt-4">
          <DialogTitle className="text-sm font-medium">Add contacts</DialogTitle>
        </DialogHeader>
        <Command className="border-0" shouldFilter={false}>
          <CommandInput
            placeholder="Search contacts…"
            className="h-9"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {loading
                ? 'Searching…'
                : selectableCount === 0
                  ? 'No contacts with an email found.'
                  : 'No contacts found.'}
            </CommandEmpty>
            {options.map((contact) => {
              const hasEmail = !!contact.email
              const checked = selected.has(contact.id)
              return (
                <CommandItem
                  key={contact.id}
                  value={contact.id}
                  disabled={!hasEmail}
                  onSelect={() => hasEmail && toggle(contact)}
                  className="gap-2"
                >
                  <Checkbox checked={checked} className="h-4 w-4" tabIndex={-1} />
                  <span className="min-w-0 flex-1 truncate">
                    {contact.full_name || contact.email || 'Unnamed contact'}
                  </span>
                  <span
                    className={cn(
                      'flex shrink-0 items-center gap-1 text-[11px]',
                      hasEmail ? 'text-muted-foreground' : 'text-red-500/80',
                    )}
                  >
                    <Mail className="h-3 w-3" />
                    {contact.email ?? 'no email'}
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
        <div className="flex items-center justify-between border-t px-4 py-3">
          <span className="text-xs text-muted-foreground">
            {selected.size} selected
          </span>
          <Button
            size="sm"
            className="h-8"
            disabled={selected.size === 0 || enrolling}
            onClick={handleEnroll}
          >
            {enrolling ? 'Enrolling…' : `Enroll ${selected.size || ''}`.trim()}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
