'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  Link2,
  Loader2,
  Mail,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  InviteEmailInput,
  type ContactSuggestion,
} from '@/components/invite-email-input'

// ─── Types ───────────────────────────────────────────────────

interface ConnectedAccount {
  id: string
  provider: 'google' | 'microsoft'
  capability: 'email' | 'calendar'
  account_email: string
  display_name: string | null
  workspace_ids: string[]
}

type Step = 'name' | 'link-accounts' | 'invite' | 'done'

const STEPS: Step[] = ['name', 'link-accounts', 'invite', 'done']

// ─── Step indicator ──────────────────────────────────────────

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: total }).map((_, i) => (
        <div
          key={i}
          className={`h-1 rounded-full transition-all duration-500 ${
            i <= current ? 'w-5 bg-foreground' : 'w-5 bg-foreground/10'
          }`}
        />
      ))}
    </div>
  )
}

// ─── Step: Name ──────────────────────────────────────────────

function NameStep({
  name,
  setName,
  onNext,
  creating,
}: {
  name: string
  setName: (v: string) => void
  onNext: () => void
  creating: boolean
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-2xl font-bold tracking-tight"
      >
        Create a new workspace
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-2 max-w-sm text-sm text-muted-foreground"
      >
        Workspaces are shared environments where teams can meet and work on
        shared goals.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-6 w-full max-w-sm"
      >
        <label className="mb-1.5 block text-left text-sm font-medium">
          Workspace name
        </label>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme Inc."
          className="h-10"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim() && !creating) onNext()
          }}
        />
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-6 w-full max-w-sm"
      >
        <Button
          onClick={onNext}
          disabled={!name.trim() || creating}
          className="w-full"
          size="lg"
        >
          {creating ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {creating ? 'Creating...' : 'Continue'}
          {!creating && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
      </motion.div>
    </div>
  )
}

// ─── Step: Link accounts ─────────────────────────────────────

