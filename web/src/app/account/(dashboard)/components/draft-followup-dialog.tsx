'use client'

import { useState } from 'react'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Check, Copy, ExternalLink, Loader2, Mail, RefreshCw, X } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DraftFollowUpDialogProps {
  captureId: string
  captureTitle: string
  participantEmails: string[]
  confirmedActionCount: number
  confirmedDecisionCount: number
  children: React.ReactNode
}

interface DraftResult {
  draft_id: string | null
  subject: string
  to: string[]
  body: string
  provider: string | null
}

export function DraftFollowUpDialog({
  captureId,
  captureTitle,
  participantEmails,
  confirmedActionCount,
  confirmedDecisionCount,
  children,
}: DraftFollowUpDialogProps) {
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<'config' | 'preview'>('config')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<DraftResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // Config state
  const [recipients, setRecipients] = useState<string[]>(participantEmails)
  const [includeActions, setIncludeActions] = useState(true)
  const [includeDecisions, setIncludeDecisions] = useState(true)
  const [tone, setTone] = useState<'professional' | 'formal' | 'casual' | 'brief'>('professional')
  const [additionalContext, setAdditionalContext] = useState('')
  const [editedBody, setEditedBody] = useState('')

  function handleOpen(isOpen: boolean) {
    setOpen(isOpen)
    if (isOpen) {
      setStep('config')
      setResult(null)
      setError(null)
      setRecipients(participantEmails)
    }
  }

  async function handleGenerate() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/captures/${captureId}/draft-followup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipients: recipients.length ? recipients : undefined,
          include_actions: includeActions,
          include_decisions: includeDecisions,
          tone,
          additional_context: additionalContext || undefined,
        }),
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Failed to generate draft' }))
        setError(data.error)
        return
      }

      const data = await res.json()
      setResult(data)
      setEditedBody(data.body)
      setStep('preview')
    } catch {
      setError('Failed to generate draft')
    } finally {
      setLoading(false)
    }
  }

  function handleRemoveRecipient(email: string) {
    setRecipients((prev) => prev.filter((e) => e !== email))
  }

  async function handleCopy() {
    if (!(await copyTextToClipboard(editedBody))) {
      toast.error("Couldn't copy the draft")
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogTrigger asChild>{children}</DialogTrigger>

      {/* `ph-no-capture` on the (portalled) content: session replay blocks the
          generated email's recipients, subject and body. */}
      <DialogContent className="ph-no-capture max-w-lg">
        {step === 'config' ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Draft Follow-Up Email
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Recipients */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">To</label>
                <div className="flex flex-wrap gap-1 rounded-md border p-2">
                  {recipients.map((email) => (
                    <Badge key={email} variant="secondary" className="gap-1 text-xs">
                      {email}
                      <button onClick={() => handleRemoveRecipient(email)}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                  {recipients.length === 0 && (
                    <span className="text-xs text-muted-foreground">All capture participants</span>
                  )}
                </div>
              </div>

              {/* Include toggles */}
              <div className="space-y-2">
                <label className="text-sm font-medium">Include</label>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-actions"
                    checked={includeActions}
                    onCheckedChange={(checked) => setIncludeActions(!!checked)}
                  />
                  <label htmlFor="include-actions" className="text-sm">
                    Action items ({confirmedActionCount} confirmed)
                  </label>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="include-decisions"
                    checked={includeDecisions}
                    onCheckedChange={(checked) => setIncludeDecisions(!!checked)}
                  />
                  <label htmlFor="include-decisions" className="text-sm">
                    Decisions ({confirmedDecisionCount} confirmed)
                  </label>
                </div>
              </div>

              {/* Tone */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Tone</label>
                <Select value={tone} onValueChange={(v) => setTone(v as typeof tone)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="professional">Professional</SelectItem>
                    <SelectItem value="formal">Formal</SelectItem>
                    <SelectItem value="casual">Casual</SelectItem>
                    <SelectItem value="brief">Brief</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Additional context */}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Additional notes (optional)</label>
                <Textarea
                  placeholder="Add any extra context or notes to include..."
                  value={additionalContext}
                  onChange={(e) => setAdditionalContext(e.target.value)}
                  rows={2}
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
            </div>

            <DialogFooter>
              <Button onClick={handleGenerate} disabled={loading}>
                {loading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Generating...
                  </>
                ) : (
                  'Generate Draft'
                )}
              </Button>
            </DialogFooter>
          </>
        ) : result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Email Draft
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-3">
              <div className="text-sm">
                <span className="font-medium">To:</span>{' '}
                <span className="text-muted-foreground">{result.to.join(', ')}</span>
              </div>
              <div className="text-sm">
                <span className="font-medium">Subject:</span>{' '}
                <span className="text-muted-foreground">{result.subject}</span>
              </div>

              <ScrollArea className="h-64 rounded-md border p-3">
                <Textarea
                  value={editedBody}
                  onChange={(e) => setEditedBody(e.target.value)}
                  className="min-h-[200px] resize-none border-0 p-0 shadow-none focus-visible:ring-0"
                />
              </ScrollArea>

              {result.draft_id && result.provider && (
                <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                  <Check className="h-3 w-3" />
                  Draft saved to {result.provider === 'google' ? 'Gmail' : 'Outlook'}
                </p>
              )}
            </div>

            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? (
                  <>
                    <Check className="mr-2 h-3.5 w-3.5" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="mr-2 h-3.5 w-3.5" />
                    Copy
                  </>
                )}
              </Button>

              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setStep('config')
                  setResult(null)
                }}
              >
                <RefreshCw className="mr-2 h-3.5 w-3.5" />
                Regenerate
              </Button>

              {/* The draft is saved: the dialog closes as the mailbox opens,
                  so the page opened for it is in view. */}
              {result.draft_id && result.provider === 'google' && (
                <Button asChild variant="outline" size="sm">
                  <a href="https://mail.google.com/mail/#drafts" target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
                    <ExternalLink className="mr-2 h-3.5 w-3.5" />
                    Edit in Gmail
                  </a>
                </Button>
              )}

              {result.draft_id && result.provider === 'microsoft' && (
                <Button asChild variant="outline" size="sm">
                  <a href="https://outlook.office.com/mail/drafts" target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)}>
                    <ExternalLink className="mr-2 h-3.5 w-3.5" />
                    Edit in Outlook
                  </a>
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
