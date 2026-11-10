import { Switch, Label } from '@native-intelligence/ui'

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Switch id="s1" />
        <Label htmlFor="s1">Auto-record detected meetings</Label>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Switch id="s2" defaultChecked />
        <Label htmlFor="s2">Notify me when a capture is ready</Label>
      </div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <Switch id="s3" defaultChecked disabled />
        <Label htmlFor="s3">Sync with calendar (enterprise)</Label>
      </div>
    </div>
  )
}
