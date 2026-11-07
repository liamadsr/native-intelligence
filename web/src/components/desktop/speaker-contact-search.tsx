'use client'

import { useCallback, useEffect, useState } from 'react'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Search, UserCheck, UserPlus } from 'lucide-react'

interface ContactResult {
  id: string
  full_name: string
  email: string | null
  avatar_url: string | null
  company: { name: string } | null
}

interface SpeakerContactSearchProps {
  /** The speaker label being assigned (e.g. "remote_1") */
  speakerId: string
  /** Current display name for the speaker */
  speakerDisplayName: string
  /** Called when a contact is selected */
  onAssign: (contactId: string, contactName: string) => void
  /** Called for "This is me" — the voice is the user's own (followups issue 11). Omitted: no such item. */
  onAssignSelf?: () => void
  /** Trigger element (the speaker badge button) */
  children: React.ReactNode
}

export function SpeakerContactSearch({
  speakerId,
  speakerDisplayName,
  onAssign,
  onAssignSelf,
  children,
}: SpeakerContactSearchProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [contacts, setContacts] = useState<ContactResult[]>([])
  const [loading, setLoading] = useState(false)

  const fetchContacts = useCallback(async (query: string) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ search: query, limit: '10' })
      const res = await fetch(`/api/account/contacts?${params}`)
      if (res.ok) {
        const data = await res.json()
        setContacts(data.contacts || [])
      }
    } catch {
      // Silently fail — user can retry
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced search
  useEffect(() => {
    if (!open) return

    const timer = setTimeout(() => {
      if (search.trim().length > 0) {
        fetchContacts(search.trim())
      } else {
        // Show recent contacts when no search query
        fetchContacts('')
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [search, open, fetchContacts])

  // Load contacts when popover opens
  useEffect(() => {
    if (open) {
      fetchContacts('')
    }
  }, [open, fetchContacts])

  const handleSelect = (contact: ContactResult) => {
    onAssign(contact.id, contact.full_name)
    setOpen(false)
    setSearch('')
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start" side="bottom">
        <Command shouldFilter={false}>
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <p className="text-[11px] text-muted-foreground">
              Link <span className="font-medium text-foreground">{speakerDisplayName}</span> to a contact
            </p>
          </div>
          <CommandInput
            placeholder="Search contacts..."
            value={search}
            onValueChange={setSearch}
            className="h-8 text-xs"
          />
          <CommandList className="max-h-48">
            {onAssignSelf && (
              <CommandGroup forceMount>
                <CommandItem
                  value="__this_is_me__"
                  onSelect={() => {
                    onAssignSelf()
                    setOpen(false)
                    setSearch('')
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer"
                  forceMount
                >
                  <UserCheck className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="font-medium">This is me</span>
                </CommandItem>
              </CommandGroup>
            )}
            {contacts.length === 0 && (
              <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
                {loading ? 'Searching...' : 'No contacts found'}
              </CommandEmpty>
            )}
            <CommandGroup forceMount>
              {contacts.map((contact) => (
                <CommandItem
                  key={contact.id}
                  value={contact.full_name}
                  onSelect={() => handleSelect(contact)}
                  className="flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer"
                  forceMount
                >
                  <Avatar className="h-6 w-6">
                    {contact.avatar_url && <AvatarImage src={contact.avatar_url} />}
                    <AvatarFallback className="text-[9px]">
                      {getInitials(contact.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{contact.full_name}</p>
                    {(contact.email || contact.company?.name) && (
                      <p className="truncate text-[10px] text-muted-foreground">
                        {contact.email || contact.company?.name}
                      </p>
                    )}
                  </div>
                  <UserPlus className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
