'use client'

import { Fragment, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Pencil, Trash2, Plus, Check, X, ChevronDown, ChevronRight, Eye, EyeOff } from 'lucide-react'

const ALL_PROVIDERS = ['claude', 'groq', 'openai'] as const

const PURCHASE_ACTIONS = [
  { value: '', label: 'None (info only)' },
  { value: 'byok_unlock', label: 'BYOK Unlock' },
  { value: 'subscription', label: 'Subscription' },
] as const

const ICON_OPTIONS = [
  { value: '', label: 'None' },
  { value: 'sparkles', label: 'sparkles' },
  { value: 'key.fill', label: 'key.fill' },
  { value: 'crown.fill', label: 'crown.fill' },
  { value: 'star.fill', label: 'star.fill' },
  { value: 'bolt.fill', label: 'bolt.fill' },
  { value: 'infinity', label: 'infinity' },
  { value: 'person.fill', label: 'person.fill' },
  { value: 'building.2.fill', label: 'building.2.fill' },
  { value: 'gift.fill', label: 'gift.fill' },
  { value: 'flame.fill', label: 'flame.fill' },
] as const

interface PlanDefinition {
  id: string
  name: string
  display_name: string
  monthly_cost_limit_usd: number | null
  monthly_token_limit: number | null
  max_requests_per_day: number | null
  allowed_providers: string[]
  is_default: boolean
  // Display metadata
  description: string | null
  feature_highlights: string[]
  price_display: string | null
  price_subtext: string | null
  cta_label: string | null
  cta_href: string | null
  sort_order: number
  is_visible: boolean
  badge_text: string | null
  allowed_model_labels: string[]
  purchase_action: string | null
  icon: string | null
  stripe_price_id: string | null
}

interface EditValues {
  display_name: string
  monthly_cost_limit_usd: string
  monthly_token_limit: string
  max_requests_per_day: string
  allowed_providers: string[]
  is_default: boolean
  // Display metadata
  description: string
  feature_highlights: string
  price_display: string
  price_subtext: string
  cta_label: string
  cta_href: string
  sort_order: string
  is_visible: boolean
  badge_text: string
  allowed_model_labels: string
  purchase_action: string
  icon: string
  stripe_price_id: string
}

function emptyEdit(): EditValues {
  return {
    display_name: '',
    monthly_cost_limit_usd: '',
    monthly_token_limit: '',
    max_requests_per_day: '',
    allowed_providers: [...ALL_PROVIDERS],
    is_default: false,
    description: '',
    feature_highlights: '',
    price_display: '',
    price_subtext: '',
    cta_label: '',
    cta_href: '',
    sort_order: '0',
    is_visible: true,
    badge_text: '',
    allowed_model_labels: '',
    purchase_action: '',
    icon: '',
    stripe_price_id: '',
  }
}

function planToEdit(plan: PlanDefinition): EditValues {
  return {
    display_name: plan.display_name,
    monthly_cost_limit_usd: plan.monthly_cost_limit_usd !== null ? String(plan.monthly_cost_limit_usd) : '',
    monthly_token_limit: plan.monthly_token_limit !== null ? String(plan.monthly_token_limit) : '',
    max_requests_per_day: plan.max_requests_per_day !== null ? String(plan.max_requests_per_day) : '',
    allowed_providers: plan.allowed_providers ?? [...ALL_PROVIDERS],
    is_default: plan.is_default,
    description: plan.description ?? '',
    feature_highlights: (plan.feature_highlights ?? []).join('\n'),
    price_display: plan.price_display ?? '',
    price_subtext: plan.price_subtext ?? '',
    cta_label: plan.cta_label ?? '',
    cta_href: plan.cta_href ?? '',
    sort_order: String(plan.sort_order ?? 0),
    is_visible: plan.is_visible ?? true,
    badge_text: plan.badge_text ?? '',
    allowed_model_labels: (plan.allowed_model_labels ?? []).join('\n'),
    purchase_action: plan.purchase_action ?? '',
    icon: plan.icon ?? '',
    stripe_price_id: plan.stripe_price_id ?? '',
  }
}

/** Parse multi-line text into a string array, filtering empty lines */
function textToArray(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean)
}

