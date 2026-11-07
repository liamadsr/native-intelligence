'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Plus,
  Trash2,
  ChevronDown,
  Clock,
  MessageSquare,
  Mail,
  Save,
  GripVertical,
  Loader2,
  Eye,
  Pencil,
} from 'lucide-react'
import { InAppPreview } from './in-app-preview'
import { EmailEditor } from '../email-editor'

interface CampaignStep {
  id: string
  campaign_id: string
  step_order: number
  step_name: string
  delivery_channel: string
  delay_days: number
  is_active: boolean
  // Email fields
  template_slug: string | null
  // In-app fields
  message_title: string | null
  message_body: string | null
  message_type: string | null
  cta_text: string | null
  cta_action: string | null
  cta_url: string | null
  priority: string | null
  expires_after_days: number | null
  created_at: string
  updated_at: string
}

interface EmailTemplate {
  id: string
  slug: string
  name: string
  subject: string
}

export function CampaignStepsEditor({
  campaignId,
  initialSteps,
  stepSentCounts,
}: {
  campaignId: string
  initialSteps: CampaignStep[]
  stepSentCounts?: Record<string, number>
}) {
  const [steps, setSteps] = useState<CampaignStep[]>(initialSteps)
  const [adding, setAdding] = useState(false)
  const [openStepId, setOpenStepId] = useState<string | null>(
    initialSteps.length > 0 ? initialSteps[0].id : null,
  )
  const [templates, setTemplates] = useState<EmailTemplate[]>([])

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/email-templates')
      if (res.ok) {
        const data = await res.json()
        setTemplates(data)
      }
    } catch {
      // silently fail
    }
  }, [])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  async function handleAddStep() {
    setAdding(true)
    try {
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/steps`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            step_name: `Step ${steps.length + 1}`,
            delivery_channel: 'in_app',
            delay_days: steps.length === 0 ? 0 : 3,
          }),
        },
      )

      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Failed to add step')
        return
      }

      const { step } = await res.json()
      setSteps([...steps, step])
      setOpenStepId(step.id)
    } catch {
      alert('Failed to add step')
    } finally {
      setAdding(false)
    }
  }

  async function handleDeleteStep(stepId: string) {
    if (!confirm('Delete this step? This cannot be undone.')) return

    try {
      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/steps/${stepId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        alert('Failed to delete step')
        return
      }
      setSteps(steps.filter((s) => s.id !== stepId))
      if (openStepId === stepId) setOpenStepId(null)
    } catch {
      alert('Failed to delete step')
    }
  }

  return (
    <div className="space-y-3">
      {steps.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="mb-3 text-sm text-muted-foreground">
              No steps yet. Add your first step to define the campaign sequence.
            </p>
            <Button onClick={handleAddStep} disabled={adding} size="sm">
              <Plus className="mr-1.5 h-3.5 w-3.5" />
              Add First Step
            </Button>
          </CardContent>
        </Card>
      )}

      {steps.map((step, index) => (
        <div key={step.id}>
          {/* Timeline connector */}
          {index > 0 && (
            <div className="flex items-center gap-2 py-2 pl-6">
              <div className="h-6 w-px bg-border" />
              <Clock className="h-3 w-3 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {step.delay_days === 0
                  ? 'Immediately'
                  : step.delay_days < 1 / 24
                    ? `${Math.round(step.delay_days * 1440)} min later`
                    : step.delay_days < 1
                      ? `${Math.round(step.delay_days * 24)} hr later`
                      : `${step.delay_days} day${step.delay_days !== 1 ? 's' : ''} later`}
              </span>
            </div>
          )}

          <Collapsible
            open={openStepId === step.id}
            onOpenChange={(open) => setOpenStepId(open ? step.id : null)}
          >
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer py-3 hover:bg-muted/50">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {step.step_name}
                        </span>
                        {(step.delivery_channel === 'in_app' ||
                          step.delivery_channel === 'both') && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-xs"
                          >
                            <MessageSquare className="h-2.5 w-2.5" />
                            In-App
                          </Badge>
                        )}
                        {(step.delivery_channel === 'email' ||
                          step.delivery_channel === 'both') && (
                          <Badge
                            variant="outline"
                            className="gap-1 text-xs"
                          >
                            <Mail className="h-2.5 w-2.5" />
                            {step.template_slug ?? 'Email'}
                          </Badge>
                        )}
                        {step.message_type && step.delivery_channel !== 'email' && (
                          <Badge variant="outline" className="text-xs">
                            {step.message_type.replace(/_/g, ' ')}
                          </Badge>
                        )}
                        {((stepSentCounts?.[step.id]) ?? 0) > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {stepSentCounts![step.id]} sent
                          </span>
                        )}
                      </div>
                    </div>
                    <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="pt-0">
                  <StepForm
                    campaignId={campaignId}
                    step={step}
                    templates={templates}
                    showDelay={index > 0}
                    onUpdate={(updated) => {
                      setSteps(
                        steps.map((s) => (s.id === updated.id ? updated : s)),
                      )
                    }}
                    onDelete={() => handleDeleteStep(step.id)}
                    onTemplatesSaved={fetchTemplates}
                  />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </div>
      ))}

      {steps.length > 0 && (
        <Button
          variant="outline"
          onClick={handleAddStep}
          disabled={adding}
          className="w-full"
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          {adding ? 'Adding...' : 'Add Step'}
        </Button>
      )}
    </div>
  )
}

function StepForm({
  campaignId,
  step,
  templates,
  showDelay,
  onUpdate,
  onDelete,
  onTemplatesSaved,
}: {
  campaignId: string
  step: CampaignStep
  templates: EmailTemplate[]
  showDelay: boolean
  onUpdate: (step: CampaignStep) => void
  onDelete: () => void
  onTemplatesSaved: () => void
}) {
  const [saving, setSaving] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [stepName, setStepName] = useState(step.step_name)
  const [deliveryChannel, setDeliveryChannel] = useState(step.delivery_channel)
  const [delayUnit, setDelayUnit] = useState<'days' | 'hours' | 'minutes'>('days')
  // delayValue is always in the currently selected unit (display only)
  const [delayValue, setDelayValue] = useState(step.delay_days)
  // Email fields
  const [templateSlug, setTemplateSlug] = useState(step.template_slug ?? '')
  // In-app fields
  const [messageTitle, setMessageTitle] = useState(step.message_title ?? '')
  const [messageBody, setMessageBody] = useState(step.message_body ?? '')
  const [messageType, setMessageType] = useState(step.message_type ?? 'announcement')
  const [ctaText, setCtaText] = useState(step.cta_text ?? '')
  const [ctaUrl, setCtaUrl] = useState(step.cta_url ?? '')
  const [priority, setPriority] = useState(step.priority ?? 'normal')
  const [expiresAfterDays, setExpiresAfterDays] = useState(step.expires_after_days ?? 7)

  const showEmailFields = deliveryChannel === 'email' || deliveryChannel === 'both'
  const showInAppFields = deliveryChannel === 'in_app' || deliveryChannel === 'both'

  async function handleSave() {
    setSaving(true)
    try {
      const delayInDays =
        delayUnit === 'minutes'
          ? delayValue / 1440
          : delayUnit === 'hours'
            ? delayValue / 24
            : delayValue

      const payload: Record<string, unknown> = {
        step_name: stepName,
        delivery_channel: deliveryChannel,
        delay_days: delayInDays,
      }

      if (showEmailFields) {
        payload.template_slug = templateSlug || null
      }

      if (showInAppFields) {
        payload.message_title = messageTitle
        payload.message_body = messageBody
        payload.message_type = messageType
        payload.cta_text = ctaText.trim() || null
        payload.cta_action = ctaUrl.trim() ? 'url' : 'dismiss'
        payload.cta_url = ctaUrl.trim() || null
        payload.priority = priority
        payload.expires_after_days = expiresAfterDays
      }

      const res = await fetch(
        `/api/admin/campaigns/${campaignId}/steps/${step.id}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )

      if (!res.ok) {
        const data = await res.json()
        alert(data.error ?? 'Failed to save')
        return
      }

      const { step: updated } = await res.json()
      onUpdate(updated)
    } catch {
      alert('Failed to save step')
    } finally {
      setSaving(false)
    }
  }

  const selectedTemplate = templates.find((t) => t.slug === templateSlug)

  const canPreview =
    (showInAppFields && (messageTitle || messageBody)) ||
    (showEmailFields && templateSlug)

  return (
    <div className="space-y-4 pt-2">
      {/* Row 1: Step Name + Delay */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label>Step Name</Label>
          <Input
            value={stepName}
            onChange={(e) => setStepName(e.target.value)}
            placeholder="e.g. Welcome Message"
          />
        </div>
        {showDelay && (
          <div className="space-y-2">
            <Label>Delay after previous step</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={0}
                max={delayUnit === 'days' ? 365 : delayUnit === 'hours' ? 8760 : 525600}
                value={delayValue}
                onChange={(e) =>
                  setDelayValue(parseFloat(e.target.value) || 0)
                }
                className="w-24"
              />
              <Select value={delayUnit} onValueChange={(v) => setDelayUnit(v as 'days' | 'hours' | 'minutes')}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutes</SelectItem>
                  <SelectItem value="hours">Hours</SelectItem>
                  <SelectItem value="days">Days</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </div>

      {/* Row 2: Delivery Channel */}
      <div className="space-y-2">
        <Label>Delivery Channel</Label>
        <Select value={deliveryChannel} onValueChange={setDeliveryChannel}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="in_app">In-App Message</SelectItem>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="both">Both</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {deliveryChannel === 'both'
            ? 'This step sends both an in-app message and an email.'
            : deliveryChannel === 'email'
              ? 'This step sends an email using an email template.'
              : 'This step shows an in-app message to users.'}
        </p>
      </div>

      {/* Email fields */}
      {showEmailFields && (
        <div className="space-y-2">
          <Label>Email Template</Label>
          <div className="flex items-center gap-2">
            <Select value={templateSlug} onValueChange={setTemplateSlug}>
              <SelectTrigger>
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.slug} value={t.slug}>
                    <span className="flex items-center gap-2">
                      {t.name}
                      <span className="text-muted-foreground">({t.slug})</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {templateSlug && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setEditorOpen(true)}
              >
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit Template
              </Button>
            )}
          </div>
          {selectedTemplate && (
            <p className="text-xs text-muted-foreground">
              Subject: {selectedTemplate.subject}
            </p>
          )}
          {templates.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No email templates found.{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2"
                onClick={() => {
                  setEditorOpen(true)
                }}
              >
                Create one
              </button>
            </p>
          )}
        </div>
      )}

      {/* In-app fields */}
      {showInAppFields && (
        <>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Message Type</Label>
              <Select value={messageType} onValueChange={setMessageType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="feedback_prompt">Feedback Prompt</SelectItem>
                  <SelectItem value="announcement">Announcement</SelectItem>
                  <SelectItem value="tip">Tip</SelectItem>
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

          <div className="space-y-2">
            <Label>Message Title</Label>
            <Input
              value={messageTitle}
              onChange={(e) => setMessageTitle(e.target.value)}
              placeholder="Title shown to the user"
            />
          </div>

          <div className="space-y-2">
            <Label>Message Body</Label>
            <Textarea
              value={messageBody}
              onChange={(e) => setMessageBody(e.target.value)}
              placeholder="Write the message content..."
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>CTA Button Text (optional)</Label>
              <Input
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                placeholder="e.g. Learn More, Got it"
              />
            </div>
            <div className="space-y-2">
              <Label>CTA Link URL (optional)</Label>
              <Input
                type="url"
                value={ctaUrl}
                onChange={(e) => setCtaUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Expires After Days</Label>
            <Input
              type="number"
              min={1}
              max={365}
              value={expiresAfterDays}
              onChange={(e) =>
                setExpiresAfterDays(parseInt(e.target.value, 10) || 7)
              }
              className="w-24"
            />
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Delete Step
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPreviewOpen(true)}
            disabled={!canPreview}
          >
            <Eye className="mr-1.5 h-3.5 w-3.5" />
            Preview
          </Button>
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-3.5 w-3.5" />
            )}
            {saving ? 'Saving...' : 'Save Step'}
          </Button>
        </div>
      </div>

      {/* Preview Dialog */}
      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Step Preview: {stepName}</DialogTitle>
          </DialogHeader>

          {showInAppFields && showEmailFields ? (
            /* Both channels — tabbed view */
            <Tabs defaultValue="in_app">
              <TabsList>
                <TabsTrigger value="in_app" className="gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  In-App
                </TabsTrigger>
                <TabsTrigger value="email" className="gap-1.5">
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </TabsTrigger>
              </TabsList>
              <TabsContent value="in_app" className="pt-4">
                <InAppPreview
                  messageType={messageType}
                  messageTitle={messageTitle}
                  messageBody={messageBody}
                  ctaText={ctaText}
                  ctaUrl={ctaUrl}
                />
              </TabsContent>
              <TabsContent value="email" className="pt-4">
                {templateSlug ? (
                  <iframe
                    src={`/api/admin/email-preview?step=${templateSlug}`}
                    className="h-[500px] w-full rounded-lg border"
                    title="Email preview"
                  />
                ) : (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    Select an email template to preview.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          ) : showInAppFields ? (
            /* In-app only */
            <InAppPreview
              messageType={messageType}
              messageTitle={messageTitle}
              messageBody={messageBody}
              ctaText={ctaText}
              ctaUrl={ctaUrl}
            />
          ) : templateSlug ? (
            /* Email only */
            <iframe
              src={`/api/admin/email-preview?step=${templateSlug}`}
              className="h-[500px] w-full rounded-lg border"
              title="Email preview"
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Select an email template to preview.
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Email Template Editor Overlay */}
      <EmailEditor
        open={editorOpen}
        onOpenChange={setEditorOpen}
        slug={templateSlug || null}
        onSaved={(savedSlug) => {
          // If creating a new template (no slug was selected), auto-select it
          if (!templateSlug) setTemplateSlug(savedSlug)
          onTemplatesSaved()
        }}
      />
    </div>
  )
}
