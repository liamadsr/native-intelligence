'use client'

import { useState, useCallback, useRef } from 'react'
import { X } from 'lucide-react'

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
}

function getInitials(name: string): string {
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
}

interface ContactSuggestion {
  id: string
  full_name: string
  email: string
}

interface EmailRecipientInputProps {
  values: string[]
  onChange: (values: string[]) => void
  placeholder?: string
}

export function EmailRecipientInput({ values, onChange, placeholder }: EmailRecipientInputProps) {
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const addEmail = useCallback(
    (email: string) => {
      const clean = email.trim().toLowerCase()
      if (clean && isValidEmail(clean) && !values.includes(clean)) {
        onChange([...values, clean])
      }
      setInput('')
      setShowSuggestions(false)
    },
    [values, onChange],
  )

  const removeEmail = useCallback(
    (email: string) => {
      onChange(values.filter((v) => v !== email))
    },
    [values, onChange],
  )

  const searchContacts = useCallback(async (query: string) => {
    if (query.length < 2) {
      setSuggestions([])
      return
    }
    try {
      const res = await fetch(`/api/account/contacts?search=${encodeURIComponent(query)}&limit=5`)
      if (res.ok) {
        const data = await res.json()
        const contacts = (data.contacts || data.data || []) as ContactSuggestion[]
        setSuggestions(contacts.filter((c) => c.email))
      }
    } catch {
      // ignore
    }
  }, [])

  const handleInputChange = useCallback(
    (value: string) => {
      setInput(value)
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        searchContacts(value)
        setShowSuggestions(true)
      }, 200)
    },
    [searchContacts],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === 'Tab' || e.key === ',') {
        // An empty field lets Tab move focus on (to Cc, Subject).
        if (e.key === 'Tab' && !input.trim()) return
        e.preventDefault()
        if (input.trim()) addEmail(input)
      }
      if (e.key === 'Backspace' && !input && values.length > 0) {
        removeEmail(values[values.length - 1])
      }
    },
    [input, values, addEmail, removeEmail],
  )

  return (
    <div className="flex-1 flex flex-wrap items-center gap-1 relative">
      {values.map((email) => (
        <span
          key={email}
          className="inline-flex items-center gap-1 bg-muted text-xs rounded-md px-2 py-0.5"
        >
          {email}
          <button onClick={() => removeEmail(email)} className="hover:text-destructive">
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => handleInputChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          if (input.trim()) addEmail(input)
          setTimeout(() => setShowSuggestions(false), 200)
        }}
        className="flex-1 min-w-[120px] bg-transparent text-sm outline-none h-7"
        placeholder={values.length === 0 ? placeholder || 'Type email or name...' : ''}
      />

      {showSuggestions && suggestions.length > 0 && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-popover border rounded-3xl p-2 shadow-md z-50">
          {suggestions.map((contact) => (
            <button
              key={contact.id}
              onMouseDown={(e) => {
                e.preventDefault()
                addEmail(contact.email)
              }}
              className="w-full text-left px-3 py-2 text-sm rounded-2xl hover:bg-muted flex items-center gap-2"
            >
              <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center text-xs">
                {getInitials(contact.full_name)}
              </div>
              <div>
                <div className="text-sm">{contact.full_name}</div>
                <div className="text-xs text-muted-foreground">{contact.email}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
