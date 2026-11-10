import { BentoCard } from '@native-intelligence/ui'

function CaptureGraphic() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(circle at 30% 25%, #c7d2fe 0%, transparent 45%), radial-gradient(circle at 75% 70%, #a5b4fc 0%, transparent 50%), linear-gradient(135deg, #eef2ff, #e0e7ff)',
      }}
    />
  )
}

function CrmGraphic() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background:
          'radial-gradient(circle at 70% 30%, #bbf7d0 0%, transparent 50%), linear-gradient(135deg, #ecfdf5, #d1fae5)',
      }}
    />
  )
}

export function SingleCard() {
  return (
    <div style={{ maxWidth: 420 }}>
      <BentoCard
        eyebrow="Capture"
        title="Every meeting becomes work."
        description="Native Intelligence records the conversation, then extracts the actions, decisions, and follow-ups — automatically routed to the right project."
        graphic={<CaptureGraphic />}
        fade={['bottom']}
      />
    </div>
  )
}

export function Grid() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
        gap: 24,
        maxWidth: 880,
      }}
    >
      <BentoCard
        eyebrow="Actions"
        title="Nothing slips through."
        description="Action items get identifiers like ENG-42 and flow into your team's workflow states the moment a call ends."
        graphic={<CaptureGraphic />}
      />
      <BentoCard
        dark
        eyebrow="CRM"
        title="Know every contact."
        description="Interaction history, voice identification, and company context — assembled from the meetings you already have."
        graphic={<CrmGraphic />}
      />
    </div>
  )
}
