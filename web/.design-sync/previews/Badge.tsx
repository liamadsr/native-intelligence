import { Badge } from '@native-intelligence/ui'

export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Badge variant="default">In progress</Badge>
      <Badge variant="secondary">Backlog</Badge>
      <Badge variant="outline">ENG-142</Badge>
      <Badge variant="destructive">Blocked</Badge>
    </div>
  )
}

export function StatusLabels() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Badge variant="secondary">Todo</Badge>
      <Badge>In review</Badge>
      <Badge variant="outline">Done</Badge>
      <Badge variant="destructive">Canceled</Badge>
    </div>
  )
}
