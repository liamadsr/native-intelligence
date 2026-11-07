// Harness lockdown: the web-research agent searches the web and answers in a
// structure, nothing else. eve provisions a sandbox by default and makes its
// shell/filesystem tools live unless each is disabled, so every default it
// doesn't need is removed here structurally (never left to prose); the
// harness-lockdown test pins it.
import { disableTool } from 'eve/tools'

export default disableTool()
