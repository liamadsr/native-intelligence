import { Screenshot } from '@dial8/ui'

export function Dashboard() {
  return (
    <div style={{ maxWidth: 720 }}>
      <Screenshot
        width={1200}
        height={750}
        src="https://placehold.co/1200x750/eef2ff/4338ca/png?text=Native Intelligence+Dashboard"
      />
    </div>
  )
}

export function CaptureDetail() {
  return (
    <div style={{ maxWidth: 560 }}>
      <Screenshot
        width={1000}
        height={640}
        src="https://placehold.co/1000x640/ecfdf5/047857/png?text=Capture+%E2%80%94+Actions+%26+Decisions"
      />
    </div>
  )
}
