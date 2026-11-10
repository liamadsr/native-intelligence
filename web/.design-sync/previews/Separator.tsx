import { Separator } from '@native-intelligence/ui'

export function Horizontal() {
  return (
    <div style={{ width: '100%', maxWidth: 320 }}>
      <div style={{ fontSize: 14, fontWeight: 600 }}>Weekly sync</div>
      <div style={{ fontSize: 13, opacity: 0.7 }}>Tuesday · 30 min</div>
      <Separator style={{ margin: '12px 0' }} />
      <div style={{ fontSize: 13, opacity: 0.7 }}>3 action items · 1 decision</div>
    </div>
  )
}

export function Vertical() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 24, fontSize: 14 }}>
      <span>Captures</span>
      <Separator orientation="vertical" />
      <span>Actions</span>
      <Separator orientation="vertical" />
      <span>Contacts</span>
    </div>
  )
}
