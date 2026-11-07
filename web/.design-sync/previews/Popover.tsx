import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  Button,
  Input,
  Label,
} from '@dial8/ui'

// The capture harness scopes the portal to the cell, so the open popover
// renders anchored to its trigger inside the card.
export function Open() {
  return (
    <Popover open>
      <PopoverTrigger asChild>
        <Button variant="outline">Set due date</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div style={{ display: 'grid', gap: 12 }}>
          <div style={{ display: 'grid', gap: 4 }}>
            <p style={{ fontWeight: 600, fontSize: 14, margin: 0 }}>Due date</p>
            <p style={{ fontSize: 13, color: 'var(--muted-foreground, #6b7280)', margin: 0 }}>
              When should ENG-142 be completed?
            </p>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <Label htmlFor="pop-date">Date</Label>
            <Input id="pop-date" defaultValue="2026-06-30" />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function Trigger() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">Add label</Button>
      </PopoverTrigger>
      <PopoverContent>Pick a label for this action.</PopoverContent>
    </Popover>
  )
}
