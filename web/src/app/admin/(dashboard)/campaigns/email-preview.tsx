'use client'

import { useCallback, useEffect, useState } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Eye, Pencil, Plus, Trash2, Loader2 } from 'lucide-react'
import { EmailEditor } from './email-editor'

export interface EmailTemplate {
  id: string
  slug: string
  name: string
  subject: string
  html: string
  description: string | null
  updated_at: string
}

export function EmailTemplateList() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [previewSlug, setPreviewSlug] = useState<string | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorSlug, setEditorSlug] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/email-templates')
      if (res.ok) {
        const data = await res.json()
        setTemplates(data)
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  const handleDelete = async (slug: string) => {
    if (!confirm(`Delete template "${slug}"? This cannot be undone.`)) return
    setDeleting(slug)
    try {
      const res = await fetch(`/api/admin/email-templates/${slug}`, { method: 'DELETE' })
      if (res.ok) {
        setTemplates((prev) => prev.filter((t) => t.slug !== slug))
      }
    } catch {
      // silently fail
    } finally {
      setDeleting(null)
    }
  }

  const openEditor = (slug: string | null) => {
    setEditorSlug(slug)
    setEditorOpen(true)
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <ThinkingOrb state="working" size={20} theme="auto" />
        Loading templates...
      </div>
    )
  }

  return (
    <>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {templates.length} template{templates.length !== 1 ? 's' : ''}
        </p>
        <Button variant="outline" size="sm" onClick={() => openEditor(null)}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">
            No email templates yet. Create one to get started.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={() => openEditor(null)}
          >
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            New Template
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-center justify-between rounded-lg border border-border p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{template.name}</span>
                  <Badge variant="outline" className="text-xs">{template.slug}</Badge>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{template.subject}</p>
                {template.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground">{template.description}</p>
                )}
              </div>
              <div className="ml-4 flex shrink-0 items-center gap-2">
                <Dialog
                  open={previewSlug === template.slug}
                  onOpenChange={(open) => setPreviewSlug(open ? template.slug : null)}
                >
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Eye className="mr-1.5 h-3.5 w-3.5" />
                      Preview
                    </Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-2xl p-0">
                    <DialogHeader className="px-6 pt-6">
                      <DialogTitle className="flex items-center gap-2">
                        {template.name}
                        <Badge variant="outline" className="text-xs font-normal">
                          {template.slug}
                        </Badge>
                      </DialogTitle>
                      <p className="text-sm text-muted-foreground">
                        Subject: {template.subject}
                      </p>
                    </DialogHeader>
                    <div className="border-t border-border">
                      {previewSlug === template.slug && (
                        <iframe
                          src={`/api/admin/email-preview?step=${template.slug}`}
                          className="h-[600px] w-full"
                          title={`${template.name} email preview`}
                        />
                      )}
                    </div>
                  </DialogContent>
                </Dialog>

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openEditor(template.slug)}
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" />
                  Edit
                </Button>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(template.slug)}
                  disabled={deleting === template.slug}
                  className="text-muted-foreground hover:text-destructive"
                >
                  {deleting === template.slug ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <EmailEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        slug={editorSlug}
        onSaved={() => fetchTemplates()}
      />
    </>
  )
}
