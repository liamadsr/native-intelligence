import { Input, Label } from '@dial8/ui'

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 320 }}>
      <Label htmlFor="capture-title">Capture title</Label>
      <Input id="capture-title" placeholder="Weekly sync" />
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 320 }}>
      <Input placeholder="Search actions, captures, contacts…" />
      <Input defaultValue="ENG-142 — Extract presentational UI" />
      <Input placeholder="Disabled field" disabled />
    </div>
  )
}
