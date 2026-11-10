import { Heading, Subheading, Lead } from '@native-intelligence/ui'

export function Typography() {
  return (
    <div style={{ maxWidth: 640, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Subheading>Meet Native Intelligence</Subheading>
      <Heading as="h1">The workspace where meetings become work.</Heading>
      <Lead>
        Capture every conversation, extract the actions and decisions, and keep
        your projects moving — without lifting a finger.
      </Lead>
    </div>
  )
}

export function HeadingLevels() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Heading as="h1">Heading level one</Heading>
      <Heading as="h2">Heading level two</Heading>
      <Subheading>Subheading eyebrow</Subheading>
    </div>
  )
}
