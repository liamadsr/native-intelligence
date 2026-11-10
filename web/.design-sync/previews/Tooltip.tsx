import {
  Tooltip,
  TooltipProvider,
  TooltipTrigger,
  TooltipContent,
  Button,
} from '@native-intelligence/ui'

export function Default() {
  return (
    <TooltipProvider>
      <div style={{ padding: '48px 24px' }}>
        <Tooltip open>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm">
              Start capture
            </Button>
          </TooltipTrigger>
          <TooltipContent>Record this meeting (⌘R)</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  )
}
