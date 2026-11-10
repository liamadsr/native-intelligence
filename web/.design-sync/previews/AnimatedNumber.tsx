import { AnimatedNumber } from '@native-intelligence/ui'

const stat: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  minWidth: 120,
}
const value: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'baseline',
  fontSize: 40,
  fontWeight: 600,
  letterSpacing: '-0.02em',
  color: '#030712',
  lineHeight: 1,
}
const label: React.CSSProperties = { fontSize: 14, color: '#6b7280' }

export function Stats() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32 }}>
      <div style={stat}>
        <span style={value}>
          <AnimatedNumber start={0} end={1240} />
        </span>
        <span style={label}>Meetings captured</span>
      </div>
      <div style={stat}>
        <span style={value}>
          <AnimatedNumber start={0} end={8600} />
        </span>
        <span style={label}>Action items created</span>
      </div>
      <div style={stat}>
        <span style={value}>
          <AnimatedNumber start={0} end={98} />%
        </span>
        <span style={label}>Extraction accuracy</span>
      </div>
    </div>
  )
}

export function WithDecimals() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32 }}>
      <div style={stat}>
        <span style={value}>
          <AnimatedNumber start={0} end={4.9} decimals={1} />
        </span>
        <span style={label}>Average rating</span>
      </div>
      <div style={stat}>
        <span style={value}>
          $<AnimatedNumber start={0} end={12.5} decimals={1} />k
        </span>
        <span style={label}>Hours saved per month</span>
      </div>
    </div>
  )
}
