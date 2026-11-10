import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  Button,
  Input,
  Label,
} from '@native-intelligence/ui'

// The open Dialog renders a `position:fixed inset-0` backdrop that escapes the
// preview card, so we lead with the resting trigger. The full open dialog
// composition is kept below for the API reference / Claude to compose from.
export function Trigger() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">Share capture</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share capture</DialogTitle>
          <DialogDescription>
            Anyone with the link can view the summary and action items from
            “Weekly sync”.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: 'grid', gap: 8 }}>
          <Label htmlFor="dlg-email">Invite teammate</Label>
          <Input id="dlg-email" placeholder="sarah@dial8.ai" />
        </div>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Share</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
