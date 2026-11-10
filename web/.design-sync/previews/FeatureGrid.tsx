import { FeatureGrid, FeatureCard } from '@native-intelligence/ui'

// FeatureCard animates in via framer-motion `whileInView`; force the visible
// rested state so the headless single-frame capture isn't blank.
const reveal = (
  <style>{`.rounded-2xl.border.bg-white,.rounded-2xl.border{opacity:1!important;transform:none!important}`}</style>
)

const icon: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  borderRadius: 12,
  background: '#eef2ff',
  fontSize: 22,
  marginBottom: 16,
}

function Feature({
  glyph,
  title,
  body,
}: {
  glyph: string
  title: string
  body: string
}) {
  return (
    <FeatureCard>
      <div style={icon}>{glyph}</div>
      <h4 style={{ margin: 0, fontWeight: 600, fontSize: 18, color: '#030712' }}>
        {title}
      </h4>
      <p style={{ marginTop: 8, marginBottom: 0, fontSize: 14, color: '#4b5563' }}>
        {body}
      </p>
    </FeatureCard>
  )
}

export function ThreeColumn() {
  return (
    <div style={{ maxWidth: 1000 }}>
      {reveal}
      <FeatureGrid columns={3}>
        <Feature
          glyph="🎙️"
          title="Capture"
          body="Record meetings and get a clean, speaker-labeled transcript instantly."
        />
        <Feature
          glyph="📋"
          title="Projects"
          body="Action items land in your workflow with identifiers like ENG-42."
        />
        <Feature
          glyph="🤝"
          title="CRM"
          body="Contacts and companies enriched from every conversation you have."
        />
      </FeatureGrid>
    </div>
  )
}

export function TwoColumn() {
  return (
    <div style={{ maxWidth: 760 }}>
      {reveal}
      <FeatureGrid columns={2}>
        <Feature
          glyph="✉️"
          title="Email"
          body="Gmail and Outlook sync with AI-drafted replies in your voice."
        />
        <Feature
          glyph="📅"
          title="Calendar"
          body="Multi-provider calendar that links each meeting to its capture."
        />
      </FeatureGrid>
    </div>
  )
}
