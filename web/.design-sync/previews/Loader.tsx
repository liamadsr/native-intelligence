import { Loader } from '@native-intelligence/ui'

const cell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 12,
  minWidth: 96,
}
const caption: React.CSSProperties = { fontSize: 12, color: '#6b7280' }
const surface: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 40,
  alignItems: 'center',
  padding: 40,
  background: '#f9fafb',
  border: '1px solid #e5e7eb',
  borderRadius: 16,
}

export function SpinnerVariants() {
  const variants = ['circular', 'classic', 'pulse', 'dots'] as const
  return (
    <div style={surface}>
      {variants.map((v) => (
        <div key={v} style={cell}>
          <Loader variant={v} size="lg" />
          <span style={caption}>{v}</span>
        </div>
      ))}
    </div>
  )
}

export function RhythmVariants() {
  const variants = ['wave', 'bars', 'typing', 'terminal'] as const
  return (
    <div style={surface}>
      {variants.map((v) => (
        <div key={v} style={cell}>
          <Loader variant={v} size="lg" />
          <span style={caption}>{v}</span>
        </div>
      ))}
    </div>
  )
}

export function TextVariants() {
  return (
    <div style={surface}>
      <div style={cell}>
        <Loader variant="text-shimmer" size="lg" text="Processing capture" />
        <span style={caption}>text-shimmer</span>
      </div>
      <div style={cell}>
        <Loader variant="text-blink" size="lg" text="Extracting actions" />
        <span style={caption}>text-blink</span>
      </div>
      <div style={cell}>
        <Loader variant="loading-dots" size="lg" text="Summarizing" />
        <span style={caption}>loading-dots</span>
      </div>
    </div>
  )
}
