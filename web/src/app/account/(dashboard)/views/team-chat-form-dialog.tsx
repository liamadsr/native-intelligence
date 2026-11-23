'use client'

/**
 * New form (docs/plans/channels-inbox.md, phase 4), from the team chat
 * composer's + menu. A form is always a table's (components/tables/
 * forms-panel.tsx), so this makes both through their own routes: a table
 * named for the form (POST /api/account/tables), then its form for the
 * workspace's signed-in members (POST /api/account/tables/[id]/forms) with
 * one question, the row's title. Its link is shown once, when made: it goes
 * into the message box, ready to send. The table opens from the toast, where
 * the form's other fields and its answers are.
 */
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { openCard } from '@/lib/chat-cards/open-card'
import { FORM_TITLE_KEY } from '@/lib/forms/types'

const NAME_MAX = 80
const QUESTION_MAX = 120

export function TeamChatFormDialog({
  open,
  onOpenChange,
  onLink,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The new form's link, for the message box. */
  onLink: (url: string, name: string) => void
}) {
  const [name, setName] = useState('')
  const [question, setQuestion] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  useEffect(() => {
    if (!open) return
    setName('')
    setQuestion('')
    setError(null)
  }, [open])

  const submit = async () => {
    const title = name.trim()
    if (!title) return setError('Give the form a name')
    if (saving) return
    setSaving(true)
    setError(null)
    const fail = (why: string) => {
      setSaving(false)
      setError(why)
    }
    const made = await fetch('/api/account/tables', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: title }) }).catch(() => null)
    const tableJson = (await made?.json().catch(() => null)) as { table?: { id?: string; name?: string }; error?: string } | null
    const tableId = tableJson?.table?.id
    if (!made?.ok || !tableId) return fail(tableJson?.error ?? 'The form could not be made. Try again.')
    const form = await fetch(`/api/account/tables/${tableId}/forms`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: title, access: 'members', fields: [{ key: FORM_TITLE_KEY, label: question.trim() || 'Your answer', required: true }] }),
    }).catch(() => null)
    const formJson = (await form?.json().catch(() => null)) as { page_url?: string; url?: string; error?: string } | null
    const link = formJson?.page_url ?? formJson?.url
    if (!form?.ok || !link) return fail(formJson?.error ?? 'The table was made, but its form could not be. Open the table to make it there.')
    setSaving(false)
    onLink(link, title)
    toast.success('Form made: its link is in your message', {
      action: {
        label: 'Open table',
        onClick: () => void openCard({ kind: 'tables', title: title, target: { type: 'data_table', id: tableId, label: title } }, { from: 'team_chat' }),
      },
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" data-team-chat-form-dialog="">
        <DialogHeader>
          <DialogTitle>New form</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value.slice(0, NAME_MAX))} placeholder="Form name" aria-label="Form name" autoFocus data-form-name="" />
          <Input value={question} onChange={(e) => setQuestion(e.target.value.slice(0, QUESTION_MAX))} placeholder="What should people answer? (optional)" aria-label="Question" data-form-question="" />
          <p className="text-xs text-muted-foreground">Teammates fill it in signed in. Each answer is a row of its own table, where you can add more fields.</p>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-form-error="">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving} data-form-submit="">
              {saving ? 'Making…' : 'Make form'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
