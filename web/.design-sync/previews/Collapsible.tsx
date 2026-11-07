import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
  Button,
} from '@dial8/ui'

export function Open() {
  return (
    <Collapsible defaultOpen style={{ width: '100%', maxWidth: 380 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>Linked PRs (2)</p>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">Toggle</Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div style={{ display: 'grid', gap: 6, paddingTop: 8, fontSize: 14 }}>
          <div>#312 — Extract UI package · merged</div>
          <div>#318 — Onboarding tour polish · open</div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

export function Closed() {
  return (
    <Collapsible style={{ width: '100%', maxWidth: 380 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <p style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>Older captures (8)</p>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm">Show</Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div style={{ paddingTop: 8, fontSize: 14 }}>Archived sync meetings from last cycle.</div>
      </CollapsibleContent>
    </Collapsible>
  )
}
