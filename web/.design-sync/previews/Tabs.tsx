import { Tabs, TabsList, TabsTrigger, TabsContent, Badge } from '@dial8/ui'

export function Default() {
  return (
    <Tabs defaultValue="summary" style={{ width: '100%', maxWidth: 420 }}>
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="transcript">Transcript</TabsTrigger>
        <TabsTrigger value="actions">Actions</TabsTrigger>
      </TabsList>
      <TabsContent value="summary">
        Weekly sync · 30 min · 4 attendees. The team aligned on shipping the
        onboarding tour before the end of the cycle.
      </TabsContent>
      <TabsContent value="transcript">
        Full Deepgram transcript with speaker labels for Liam, Sarah, and Marcus.
      </TabsContent>
      <TabsContent value="actions">
        3 action items extracted · 1 assigned to you.
      </TabsContent>
    </Tabs>
  )
}

export function WithBadge() {
  return (
    <Tabs defaultValue="inbox" style={{ width: '100%', maxWidth: 420 }}>
      <TabsList>
        <TabsTrigger value="inbox">
          Inbox <Badge style={{ marginLeft: 6 }}>12</Badge>
        </TabsTrigger>
        <TabsTrigger value="assigned">Assigned</TabsTrigger>
        <TabsTrigger value="done">Done</TabsTrigger>
      </TabsList>
      <TabsContent value="inbox">
        ENG-142 · ENG-138 · ENG-131 — newly captured action items awaiting triage.
      </TabsContent>
      <TabsContent value="assigned">2 actions assigned to Liam this cycle.</TabsContent>
      <TabsContent value="done">9 actions completed in the current cycle.</TabsContent>
    </Tabs>
  )
}