function LinkAccountsStep({
  accounts,
  linkedIds,
  setLinkedIds,
  onNext,
  saving,
}: {
  accounts: ConnectedAccount[]
  linkedIds: Set<string>
  setLinkedIds: (ids: Set<string>) => void
  onNext: () => void
  saving: boolean
}) {
  const toggle = (id: string) => {
    const next = new Set(linkedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setLinkedIds(next)
  }

  // Group by provider
  const google = accounts.filter((a) => a.provider === 'google')
  const microsoft = accounts.filter((a) => a.provider === 'microsoft')

  const capIcon = (cap: string) =>
    cap === 'calendar' ? (
      <CalendarDays className="h-4 w-4 text-muted-foreground" />
    ) : (
      <Mail className="h-4 w-4 text-muted-foreground" />
    )

  const renderGroup = (label: string, items: ConnectedAccount[]) => {
    if (items.length === 0) return null
    return (
      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">
          {label}
        </div>
        <div className="space-y-2">
          {items.map((account) => {
            const checked = linkedIds.has(account.id)
            return (
              <button
                key={account.id}
                onClick={() => toggle(account.id)}
                className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                  checked
                    ? 'border-foreground/15 bg-muted/50'
                    : 'hover:border-foreground/15 hover:bg-accent/30'
                }`}
              >
                {capIcon(account.capability)}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {account.account_email}
                  </div>
                  <div className="text-xs capitalize text-muted-foreground">
                    {account.capability}
                  </div>
                </div>
                <div
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                    checked
                      ? 'border-foreground bg-foreground'
                      : 'border-foreground/20'
                  }`}
                >
                  {checked && <Check className="h-3 w-3 text-background" />}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-muted"
      >
        <Link2 className="h-5 w-5 text-muted-foreground" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-4 text-2xl font-bold tracking-tight"
      >
        Link your accounts
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-1.5 max-w-sm text-sm text-muted-foreground"
      >
        Choose which connected accounts to make available in this workspace.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-6 w-full max-w-sm space-y-4 text-left"
      >
        {renderGroup('Google', google)}
        {renderGroup('Microsoft', microsoft)}
        {accounts.length === 0 && (
          <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            No connected accounts yet. You can add them later in settings.
          </div>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mt-6 w-full max-w-sm"
      >
        <Button
          onClick={onNext}
          disabled={saving}
          size="lg"
          className="w-full"
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          {linkedIds.size > 0
            ? `Link ${linkedIds.size} account${linkedIds.size !== 1 ? 's' : ''} & continue`
            : 'Skip for now'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </motion.div>
    </div>
  )
}

// ─── Step: Invite ────────────────────────────────────────────

function InviteStep({
  onNext,
  workspaceId,
  previousWorkspaceId,
}: {
  onNext: () => void
  /** The ID of the workspace just created — passed explicitly so invites
   *  always target the new workspace rather than relying on the cookie
   *  (which may not yet reflect the new workspace in all environments). */
  workspaceId: string | null
  previousWorkspaceId: string | null
}) {
  const [emails, setEmails] = useState<string[]>([''])
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  const addRow = () => setEmails((prev) => [...prev, ''])

  const updateEmail = (index: number, value: string) => {
    setEmails((prev) => prev.map((e, i) => (i === index ? value : e)))
  }

  const removeRow = (index: number) => {
    if (emails.length === 1) setEmails([''])
    else setEmails((prev) => prev.filter((_, i) => i !== index))
  }

  const validEmails = emails.filter(
    (e) => e.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()),
  )

  // Live search contacts from the user's previous workspace CRM
  const searchContacts = previousWorkspaceId
    ? async (query: string): Promise<ContactSuggestion[]> => {
        try {
          const res = await fetch(
            `/api/account/contacts?search=${encodeURIComponent(query)}&limit=8&workspace_id=${previousWorkspaceId}`,
          )
          if (res.ok) {
            const data = await res.json()
            return data.contacts ?? []
          }
        } catch {
          // silently fail
        }
        return []
      }
    : undefined

  const handleSend = async () => {
    if (validEmails.length === 0) return
    setSending(true)
    setError('')
    try {
      const results = await Promise.allSettled(
        validEmails.map((email) =>
          fetch('/api/account/workspace/invites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Always include the workspace_id explicitly so the server targets
            // the newly created workspace rather than whatever workspace the
            // cookie currently points to (which may still be the old one).
            body: JSON.stringify({
              email: email.trim(),
              role: 'member',
              ...(workspaceId ? { workspace_id: workspaceId } : {}),
            }),
          }),
        ),
      )
      // fetch resolves on 4xx/5xx (already invited, not an admin, insert
      // error), so a non-ok response is a failure too, not just a rejection.
      const failedEmails = validEmails.filter((_, i) => {
        const r = results[i]
        return r.status === 'rejected' || !r.value.ok
      })
      // A 201 can still carry `email_sent: false`: the invite row exists (it
      // shows under Settings → Workspace, where it can be resent) but the
      // email never left. Retrying here would hit "already invited".
      const unsentEmails: string[] = []
      await Promise.all(
        results.map(async (r, i) => {
          if (r.status !== 'fulfilled' || !r.value.ok) return
          const body = await r.value.json().catch(() => null)
          if (body?.email_sent === false) unsentEmails.push(validEmails[i])
        }),
      )
      if (failedEmails.length > 0 || unsentEmails.length > 0) {
        // Keep only the failed addresses in the form so they can be retried
        // without re-sending the ones that went through.
        setEmails(failedEmails.length > 0 ? failedEmails : [''])
        const messages: string[] = []
        if (failedEmails.length > 0) messages.push(`${failedEmails.length} invite(s) failed to send.`)
        if (unsentEmails.length > 0) {
          messages.push(
            `Invite created, but the email could not be sent to ${unsentEmails.join(', ')}. You can resend it from Settings → Workspace.`,
          )
        }
        setError(messages.join(' '))
        return
      }
      setSent(true)
    } catch {
      setError('Failed to send invites.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="flex h-10 w-10 items-center justify-center rounded-full bg-muted"
      >
        <UserPlus className="h-5 w-5 text-muted-foreground" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-4 text-2xl font-bold tracking-tight"
      >
        Invite your team
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-1.5 max-w-sm text-sm text-muted-foreground"
      >
        {previousWorkspaceId
          ? 'Add colleagues to this workspace — start typing to find contacts from your CRM.'
          : 'Add colleagues to collaborate in this workspace.'}
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        className="mt-6 w-full max-w-sm"
      >
        {sent ? (
          <div className="rounded-lg border bg-muted/50 p-4">
            <div className="flex items-center justify-center gap-2 text-foreground">
              <Check className="h-4 w-4" />
              <span className="text-sm font-medium">
                {validEmails.length} invite{validEmails.length !== 1 ? 's' : ''}{' '}
                sent!
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {emails.map((email, i) => (
              <div key={i} className="flex items-center gap-2">
                <div className="flex-1">
                  <InviteEmailInput
                    value={email}
                    onChange={(value) => updateEmail(i, value)}
                    searchContacts={searchContacts}
                    autoFocus={i === 0}
                    className="h-9 text-sm"
                  />
                </div>
                <button
                  onClick={() => removeRow(i)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {emails.length > 1 ? (
                    <Trash2 className="h-3.5 w-3.5" />
                  ) : (
                    <X className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            ))}

            <button
              onClick={addRow}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed py-2 text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
            >
              <Plus className="h-3.5 w-3.5" />
              Add another
            </button>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {validEmails.length > 0 && (
              <div className="pt-1">
                <Button
                  onClick={handleSend}
                  disabled={sending}
                  variant="outline"
                  className="w-full"
                  size="sm"
                >
                  {sending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Mail className="mr-2 h-4 w-4" />
                  )}
                  {sending
                    ? 'Sending...'
                    : `Send ${validEmails.length} invite${validEmails.length !== 1 ? 's' : ''}`}
                </Button>
              </div>
            )}
          </div>
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="mt-6 w-full max-w-sm"
      >
        <Button onClick={onNext} size="lg" className="w-full">
          {sent || validEmails.length === 0 ? 'Continue' : 'Skip for now'}
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </motion.div>
    </div>
  )
}

// ─── Step: Done ──────────────────────────────────────────────

function DoneStep({
  workspaceName,
  onFinish,
}: {
  workspaceName: string
  onFinish: () => void
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <motion.div
        initial={{ scale: 0, rotate: -180 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', duration: 0.7 }}
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted"
      >
        <Check className="h-6 w-6 text-foreground" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mt-4 text-2xl font-bold tracking-tight"
      >
        {workspaceName} is ready
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.35 }}
        className="mt-1.5 max-w-sm text-sm text-muted-foreground"
      >
        Your new workspace is set up. Jump in and start working.
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.45 }}
        className="mt-6 w-full max-w-sm"
      >
        <Button onClick={onFinish} size="lg" className="w-full">
          Open workspace
          <ArrowRight className="ml-2 h-4 w-4" />
        </Button>
      </motion.div>
    </div>
  )
}

// ─── Main Wizard ─────────────────────────────────────────────

export function CreateWorkspaceWizard({
  userEmail,
  onClose,
  onCreated,
}: {
  userEmail: string | null
  onClose: () => void
  onCreated: (workspaceId: string) => void
}) {
  const router = useRouter()
  // Portal the full-screen overlay to <body>. Mounted inline, the wizard's
  // `fixed inset-0 z-60` is trapped inside whatever stacking context its caller
  // sits in (e.g. the top bar's `z-10`), so a later same-z sibling — the chat
  // strip — paints over it. Portaling to body hoists it above the whole shell.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const [currentStep, setCurrentStep] = useState(0)
  const [workspaceName, setWorkspaceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [newWorkspaceId, setNewWorkspaceId] = useState<string | null>(null)

  // Connected accounts
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([])
  const [linkedIds, setLinkedIds] = useState<Set<string>>(new Set())
  const [savingLinks, setSavingLinks] = useState(false)

  // Remember the workspace ID the user was on before creating the new one
  // so we can search their CRM contacts from it during the invite step
  const [previousWorkspaceId, setPreviousWorkspaceId] = useState<string | null>(null)

  // Fetch connected accounts and capture current workspace ID on mount
  useEffect(() => {
    async function load() {
      try {
        // Capture the current workspace ID before it gets switched
        const wsRes = await fetch('/api/account/workspace')
        if (wsRes.ok) {
          const wsData = await wsRes.json()
          setPreviousWorkspaceId(wsData.workspace?.id ?? null)
        }

        const oauthRes = await fetch('/api/oauth/status')
        if (oauthRes.ok) {
          const data = await oauthRes.json()
          setAccounts(data.accounts ?? [])
        }
      } catch {
        // silently fail
      }
    }
    load()
  }, [])

  const handleCreateWorkspace = useCallback(async () => {
    const trimmed = workspaceName.trim()
    if (!trimmed) return
    setCreating(true)
    setCreateError('')
    try {
      const res = await fetch('/api/account/workspace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (!res.ok) {
        const { error } = await res.json()
        setCreateError(error ?? 'Failed to create workspace')
        setCreating(false)
        return
      }
      const { workspace } = await res.json()
      setNewWorkspaceId(workspace.id)

      // If no accounts to link, skip the link step
      if (accounts.length === 0) {
        setCurrentStep(2) // jump to invite
      } else {
        setCurrentStep(1) // link accounts
      }
    } catch {
      setCreateError('Something went wrong')
    } finally {
      setCreating(false)
    }
  }, [workspaceName, accounts.length])

  const handleLinkAccounts = useCallback(async () => {
    if (!newWorkspaceId || linkedIds.size === 0) {
      setCurrentStep(2)
      return
    }
    setSavingLinks(true)
    try {
      // For each selected account, add the new workspace to its workspace list
      const results = await Promise.allSettled(
        Array.from(linkedIds).map(async (accountId) => {
          const account = accounts.find((a) => a.id === accountId)
          if (!account) return
          const newWsIds = [...account.workspace_ids, newWorkspaceId]
          const res = await fetch('/api/oauth/account-workspaces', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              account_id: accountId,
              workspace_ids: newWsIds,
            }),
          })
          // fetch resolves on 4xx/5xx; a refused link is a failure too.
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
        }),
      )
      const failed = results.filter((r) => r.status === 'rejected').length
      if (failed > 0) {
        toast.error(`${failed} account${failed === 1 ? '' : 's'} could not be linked. You can link ${failed === 1 ? 'it' : 'them'} later in Integrations.`)
      }
    } catch {
      // continue anyway
    } finally {
      setSavingLinks(false)
      setCurrentStep(2)
    }
  }, [newWorkspaceId, linkedIds, accounts])

  const handleFinish = useCallback(() => {
    if (newWorkspaceId) {
      onCreated(newWorkspaceId)
    }
    router.refresh()
  }, [newWorkspaceId, onCreated, router])

  const step = STEPS[currentStep]

  if (!mounted) return null

  return createPortal(
    <div className="fixed inset-0 z-60 flex flex-col bg-background">
      {/* Draggable title bar region for desktop */}
      <div data-tauri-drag-region className="h-11 shrink-0" />

      {/* Header */}
      <div className="flex items-center justify-between px-6 pb-2">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        {userEmail ? (
          <div className="text-right text-xs text-muted-foreground">
            {userEmail}
          </div>
        ) : (
          <div className="w-16" />
        )}
      </div>

      {/* Content */}
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-lg">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
            >
              {step === 'name' && (
                <>
                  <NameStep
                    name={workspaceName}
                    setName={setWorkspaceName}
                    onNext={handleCreateWorkspace}
                    creating={creating}
                  />
                  {createError && (
                    <p className="mt-3 text-center text-sm text-destructive">
                      {createError}
                    </p>
                  )}
                </>
              )}
              {step === 'link-accounts' && (
                <LinkAccountsStep
                  accounts={accounts}
                  linkedIds={linkedIds}
                  setLinkedIds={setLinkedIds}
                  onNext={handleLinkAccounts}
                  saving={savingLinks}
                />
              )}
              {step === 'invite' && (
                <InviteStep
                  onNext={() => setCurrentStep(3)}
                  workspaceId={newWorkspaceId}
                  previousWorkspaceId={previousWorkspaceId}
                />
              )}
              {step === 'done' && (
                <DoneStep
                  workspaceName={workspaceName.trim()}
                  onFinish={handleFinish}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {/* Progress bar at the bottom */}
      <div className="flex shrink-0 justify-center pb-8 pt-4">
        <StepIndicator current={currentStep} total={STEPS.length} />
      </div>
    </div>,
    document.body,
  )
}
