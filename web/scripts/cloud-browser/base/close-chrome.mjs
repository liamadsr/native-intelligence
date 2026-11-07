// Ask Chrome to close itself over CDP (Browser.close), which writes its session
// and cookies like a person quitting. Used by stop.sh before the session stops.
const version = await fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(2000) })
  .then(r => r.json()).catch(() => null)
if (!version?.webSocketDebuggerUrl) process.exit(0) // not running
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve) => {
  const done = setTimeout(resolve, 3000)
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  ws.onmessage = () => { clearTimeout(done); resolve() }
  ws.onclose = () => { clearTimeout(done); resolve() }
  ws.onerror = () => { clearTimeout(done); resolve() }
})
process.exit(0)