function parseNullableNum(val: string): number | null {
  if (!val.trim()) return null
  const n = parseFloat(val)
  return isNaN(n) ? null : n
}

function parseNullableInt(val: string): number | null {
  if (!val.trim()) return null
  const n = parseInt(val, 10)
  return isNaN(n) ? null : n
}

function editToPayload(ev: EditValues) {
  return {
    display_name: ev.display_name,
    monthly_cost_limit_usd: parseNullableNum(ev.monthly_cost_limit_usd),
    monthly_token_limit: parseNullableInt(ev.monthly_token_limit),
    max_requests_per_day: parseNullableInt(ev.max_requests_per_day),
    allowed_providers: ev.allowed_providers,
    is_default: ev.is_default,
    description: ev.description.trim() || null,
    feature_highlights: textToArray(ev.feature_highlights),
    price_display: ev.price_display.trim() || null,
    price_subtext: ev.price_subtext.trim() || null,
    cta_label: ev.cta_label.trim() || null,
    cta_href: ev.cta_href.trim() || null,
    sort_order: parseInt(ev.sort_order, 10) || 0,
    is_visible: ev.is_visible,
    badge_text: ev.badge_text.trim() || null,
    allowed_model_labels: textToArray(ev.allowed_model_labels),
    purchase_action: ev.purchase_action.trim() || null,
    icon: ev.icon.trim() || null,
    stripe_price_id: ev.stripe_price_id.trim() || null,
  }
}

