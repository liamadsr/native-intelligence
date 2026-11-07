'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export function SendMessageForm({
  userId,
  userEmail,
  onSuccess,
}: {
  userId?: string
  userEmail?: string
  onSuccess?: () => void
}) {
  const router = useRouter()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const [targetUserId, setTargetUserId] = useState(userId ?? '')
  const [messageTitle, setMessageTitle] = useState('')
  const [messageBody, setMessageBody] = useState('')
  const [messageType, setMessageType] = useState('feedback_prompt')
  const [priority, setPriority] = useState('normal')
  const [ctaText, setCtaText] = useState('')
  const [ctaUrl, setCtaUrl] = useState('')

  const showCtaFields = messageType === 'announcement' || messageType === 'tip'

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setError(null)
    setSuccess(null)

    if (!targetUserId) {
      setError('A user ID is required')
      setSending(false)
      return
    }

    try {
      const res = await fetch('/api/admin/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: targetUserId,
          message_title: messageTitle,
          message_body: messageBody,
          message_type: messageType,
          priority,
          ...(showCtaFields && {
            ...(ctaText.trim() && { cta_text: ctaText.trim() }),
            ...(ctaUrl.trim() && {
              cta_action: 'url',
              cta_url: ctaUrl.trim(),
            }),
          }),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to send message')
      }

      setSuccess('Message sent successfully')
      setMessageTitle('')
      setMessageBody('')
      setMessageType('feedback_prompt')
      setPriority('normal')
      setCtaText('')
      setCtaUrl('')

      setTimeout(() => {
        setSuccess(null)
        onSuccess?.()
        router.refresh()
      }, 1000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSending(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {!userId && (
        <div className="space-y-2">
          <Label htmlFor="msg-user-id">User ID</Label>
          <Input
            id="msg-user-id"
            value={targetUserId}
            onChange={(e) => setTargetUserId(e.target.value)}
            placeholder="Enter user UUID"
          />
          {userEmail && (
            <p className="text-xs text-muted-foreground">{userEmail}</p>
          )}
        </div>
      )}

      {userId && userEmail && (
        <div className="rounded-md bg-muted p-2">
          <p className="text-sm text-muted-foreground">
            Sending to: <span className="font-medium text-foreground">{userEmail}</span>
          </p>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="msg-title">Message Title</Label>
        <Input
          id="msg-title"
          value={messageTitle}
          onChange={(e) => setMessageTitle(e.target.value)}
          placeholder="e.g. How are you liking Dial8?"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="msg-body">Message Body</Label>
        <Textarea
          id="msg-body"
          value={messageBody}
          onChange={(e) => setMessageBody(e.target.value)}
          placeholder="Write your message..."
          rows={3}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Type</Label>
          <Select value={messageType} onValueChange={setMessageType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="announcement">Announcement</SelectItem>
              <SelectItem value="tip">Tip</SelectItem>
              <SelectItem value="feedback_prompt">Feedback Request</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Priority</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {showCtaFields && (
        <div className="space-y-3 rounded-md border p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Call to Action (optional)
          </p>
          <div className="space-y-2">
            <Label htmlFor="cta-text">Button Text</Label>
            <Input
              id="cta-text"
              value={ctaText}
              onChange={(e) => setCtaText(e.target.value)}
              placeholder={messageType === 'announcement' ? 'Got it' : 'Dismiss'}
            />
            <p className="text-xs text-muted-foreground">
              Customize the button label. Leave empty for default.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cta-url">Link URL</Label>
            <Input
              id="cta-url"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              placeholder="https://..."
              type="url"
            />
            <p className="text-xs text-muted-foreground">
              Add a link to open when the button is clicked. Leave empty to just dismiss.
            </p>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      {success && <p className="text-sm text-green-600">{success}</p>}

      <Button type="submit" disabled={sending} className="w-full">
        {sending ? 'Sending...' : 'Send Message'}
      </Button>
    </form>
  )
}
