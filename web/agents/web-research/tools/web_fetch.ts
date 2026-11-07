// No web_fetch: OpenAI's web search (./web_search.ts) opens and reads pages
// itself, on OpenAI's side. A fetch from this deployment would be a second
// way onto the web, from Dial8's servers, for pages a model picked out of
// untrusted search results. Removed structurally; the harness-lockdown test
// pins it.
import { disableTool } from 'eve/tools'

export default disableTool()
