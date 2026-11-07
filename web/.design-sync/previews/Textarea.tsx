import { Textarea, Label } from '@dial8/ui'

export function Default() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', maxWidth: 360 }}>
      <Label htmlFor="meeting-notes">Meeting notes</Label>
      <Textarea
        id="meeting-notes"
        placeholder="Add context before this capture is processed…"
        rows={4}
      />
    </div>
  )
}

export function WithValue() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%', maxWidth: 360 }}>
      <Textarea
        rows={4}
        defaultValue={
          'Team agreed to ship the onboarding tour before the end of the cycle. Liam owns the guided tour; design review on Thursday.'
        }
      />
      <Textarea rows={3} placeholder="Disabled" disabled />
    </div>
  )
}
