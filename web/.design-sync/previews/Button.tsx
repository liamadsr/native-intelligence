import { Button } from '@dial8/ui'

export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Button variant="default">Create capture</Button>
      <Button variant="secondary">Save draft</Button>
      <Button variant="outline">Cancel</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">Learn more</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Button>Enabled</Button>
      <Button disabled>Disabled</Button>
      <Button variant="outline" disabled>
        Disabled outline
      </Button>
    </div>
  )
}