function ProviderPills({ selected, onChange }: { selected: string[]; onChange: (providers: string[]) => void }) {
  function toggle(provider: string) {
    if (selected.includes(provider)) {
      onChange(selected.filter((p) => p !== provider))
    } else {
      onChange([...selected, provider])
    }
  }

  return (
    <div className="flex flex-wrap gap-1">
      {ALL_PROVIDERS.map((p) => {
        const active = selected.includes(p)
        return (
          <button
            key={p}
            type="button"
            onClick={() => toggle(p)}
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              active
                ? 'border-transparent bg-primary text-primary-foreground'
                : 'border-dashed border-muted-foreground/40 text-muted-foreground opacity-50'
            }`}
          >
            {p}
          </button>
        )
      })}
    </div>
  )
}

export function PlanDefinitionsTable({
  initialPlans,
  userCountByPlan,
}: {
  initialPlans: PlanDefinition[]
  userCountByPlan: Record<string, number>
}) {
  const [plans, setPlans] = useState<PlanDefinition[]>(initialPlans)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<EditValues>(emptyEdit())
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [newRow, setNewRow] = useState<EditValues & { name: string }>({ name: '', ...emptyEdit() })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function startEdit(plan: PlanDefinition) {
    setEditingId(plan.id)
    setExpandedId(plan.id)
    setEditValues(planToEdit(plan))
    setError(null)
  }

  function cancelEdit() {
    setEditingId(null)
    setEditValues(emptyEdit())
  }

  async function saveEdit(id: string) {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/ai-plans', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...editToPayload(editValues) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setPlans((prev) => prev.map((p) => (p.id === id ? data.plan : p)))
      setEditingId(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function deleteRow(id: string) {
    if (!confirm('Delete this plan? This cannot be undone.')) return
    setError(null)
    try {
      const res = await fetch(`/api/admin/ai-plans?id=${id}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setPlans((prev) => prev.filter((p) => p.id !== id))
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  async function addRow() {
    if (!newRow.name || !newRow.display_name) {
      setError('Name and display name are required')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/ai-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newRow.name.toLowerCase().trim(),
          ...editToPayload(newRow),
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      setPlans((prev) => [...prev, data.plan])
      setIsAdding(false)
      setNewRow({ name: '', ...emptyEdit() })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to add')
    } finally {
      setSaving(false)
    }
  }

  function renderProviders(providers: string[]) {
    return (
      <div className="flex flex-wrap gap-1">
        {providers.map((p) => (
          <Badge key={p} variant="outline" className="text-xs">
            {p}
          </Badge>
        ))}
      </div>
    )
  }

  function formatLimit(val: number | null, prefix = '') {
    if (val === null) return <span className="text-muted-foreground">Unlimited</span>
    return <span className="font-mono">{prefix}{Number(val).toLocaleString()}</span>
  }

  function toggleExpand(id: string) {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  /** Renders the expandable display settings panel */
  function renderDisplaySettings(plan: PlanDefinition) {
    const isEditing = editingId === plan.id

    if (isEditing) {
      return (
        <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-md">
          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Input
              value={editValues.description}
              onChange={(e) => setEditValues((v) => ({ ...v, description: e.target.value }))}
              className="mt-1 h-8"
              placeholder="Short tagline for this plan"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Price Display</label>
            <Input
              value={editValues.price_display}
              onChange={(e) => setEditValues((v) => ({ ...v, price_display: e.target.value }))}
              className="mt-1 h-8"
              placeholder="$0, $99, Custom"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Price Subtext</label>
            <Input
              value={editValues.price_subtext}
              onChange={(e) => setEditValues((v) => ({ ...v, price_subtext: e.target.value }))}
              className="mt-1 h-8"
              placeholder="per month, one-time"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">CTA Label</label>
            <Input
              value={editValues.cta_label}
              onChange={(e) => setEditValues((v) => ({ ...v, cta_label: e.target.value }))}
              className="mt-1 h-8"
              placeholder="Get started, Subscribe"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">CTA Link</label>
            <Input
              value={editValues.cta_href}
              onChange={(e) => setEditValues((v) => ({ ...v, cta_href: e.target.value }))}
              className="mt-1 h-8"
              placeholder="URL or leave empty for disabled"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Sort Order</label>
            <Input
              type="number"
              value={editValues.sort_order}
              onChange={(e) => setEditValues((v) => ({ ...v, sort_order: e.target.value }))}
              className="mt-1 h-8 w-24 font-mono"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Badge Text</label>
            <Input
              value={editValues.badge_text}
              onChange={(e) => setEditValues((v) => ({ ...v, badge_text: e.target.value }))}
              className="mt-1 h-8"
              placeholder="Most Popular, Best Value"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Purchase Action</label>
            <Select
              value={editValues.purchase_action}
              onValueChange={(val) => setEditValues((v) => ({ ...v, purchase_action: val === '__none__' ? '' : val }))}
            >
              <SelectTrigger className="mt-1 h-8">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                {PURCHASE_ACTIONS.map((opt) => (
                  <SelectItem key={opt.value || '__none__'} value={opt.value || '__none__'}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Icon (SF Symbol)</label>
            <Select
              value={editValues.icon}
              onValueChange={(val) => setEditValues((v) => ({ ...v, icon: val === '__none__' ? '' : val }))}
            >
              <SelectTrigger className="mt-1 h-8">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                {ICON_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value || '__none__'} value={opt.value || '__none__'}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {editValues.purchase_action && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Stripe Price ID</label>
              <Input
                value={editValues.stripe_price_id ?? ''}
                onChange={(e) => setEditValues((v) => ({ ...v, stripe_price_id: e.target.value }))}
                className="mt-1 h-8 font-mono text-xs"
                placeholder="price_1ABC..."
              />
            </div>
          )}
          <div className="flex items-center gap-2 self-end pb-1">
            <button
              type="button"
              onClick={() => setEditValues((v) => ({ ...v, is_visible: !v.is_visible }))}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                editValues.is_visible
                  ? 'border-green-500/30 bg-green-500/10 text-green-700'
                  : 'border-muted-foreground/30 bg-muted text-muted-foreground'
              }`}
            >
              {editValues.is_visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {editValues.is_visible ? 'Visible' : 'Hidden'}
            </button>
          </div>
          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Feature Highlights (one per line)</label>
            <Textarea
              value={editValues.feature_highlights}
              onChange={(e) => setEditValues((v) => ({ ...v, feature_highlights: e.target.value }))}
              className="mt-1 text-sm"
              rows={4}
              placeholder={"Unlimited words\nAll languages supported\nPriority processing"}
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Allowed Model Labels (one per line)</label>
            <Textarea
              value={editValues.allowed_model_labels}
              onChange={(e) => setEditValues((v) => ({ ...v, allowed_model_labels: e.target.value }))}
              className="mt-1 text-sm"
              rows={3}
              placeholder={"Claude Sonnet\nClaude Haiku\nLlama 3.3"}
            />
          </div>
        </div>
      )
    }

    // Read-only display settings
    return (
      <div className="grid grid-cols-2 gap-x-6 gap-y-2 p-4 bg-muted/30 rounded-md text-sm">
        <div>
          <span className="text-xs text-muted-foreground">Description:</span>{' '}
          <span>{plan.description || <span className="text-muted-foreground italic">none</span>}</span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Price:</span>{' '}
          <span className="font-mono">{plan.price_display || '—'}</span>
          {plan.price_subtext && <span className="text-muted-foreground ml-1">{plan.price_subtext}</span>}
        </div>
        <div>
          <span className="text-xs text-muted-foreground">CTA:</span>{' '}
          <span>{plan.cta_label || '—'}</span>
          {plan.cta_href && <span className="text-muted-foreground ml-1">({plan.cta_href})</span>}
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Sort:</span>{' '}
          <span className="font-mono">{plan.sort_order}</span>
          <span className="mx-2">|</span>
          <span className="text-xs text-muted-foreground">Visible:</span>{' '}
          {plan.is_visible
            ? <Badge variant="outline" className="text-[10px] text-green-700">Yes</Badge>
            : <Badge variant="outline" className="text-[10px] text-muted-foreground">No</Badge>}
          {plan.badge_text && (
            <>
              <span className="mx-2">|</span>
              <Badge variant="secondary" className="text-[10px]">{plan.badge_text}</Badge>
            </>
          )}
        </div>
        <div>
          <span className="text-xs text-muted-foreground">Purchase Action:</span>{' '}
          <span className="font-mono">{plan.purchase_action || '—'}</span>
          <span className="mx-2">|</span>
          <span className="text-xs text-muted-foreground">Icon:</span>{' '}
          <span className="font-mono">{plan.icon || '—'}</span>
          {plan.stripe_price_id && (
            <>
              <span className="mx-2">|</span>
              <span className="text-xs text-muted-foreground">Stripe:</span>{' '}
              <span className="font-mono text-xs">{plan.stripe_price_id}</span>
            </>
          )}
        </div>
        {(plan.feature_highlights?.length > 0) && (
          <div className="col-span-2">
            <span className="text-xs text-muted-foreground">Highlights:</span>
            <ul className="mt-1 space-y-0.5">
              {plan.feature_highlights.map((h, i) => (
                <li key={i} className="text-xs flex items-start gap-1.5">
                  <span className="text-muted-foreground mt-0.5">&#8226;</span>
                  {h}
                </li>
              ))}
            </ul>
          </div>
        )}
        {(plan.allowed_model_labels?.length > 0) && (
          <div className="col-span-2">
            <span className="text-xs text-muted-foreground">Models:</span>{' '}
            <span className="text-xs">{plan.allowed_model_labels.join(', ')}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[30px]"></TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Monthly Cost Limit</TableHead>
            <TableHead>Monthly Token Limit</TableHead>
            <TableHead>Max Requests/Day</TableHead>
            <TableHead>Allowed Providers</TableHead>
            <TableHead>Users</TableHead>
            <TableHead className="w-[80px]"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {plans.map((plan) => {
            const isEditing = editingId === plan.id
            const isExpanded = expandedId === plan.id
            return (
              <Fragment key={plan.id}>
                <TableRow>
                  <TableCell className="pr-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6"
                      onClick={() => toggleExpand(plan.id)}
                    >
                      {isExpanded
                        ? <ChevronDown className="h-3.5 w-3.5" />
                        : <ChevronRight className="h-3.5 w-3.5" />}
                    </Button>
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <Input
                          value={editValues.display_name}
                          onChange={(e) => setEditValues((v) => ({ ...v, display_name: e.target.value }))}
                          className="h-8 w-32"
                          placeholder="Display name"
                        />
                        <span className="text-xs text-muted-foreground whitespace-nowrap">({plan.name})</span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <div>
                          <span className="font-medium">{plan.display_name}</span>
                          <span className="ml-2 text-xs text-muted-foreground">({plan.name})</span>
                        </div>
                        {plan.is_default && (
                          <Badge variant="secondary" className="text-[10px]">default</Badge>
                        )}
                        {!plan.is_visible && (
                          <EyeOff className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        type="number"
                        step="0.01"
                        value={editValues.monthly_cost_limit_usd}
                        onChange={(e) => setEditValues((v) => ({ ...v, monthly_cost_limit_usd: e.target.value }))}
                        className="h-8 w-24 font-mono"
                        placeholder="Unlimited"
                      />
                    ) : (
                      formatLimit(plan.monthly_cost_limit_usd, '$')
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        type="number"
                        value={editValues.monthly_token_limit}
                        onChange={(e) => setEditValues((v) => ({ ...v, monthly_token_limit: e.target.value }))}
                        className="h-8 w-28 font-mono"
                        placeholder="Unlimited"
                      />
                    ) : (
                      formatLimit(plan.monthly_token_limit)
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <Input
                        type="number"
                        value={editValues.max_requests_per_day}
                        onChange={(e) => setEditValues((v) => ({ ...v, max_requests_per_day: e.target.value }))}
                        className="h-8 w-24 font-mono"
                        placeholder="Unlimited"
                      />
                    ) : (
                      formatLimit(plan.max_requests_per_day)
                    )}
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <ProviderPills
                        selected={editValues.allowed_providers}
                        onChange={(providers) => setEditValues((v) => ({ ...v, allowed_providers: providers }))}
                      />
                    ) : (
                      renderProviders(plan.allowed_providers ?? [])
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">
                      {userCountByPlan[plan.id] ?? 0} users
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {isEditing ? (
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => saveEdit(plan.id)}
                          disabled={saving}
                        >
                          <Check className="h-4 w-4 text-green-600" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={cancelEdit}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => startEdit(plan)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => deleteRow(plan.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
                {/* Expandable display settings row */}
                {isExpanded && (
                  <TableRow>
                    <TableCell colSpan={8} className="pt-0 pb-4">
                      {renderDisplaySettings(plan)}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}

          {/* Add new row */}
          {isAdding && (
            <>
              <TableRow>
                <TableCell></TableCell>
                <TableCell>
                  <Input
                    placeholder="plan-slug"
                    value={newRow.name}
                    onChange={(e) => setNewRow((v) => ({ ...v, name: e.target.value }))}
                    className="mb-1 h-8 w-28 font-mono text-xs"
                  />
                  <Input
                    placeholder="Display Name"
                    value={newRow.display_name}
                    onChange={(e) => setNewRow((v) => ({ ...v, display_name: e.target.value }))}
                    className="h-8 w-32"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Unlimited"
                    value={newRow.monthly_cost_limit_usd}
                    onChange={(e) => setNewRow((v) => ({ ...v, monthly_cost_limit_usd: e.target.value }))}
                    className="h-8 w-24 font-mono"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    placeholder="Unlimited"
                    value={newRow.monthly_token_limit}
                    onChange={(e) => setNewRow((v) => ({ ...v, monthly_token_limit: e.target.value }))}
                    className="h-8 w-28 font-mono"
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    placeholder="Unlimited"
                    value={newRow.max_requests_per_day}
                    onChange={(e) => setNewRow((v) => ({ ...v, max_requests_per_day: e.target.value }))}
                    className="h-8 w-24 font-mono"
                  />
                </TableCell>
                <TableCell>
                  <ProviderPills
                    selected={newRow.allowed_providers}
                    onChange={(providers) => setNewRow((v) => ({ ...v, allowed_providers: providers }))}
                  />
                </TableCell>
                <TableCell></TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={addRow}
                      disabled={saving}
                    >
                      <Check className="h-4 w-4 text-green-600" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => { setIsAdding(false); setNewRow({ name: '', ...emptyEdit() }) }}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
              {/* Display settings for new row */}
              <TableRow>
                <TableCell colSpan={8} className="pt-0 pb-4">
                  <div className="grid grid-cols-2 gap-4 p-4 bg-muted/30 rounded-md">
                    <div className="col-span-2">
                      <label className="text-xs font-medium text-muted-foreground">Description</label>
                      <Input
                        value={newRow.description}
                        onChange={(e) => setNewRow((v) => ({ ...v, description: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="Short tagline for this plan"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Price Display</label>
                      <Input
                        value={newRow.price_display}
                        onChange={(e) => setNewRow((v) => ({ ...v, price_display: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="$0, $99, Custom"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Price Subtext</label>
                      <Input
                        value={newRow.price_subtext}
                        onChange={(e) => setNewRow((v) => ({ ...v, price_subtext: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="per month, one-time"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">CTA Label</label>
                      <Input
                        value={newRow.cta_label}
                        onChange={(e) => setNewRow((v) => ({ ...v, cta_label: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="Get started, Subscribe"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">CTA Link</label>
                      <Input
                        value={newRow.cta_href}
                        onChange={(e) => setNewRow((v) => ({ ...v, cta_href: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="URL or leave empty"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Sort Order</label>
                      <Input
                        type="number"
                        value={newRow.sort_order}
                        onChange={(e) => setNewRow((v) => ({ ...v, sort_order: e.target.value }))}
                        className="mt-1 h-8 w-24 font-mono"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Badge Text</label>
                      <Input
                        value={newRow.badge_text}
                        onChange={(e) => setNewRow((v) => ({ ...v, badge_text: e.target.value }))}
                        className="mt-1 h-8"
                        placeholder="Most Popular"
                      />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Purchase Action</label>
                      <Select
                        value={newRow.purchase_action}
                        onValueChange={(val) => setNewRow((v) => ({ ...v, purchase_action: val === '__none__' ? '' : val }))}
                      >
                        <SelectTrigger className="mt-1 h-8">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          {PURCHASE_ACTIONS.map((opt) => (
                            <SelectItem key={opt.value || '__none__'} value={opt.value || '__none__'}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground">Icon (SF Symbol)</label>
                      <Select
                        value={newRow.icon}
                        onValueChange={(val) => setNewRow((v) => ({ ...v, icon: val === '__none__' ? '' : val }))}
                      >
                        <SelectTrigger className="mt-1 h-8">
                          <SelectValue placeholder="None" />
                        </SelectTrigger>
                        <SelectContent>
                          {ICON_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value || '__none__'} value={opt.value || '__none__'}>
                              {opt.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    {newRow.purchase_action && (
                      <div>
                        <label className="text-xs font-medium text-muted-foreground">Stripe Price ID</label>
                        <Input
                          value={newRow.stripe_price_id ?? ''}
                          onChange={(e) => setNewRow((v) => ({ ...v, stripe_price_id: e.target.value }))}
                          className="mt-1 h-8 font-mono text-xs"
                          placeholder="price_1ABC..."
                        />
                      </div>
                    )}
                    <div className="flex items-center gap-2 self-end pb-1">
                      <button
                        type="button"
                        onClick={() => setNewRow((v) => ({ ...v, is_visible: !v.is_visible }))}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                          newRow.is_visible
                            ? 'border-green-500/30 bg-green-500/10 text-green-700'
                            : 'border-muted-foreground/30 bg-muted text-muted-foreground'
                        }`}
                      >
                        {newRow.is_visible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                        {newRow.is_visible ? 'Visible' : 'Hidden'}
                      </button>
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs font-medium text-muted-foreground">Feature Highlights (one per line)</label>
                      <Textarea
                        value={newRow.feature_highlights}
                        onChange={(e) => setNewRow((v) => ({ ...v, feature_highlights: e.target.value }))}
                        className="mt-1 text-sm"
                        rows={4}
                        placeholder={"Unlimited words\nAll languages supported\nPriority processing"}
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs font-medium text-muted-foreground">Allowed Model Labels (one per line)</label>
                      <Textarea
                        value={newRow.allowed_model_labels}
                        onChange={(e) => setNewRow((v) => ({ ...v, allowed_model_labels: e.target.value }))}
                        className="mt-1 text-sm"
                        rows={3}
                        placeholder={"Claude Sonnet\nClaude Haiku\nLlama 3.3"}
                      />
                    </div>
                  </div>
                </TableCell>
              </TableRow>
            </>
          )}
        </TableBody>
      </Table>

      {!isAdding && (
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => { setIsAdding(true); setError(null) }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add Plan
        </Button>
      )}
    </div>
  )
}
