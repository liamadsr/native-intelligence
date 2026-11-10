import { Toggle } from '@native-intelligence/ui'

export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Toggle variant="default">Bold</Toggle>
      <Toggle variant="outline">Italic</Toggle>
      <Toggle variant="outline" defaultPressed>
        Underline
      </Toggle>
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Toggle>Mute</Toggle>
      <Toggle defaultPressed>Auto-record</Toggle>
      <Toggle disabled>Disabled</Toggle>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
      <Toggle variant="outline" size="sm">
        Sm
      </Toggle>
      <Toggle variant="outline" size="default">
        Default
      </Toggle>
      <Toggle variant="outline" size="lg">
        Lg
      </Toggle>
    </div>
  )
}
