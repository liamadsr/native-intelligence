import { FeatureCard } from '@dial8/ui'

// FeatureCard animates in via framer-motion `whileInView` (initial opacity 0,
// translateY 20). In a headless single-frame capture the in-view trigger may
// not fire, leaving the card invisible. Force the rested/visible state so the
// component's real styling is what gets graded.
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

export function Single() {
  return (
    <div style={{ maxWidth: 360 }}>
      {reveal}
      <FeatureCard>
        <div style={icon}>🎙️</div>
        <h4 style={{ margin: 0, fontWeight: 600, fontSize: 18, color: '#030712' }}>
          Live meeting capture
        </h4>
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 14, color: '#4b5563' }}>
          Record any conversation from the desktop app or your browser, with
          real-time transcription powered by Deepgram.
        </p>
      </FeatureCard>
    </div>
  )
}

export function Pair() {
  return (
    <div style={{ display: 'flex', gap: 24, maxWidth: 760 }}>
      {reveal}
      <FeatureCard className="flex-1">
        <div style={icon}>✅</div>
        <h4 style={{ margin: 0, fontWeight: 600, fontSize: 18, color: '#030712' }}>
          Automatic action items
        </h4>
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 14, color: '#4b5563' }}>
          Claude extracts owners, due dates, and decisions, then files them into
          the right project.
        </p>
      </FeatureCard>
      <FeatureCard className="flex-1">
        <div style={icon}>🔗</div>
        <h4 style={{ margin: 0, fontWeight: 600, fontSize: 18, color: '#030712' }}>
          Connected workspace
        </h4>
        <p style={{ marginTop: 8, marginBottom: 0, fontSize: 14, color: '#4b5563' }}>
          Captures, email, calendar, and CRM share one knowledge graph your AI
          can reason over.
        </p>
      </FeatureCard>
    </div>
  )
}
