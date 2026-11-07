// Runs inside the test sandbox (exit-check/check.ts copies it there): loads a
// page in the sandbox's Chrome and prints what it shows, as JSON.
//   node sandbox-probe.mjs https://checkip.amazonaws.com/
const cdp = 'http://127.0.0.1:9222'
const url = process.argv[2]
const target = await (await fetch(`${cdp}/json/new?${url}`, { method: 'PUT' })).json()
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(resolve => ws.addEventListener('open', resolve))
let id = 0
const call = (method, params = {}) => new Promise(resolve => {
  const mine = ++id
  ws.addEventListener('message', function onMessage(event) {
    const message = JSON.parse(event.data)
    if (message.id === mine) { ws.removeEventListener('message', onMessage); resolve(message.result) }
  })
  ws.send(JSON.stringify({ id: mine, method, params }))
})
let page = { text: '', title: '' }
for (let i = 0; i < 40; i++) {
  await new Promise(resolve => setTimeout(resolve, 250))
  const out = await call('Runtime.evaluate', { expression: "JSON.stringify({ title: document.title, text: (document.body && document.body.innerText || '').slice(0, 300), ready: document.readyState })", returnByValue: true })
  page = JSON.parse(out?.result?.value ?? '{}')
  if (page.ready === 'complete' && (page.text || page.title)) break
}
console.log(JSON.stringify({ title: page.title, text: page.text }))
ws.close()
await fetch(`${cdp}/json/close/${target.id}`)
