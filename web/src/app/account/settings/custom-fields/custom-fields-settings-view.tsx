'use client'

/**
 * Settings → Custom fields: the workspace's own fields on each kind that
 * takes them (the entity registry's `customFields` flag: contacts,
 * companies, tasks, projects, initiatives, documents). Pick a kind, see its
 * fields, add one with the same form a record's panel uses (AddFieldForm).
 * A deal's fields are its pipeline's columns, added in the pipeline.
 *
 * This is where a kind gets its FIRST field: a record's panel hides the
 * section while its kind has none (hide empty widgets).
 */
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { AddFieldForm } from '@/components/crm/custom-fields-group'
import { cn } from '@/lib/utils'
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_KIND_NOUNS,
  CUSTOM_FIELD_TYPE_LABELS as TYPE_LABEL,
  hasOptions,
  type CustomFieldDefinition,
  type CustomFieldEntity,
} from '@/lib/crm/custom-fields'

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** The kind picker: one pill per kind the registry gives fields, in its order. */
export function CustomFieldKindPicker({ value, onChange }: { value: CustomFieldEntity; onChange: (kind: CustomFieldEntity) => void }) {
  return (
    <div role="tablist" aria-label="Kind" className="flex flex-wrap gap-1.5">
      {CUSTOM_FIELD_ENTITIES.map((kind) => (
        <button
          key={kind}
          type="button"
          role="tab"
          aria-selected={kind === value}
          data-kind={kind}
          onClick={() => onChange(kind)}
          className={cn(
            'rounded-full border px-3 py-1 text-xs transition-colors',
            kind === value
              ? 'border-foreground/20 bg-foreground text-background'
              : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
          )}
        >
          {capitalize(CUSTOM_FIELD_KIND_NOUNS[kind].many)}
        </button>
      ))}
    </div>
  )
}

export function CustomFieldsSettingsView({ initialKind = 'action' }: { initialKind?: CustomFieldEntity }) {
  const [kind, setKind] = useState<CustomFieldEntity>(initialKind)
  const [state, setState] = useState<{ kind: CustomFieldEntity; fields: CustomFieldDefinition[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async (k: CustomFieldEntity) => {
    setError(null)
    try {
      const res = await fetch(`/api/account/custom-fields?entity_type=${k}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('Could not load the fields')
      const json = (await res.json()) as { fields?: CustomFieldDefinition[] }
      setState({ kind: k, fields: json.fields ?? [] })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the fields')
    }
  }, [])

  useEffect(() => {
    void load(kind)
  }, [kind, load])

  const nouns = CUSTOM_FIELD_KIND_NOUNS[kind]
  const fields = state?.kind === kind ? state.fields : null

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 py-8">
        <h1 className="text-lg font-semibold">Custom fields</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Your workspace&apos;s own fields: a renewal date on companies, a budget on projects, a customer on tasks. Each one shows on every record of its kind, and your agent can fill it in.
        </p>

        <div className="mt-6">
          <CustomFieldKindPicker
            value={kind}
            onChange={(k) => {
              setKind(k)
              setAdding(false)
            }}
          />
        </div>

        {error && <p className="mt-6 text-sm text-destructive">{error}</p>}

        {!fields && !error && (
          <div className="mt-6 space-y-2" aria-label="Loading">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {fields && (
          <section className="mt-6 rounded-lg border border-border">
            {fields.length === 0 && !adding && (
              <p className="px-4 py-3 text-sm text-muted-foreground">No fields on {nouns.many} yet.</p>
            )}
            {fields.length > 0 && (
              <ul className="divide-y divide-border">
                {fields.map((f) => (
                  <li key={f.id} className="flex items-center gap-3 px-4 py-2.5" data-custom-field={f.key}>
                    <span className="min-w-0 flex-1 truncate text-sm">{f.label}</span>
                    {hasOptions(f.field_type) && f.options.length > 0 && (
                      <span className="hidden max-w-[50%] truncate text-xs text-muted-foreground sm:block" title={f.options.join(', ')}>
                        {f.options.join(', ')}
                      </span>
                    )}
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{TYPE_LABEL[f.field_type]}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className={cn('py-2', fields.length > 0 && 'border-t border-border')}>
              {adding ? (
                <AddFieldForm
                  entityType={kind}
                  onDone={(added) => {
                    setAdding(false)
                    if (added) void load(kind)
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="flex items-center gap-1 px-4 py-1 text-xs text-muted-foreground hover:text-foreground"
                >
                  <Plus className="h-3 w-3" /> Add a field to {nouns.many}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
