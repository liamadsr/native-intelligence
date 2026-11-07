// Runs inside the test sandbox (live-check/check.ts copies it there): opens the
// check's page in the sandbox's Chrome, or reads what was typed into it.
//   node sandbox-cdp.mjs open   |   node sandbox-cdp.mjs value
const PAGE = `data:text/html,${encodeURIComponent(`<title>live-check</title>
<body style="margin:0;background:rgb(29,78,216);color:white;font:40px sans-serif">
<p style="margin:24px">Dial8 live view check</p>
<textarea id="x" style="position:absolute;left:0;right:0;top:120px;height:520px;width:100%;font-size:32px"></textarea>`)}`
const cdp = 'http://127.0.0.1:9222'
const pages = async () => (await (await fetch(`${cdp}/json/list`)).json()).filter(t => t.type === 'page')

if (process.argv[2] === 'open') {
  const target = await (await fetch(`${cdp}/json/new?${PAGE}`, { method: 'PUT' })).json()
  await fetch(`${cdp}/json/activate/${target.id}`)
  for (const other of await pages()) if (other.id !== target.id) await fetch(`${cdp}/json/close/${other.id}`)
  console.log(JSON.stringify({ opened: target.id }))
} else {
  const page = (await pages()).find(t => t.title === 'live-check')
  if (!page) { console.log(JSON.stringify({ value: null })); process.exit(0) }
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: "document.getElementById('x').value", returnByValue: true } }))
  const reply = await new Promise(resolve => ws.addEventListener('message', event => resolve(JSON.parse(event.data))))
  console.log(JSON.stringify({ value: reply.result?.result?.value ?? null }))
  ws.close()
}
