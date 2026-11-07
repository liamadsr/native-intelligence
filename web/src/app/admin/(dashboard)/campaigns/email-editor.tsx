'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Loader2, Save, RotateCcw } from 'lucide-react'
import { ThinkingOrb } from 'thinking-orbs'

interface EmailEditorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** null = creating a new template */
  slug: string | null
  /** Called with the saved slug after a successful save */
  onSaved: (savedSlug: string) => void
}

interface TemplateData {
  slug: string
  name: string
  subject: string
  html: string
  description: string
}

const DEFAULT_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      margin: 0;
      padding: 0;
      background-color: #f6f9fc;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .wrapper {
      padding: 40px 16px;
    }
    .container {
      background-color: #ffffff;
      margin: 0 auto;
      max-width: 560px;
      border-radius: 12px;
      overflow: hidden;
    }
    .header {
      padding: 32px 40px 24px;
      text-align: center;
    }
    .header img {
      width: 44px;
      height: 44px;
    }
    .header .wordmark {
      display: inline-block;
      vertical-align: middle;
      font-size: 22px;
      font-weight: 700;
      color: #1a1a1a;
      margin-left: 2px;
      letter-spacing: -0.3px;
    }
    .body {
      padding: 0 40px 32px;
    }
    h1 {
      color: #1a1a1a;
      font-size: 24px;
      font-weight: 700;
      margin: 0 0 16px;
      line-height: 1.3;
    }
    p {
      color: #4a4a4a;
      font-size: 15px;
      line-height: 25px;
      margin: 0 0 16px;
    }
    .btn {
      display: inline-block;
      background-color: #1a1a1a;
      border-radius: 8px;
      color: #ffffff;
      font-size: 15px;
      font-weight: 600;
      text-decoration: none;
      text-align: center;
      padding: 12px 28px;
    }
    /* Gmail blue link fix */
    u + .body a .btn-text,
    u + .body a .btn-text * {
      color: inherit !important;
      text-decoration: none !important;
    }
    .divider {
      border: none;
      border-top: 1px solid #f0f0f0;
      margin: 0;
    }
    .footer {
      padding: 24px 40px;
      text-align: center;
    }
    .footer-logo img {
      width: 24px;
      height: 24px;
      opacity: 0.4;
    }
    .footer p {
      color: #a0a0a0;
      font-size: 12px;
      line-height: 18px;
      margin: 8px 0 0;
    }
    .footer a {
      color: #a0a0a0;
      text-decoration: underline;
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <!-- Header with logo -->
      <div class="header">
        <img src="https://dial8.ai/screenshots/icon_128x128@2x%201.png" alt="Dial8" style="width:44px;height:44px;vertical-align:middle;" />
        <span class="wordmark">ial8</span>
      </div>

      <!-- Email body -->
      <div class="body">
        <h1>Your heading here</h1>
        <p>Your email content goes here. Write something compelling.</p>
        <p style="text-align: center; margin: 28px 0;">
          <a href="#" class="btn"><span class="btn-text" style="color:#ffffff;">Call to Action</span></a>
        </p>
        <p>— Liam</p>
      </div>

      <hr class="divider" />

      <!-- Footer with small logo -->
      <div class="footer">
        <div class="footer-logo">
          <img src="https://dial8.ai/screenshots/icon_128x128@2x%201.png" alt="Dial8" />
        </div>
        <p>
          Dial8 &middot; Your mind, extended.
          <br />
          <a href="{{unsubscribe_url}}">Unsubscribe</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`

export function EmailEditor({ open, onOpenChange, slug, onSaved }: EmailEditorProps) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [form, setForm] = useState<TemplateData>({
    slug: '',
    name: '',
    subject: '',
    html: DEFAULT_HTML,
    description: '',
  })

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isNew = slug === null

  // Load existing template
  useEffect(() => {
    if (!open) return
    if (isNew) {
      setForm({ slug: '', name: '', subject: '', html: DEFAULT_HTML, description: '' })
      setError(null)
      return
    }

    setLoading(true)
    setError(null)
    fetch(`/api/admin/email-templates/${slug}`)
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load template')
        return res.json()
      })
      .then((data) => {
        setForm({
          slug: data.slug,
          name: data.name,
          subject: data.subject,
          html: data.html,
          description: data.description || '',
        })
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [open, slug, isNew])

  // Debounced preview update
  const updatePreview = useCallback((html: string) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    previewTimerRef.current = setTimeout(() => {
      const iframe = iframeRef.current
      if (!iframe) return
      const doc = iframe.contentDocument
      if (!doc) return
      doc.open()
      doc.write(html)
      doc.close()
    }, 500)
  }, [])

  // Update preview when html changes
  useEffect(() => {
    if (open) updatePreview(form.html)
  }, [form.html, open, updatePreview])

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current)
    }
  }, [])

  const handleSave = async () => {
    if (!form.name || !form.subject || !form.html) {
      setError('Name, subject, and HTML are required')
      return
    }
    if (isNew && !form.slug) {
      setError('Slug is required')
      return
    }

    setSaving(true)
    setError(null)

    try {
      const url = isNew
        ? '/api/admin/email-templates'
        : `/api/admin/email-templates/${slug}`
      const method = isNew ? 'POST' : 'PUT'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Save failed')
      }

      onSaved(isNew ? form.slug : (slug ?? form.slug))
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = () => {
    setForm((prev) => ({ ...prev, html: DEFAULT_HTML }))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[90vh] max-w-6xl flex-col gap-0 p-0 [&>button:last-of-type]:hidden">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <div className="flex items-center justify-between">
            <DialogTitle>{isNew ? 'New Email Template' : `Edit: ${form.name}`}</DialogTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReset}
                title="Reset to default HTML"
              >
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Reset
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                )}
                Save
              </Button>
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className="mx-6 mt-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Metadata fields */}
        <div className="shrink-0 border-b border-border px-6 py-3">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {isNew && (
              <div>
                <Label htmlFor="slug" className="text-xs">Slug</Label>
                <Input
                  id="slug"
                  value={form.slug}
                  onChange={(e) => setForm((prev) => ({ ...prev, slug: e.target.value }))}
                  placeholder="e.g. welcome-email"
                  className="mt-1 h-8 text-sm"
                />
              </div>
            )}
            <div>
              <Label htmlFor="name" className="text-xs">Name</Label>
              <Input
                id="name"
                value={form.name}
                onChange={(e) => {
                  const name = e.target.value
                  const autoSlug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
                  setForm((prev) => ({
                    ...prev,
                    name,
                    // Only auto-update slug if it's still in sync with the previous auto-slug
                    ...(isNew && prev.slug === prev.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
                      ? { slug: autoSlug }
                      : {}),
                  }))
                }}
                placeholder="Template name"
                className="mt-1 h-8 text-sm"
              />
            </div>
            <div className={isNew ? '' : 'col-span-2'}>
              <Label htmlFor="subject" className="text-xs">Subject</Label>
              <Input
                id="subject"
                value={form.subject}
                onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))}
                placeholder="Email subject line"
                className="mt-1 h-8 text-sm"
              />
            </div>
            <div>
              <Label htmlFor="description" className="text-xs">Description</Label>
              <Input
                id="description"
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                placeholder="Internal note"
                className="mt-1 h-8 text-sm"
              />
            </div>
          </div>
        </div>

        {/* Split pane: HTML editor + preview */}
        {loading ? (
          <div className="flex flex-1 items-center justify-center">
            <ThinkingOrb state="composing" size={64} theme="auto" />
          </div>
        ) : (
          <div className="flex min-h-0 flex-1">
            {/* HTML editor */}
            <div className="flex w-1/2 flex-col border-r border-border">
              <div className="shrink-0 border-b border-border bg-muted/50 px-3 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">HTML</span>
              </div>
              <textarea
                value={form.html}
                onChange={(e) => setForm((prev) => ({ ...prev, html: e.target.value }))}
                className="flex-1 resize-none border-0 bg-background p-3 font-mono text-sm leading-relaxed outline-none focus:ring-0"
                spellCheck={false}
              />
            </div>

            {/* Preview */}
            <div className="flex w-1/2 flex-col">
              <div className="shrink-0 border-b border-border bg-muted/50 px-3 py-1.5">
                <span className="text-xs font-medium text-muted-foreground">Preview</span>
              </div>
              <iframe
                ref={iframeRef}
                className="flex-1 bg-white"
                title="Email preview"
                sandbox="allow-same-origin"
              />
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
