import { Label, Input, Switch } from '@native-intelligence/ui'

export function WithInput() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 320 }}>
      <Label htmlFor="workspace-name">Workspace name</Label>
      <Input id="workspace-name" defaultValue="Native Intelligence" />
    </div>
  )
}

export function WithControl() {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Switch id="digest" defaultChecked />
      <Label htmlFor="digest">Send me a daily morning brief</Label>
    </div>
  )
}
