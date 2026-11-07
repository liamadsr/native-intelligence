import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from '@dial8/ui'

export function Palette() {
  return (
    <Command style={{ width: '100%', maxWidth: 360, border: '1px solid var(--border)', borderRadius: 8 }}>
      <CommandInput placeholder="Search captures, actions, contacts…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Actions">
          <CommandItem>
            Create capture
            <CommandShortcut>⌘N</CommandShortcut>
          </CommandItem>
          <CommandItem>
            New action item
            <CommandShortcut>⌘A</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Recent">
          <CommandItem>Weekly sync · Tuesday</CommandItem>
          <CommandItem>ENG-142 — Extract presentational UI</CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}
