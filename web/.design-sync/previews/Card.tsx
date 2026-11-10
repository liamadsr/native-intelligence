import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  Button,
  Badge,
} from '@native-intelligence/ui'

export function Default() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <CardTitle>Weekly sync</CardTitle>
        <CardDescription>Tuesday · 30 min · 4 attendees</CardDescription>
      </CardHeader>
      <CardContent>
        Captured 3 action items and 1 decision. The team agreed to ship the
        onboarding tour before the end of the cycle.
      </CardContent>
      <CardFooter style={{ display: 'flex', gap: 8 }}>
        <Button size="sm">Open capture</Button>
        <Button size="sm" variant="outline">
          Share
        </Button>
      </CardFooter>
    </Card>
  )
}

export function WithBadge() {
  return (
    <Card style={{ maxWidth: 380 }}>
      <CardHeader>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <CardTitle>ENG-142</CardTitle>
          <Badge>In progress</Badge>
        </div>
        <CardDescription>Extract presentational UI into a package</CardDescription>
      </CardHeader>
      <CardContent>Assigned to Liam · due this cycle</CardContent>
    </Card>
  )
}
