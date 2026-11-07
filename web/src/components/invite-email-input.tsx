'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mail, User, Building2, Loader2 } from 'lucide-react'
import { Input } from '@/components/ui/input'

// ─── Types ───────────────────────────────────────────────────

export interface ContactSuggestion {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  company?: { name: string } | null
}

interface InviteEmailInputProps {
  value: string
  onChange: (value: string) => void
  onSelectContact?: (contact: ContactSuggestion) => void
  placeholder?: string
  autoFocus?: boolean
  className?: string
  /** If provided, enables CRM contact autocomplete */
  searchContacts?: (query: string) => Promise<ContactSuggestion[]>
}

// ─── Component ───────────────────────────────────────────────

export function InviteEmailInput({
  value,
  onChange,
  onSelectContact,
  placeholder = 'colleague@company.com',
  autoFocus = false,
  className = '',
  searchContacts,
}: InviteEmailInputProps) {
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([])
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null)
  // Bumped by every keystroke and pick: only the newest search may answer.
  const searchSeqRef = useRef(0)

  // Search contacts as user types
  const handleSearch = useCallback(
    (query: string) => {
      if (!searchContacts) return
      if (debounceRef.current) clearTimeout(debounceRef.current)
      const seq = ++searchSeqRef.current

      if (query.trim().length < 2) {
        setSuggestions([])
        setOpen(false)
        setLoading(false)
        return
      }

      debounceRef.current = setTimeout(async () => {
        setLoading(true)
        try {
          const results = await searchContacts(query.trim())
          if (seq !== searchSeqRef.current) return
          setSuggestions(results)
          setOpen(results.length > 0)
          setActiveIndex(-1)
        } catch {
          if (seq !== searchSeqRef.current) return
          setSuggestions([])
          setOpen(false)
        } finally {
          if (seq === searchSeqRef.current) setLoading(false)
        }
      }, 200)
    },
    [searchContacts],
  )

  const handleChange = (newValue: string) => {
    onChange(newValue)
    handleSearch(newValue)
  }

  const handleSelect = (contact: ContactSuggestion) => {
    searchSeqRef.current++
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setLoading(false)
    onChange(contact.email)
    onSelectContact?.(contact)
    setSuggestions([])
    setOpen(false)
    setActiveIndex(-1)
  }

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open || suggestions.length === 0) return

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((prev) =>
        prev < suggestions.length - 1 ? prev + 1 : 0,
      )
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((prev) =>
        prev > 0 ? prev - 1 : suggestions.length - 1,
      )
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault()
      handleSelect(suggestions[activeIndex])
    } else if (e.key === 'Escape') {
      setOpen(false)
      setActiveIndex(-1)
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        wrapperRef.current &&
        !wrapperRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
        setActiveIndex(-1)
      }
    }
    // pointerdown, not mousedown: Tauri's drag script swallows mousedown on
    // title-bar drag strips (the workspace wizard has one above this input).
    document.addEventListener('pointerdown', handleClickOutside)
    return () => document.removeEventListener('pointerdown', handleClickOutside)
  }, [])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <div ref={wrapperRef} className="relative">
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          type="email"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            if (suggestions.length > 0) setOpen(true)
          }}
          placeholder={placeholder}
          autoFocus={autoFocus}
          className={`pl-9 ${className}`}
          autoComplete="off"
          role={searchContacts ? 'combobox' : undefined}
          aria-expanded={open}
          aria-autocomplete={searchContacts ? 'list' : undefined}
          aria-activedescendant={
            activeIndex >= 0 ? `suggestion-${activeIndex}` : undefined
          }
        />
        {loading && (
          <Loader2 className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && suggestions.length > 0 && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-50 mt-1 max-h-48 overflow-y-auto rounded-3xl border bg-popover p-2 shadow-md"
        >
          {suggestions.map((contact, i) => (
            <button
              key={contact.id}
              id={`suggestion-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onClick={() => handleSelect(contact)}
              className={`flex w-full items-center gap-3 rounded-2xl px-2.5 py-2 text-left text-sm transition-colors ${
                i === activeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-accent/50'
              }`}
            >
              {contact.avatar_url ? (
                <img
                  src={contact.avatar_url}
                  alt=""
                  className="h-7 w-7 shrink-0 rounded-full object-cover"
                />
              ) : (
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {contact.full_name || contact.email}
                </div>
                {contact.full_name && (
                  <div className="truncate text-xs text-muted-foreground">
                    {contact.email}
                  </div>
                )}
              </div>
              {contact.company?.name && (
                <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  <span className="max-w-[80px] truncate">
                    {contact.company.name}
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
