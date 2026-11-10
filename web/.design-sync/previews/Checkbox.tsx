import { Checkbox, Label } from '@native-intelligence/ui'

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="c1" />
        <Label htmlFor="c1">Send follow-up email</Label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="c2" defaultChecked />
        <Label htmlFor="c2">Auto-extract action items</Label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="c3" defaultChecked disabled />
        <Label htmlFor="c3">Link to calendar event</Label>
      </div>
    </div>
  )
}

export function Checklist() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="t1" defaultChecked />
        <Label htmlFor="t1">Connect your calendar</Label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="t2" defaultChecked />
        <Label htmlFor="t2">Record your first capture</Label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Checkbox id="t3" />
        <Label htmlFor="t3">Invite a teammate</Label>
      </div>
    </div>
  )
}
