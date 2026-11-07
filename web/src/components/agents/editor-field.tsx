import { Label } from '@/components/ui/label'
import type { FieldRule } from '@/lib/agents/editable-fields'

/** One of the agent editor's fields: its label, an optional hint, and the reason when it's read-only. */
export function EditorField({
  label,
  labelId,
  hint,
  rule,
  children,
}: {
  label: string
  labelId?: string
  hint?: string
  rule: FieldRule
  children?: React.ReactNode
}) {
  return (
    <div className="space-y-1.5" data-editor-field={label} data-locked={rule.editable ? undefined : ''}>
      <Label id={labelId} className="text-sm text-muted-foreground">
        {label}
      </Label>
      {hint && rule.editable && <p className="-mt-1 text-xs text-muted-foreground">{hint}</p>}
      {children}
      {!rule.editable && (
        <p className="text-[11px] text-muted-foreground" data-locked-reason="">
          {rule.reason}
        </p>
      )}
    </div>
  )
}
