'use client'

/**
 * Settings → Preferences → Assistant (Interactive mode, 2026-10-02; moved from
 * Settings → Voice 2026-10-22, Liam: "that's like your assistant's name
 * overall, not just for voice mode"): the name the user's assistant goes by.
 * It is the wake word Interactive mode
 * listens for on the desktop ("Joseph, can you look something up for me?")
 * and who the main chat says it is (src/lib/ai/chat-system-prompt.ts; a
 * teammate's chat keeps the teammate's own name). Each account's own, saved
 * on the account with a copy on each device (@/lib/voice/assistant-name-store):
 * the wake word is matched locally against that copy, and the chat learns the
 * name from each turn. Joseph until they pick one.
 *
 * Shown everywhere, not only on the desktop: the chat goes by the name in the
 * browser too.
 */

import { useState, type FormEvent } from 'react'
import { Bot, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ASSISTANT_NAME_MAX, DEFAULT_ASSISTANT_NAME, checkAssistantName } from '@/lib/voice/assistant-name'
import { saveAssistantName, useAssistantName } from '@/lib/voice/assistant-name-store'

export function AssistantNameSection() {
  const { name, loaded } = useAssistantName()
  // The field holds what is typed; until then, the name in effect.
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedName, setSavedName] = useState<string | null>(null)

  const value = draft ?? (loaded ? name : '')
  const checked = checkAssistantName(value)
  const unchanged = checked.ok && checked.name === name
  const canSave = loaded && !saving && checked.ok && !unchanged

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!canSave) {
      if (!checked.ok) setError(checked.error)
      return
    }
    setSaving(true)
    setError(null)
    const result = await saveAssistantName(value)
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setDraft(null)
    setSavedName(result.name)
  }

  return (
    <div data-testid="assistant-name-section">
      <h3 className="mb-3 text-sm font-medium text-muted-foreground">Assistant</h3>
      <form onSubmit={handleSubmit} className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-6 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
              <Bot className="h-4.5 w-4.5 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              <Label htmlFor="assistant-name" className="text-sm font-medium">
                Your assistant’s name
              </Label>
              <p className="text-[13px] text-muted-foreground">
                What your assistant goes by in chat, and the name you say to talk to it in Interactive mode on the
                desktop: “{checked.ok ? checked.name : name}, what’s next today?”
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Input
              id="assistant-name"
              value={value}
              placeholder={DEFAULT_ASSISTANT_NAME}
              maxLength={ASSISTANT_NAME_MAX + 10}
              disabled={!loaded}
              aria-invalid={!checked.ok && draft !== null}
              aria-describedby={error ? 'assistant-name-error' : undefined}
              onChange={(e) => {
                setDraft(e.target.value)
                setError(null)
                setSavedName(null)
              }}
              className="w-40"
            />
            <Button type="submit" size="sm" disabled={!canSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        {error && (
          <p id="assistant-name-error" role="alert" className="-mt-2 px-5 pb-4 text-xs text-destructive">
            {error}
          </p>
        )}
        {!error && draft !== null && !checked.ok && (
          <p className="-mt-2 px-5 pb-4 text-xs text-destructive">{checked.error}</p>
        )}
        {savedName && !error && (
          <p className="-mt-2 flex items-center gap-1 px-5 pb-4 text-xs text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-emerald-500" /> Saved. Your assistant is now {savedName}.
          </p>
        )}
      </form>
    </div>
  )
}
