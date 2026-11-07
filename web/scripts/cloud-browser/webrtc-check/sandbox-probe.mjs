// The WebRTC leak check (docs/plans/cloud-browser.md, C4). Runs inside a test
// sandbox from the base snapshot, with Chrome started by
// /opt/cloud-browser/start.sh:
//   vercel sandbox create --name <test> --snapshot <base> --timeout 20m --non-persistent
//   vercel sandbox exec <test> -- bash -c '(setsid bash /opt/cloud-browser/start.sh </dev/null >/tmp/boot.out 2>&1 &)'
//   vercel sandbox copy scripts/cloud-browser/webrtc-check/sandbox-probe.mjs <test>:/tmp/probe.mjs
//   vercel sandbox exec <test> -- node /tmp/probe.mjs
// Remove the sandbox afterwards. Two readings:
//   control: a STUN binding request straight from node (UDP), which shows
//            whether UDP leaves the sandbox at all and what address it shows;
//   chrome:  the ICE candidates a page's RTCPeerConnection gathers with the same
//            STUN server. With WebRtcIPHandling=disable_non_proxied_udp, there
//            must be no srflx (public address) candidate and no raw private IP.
import dgram from 'node:dgram'
import dns from 'node:dns/promises'
import { randomBytes } from 'node:crypto'

const STUN_HOST = 'stun.l.google.com', STUN_PORT = 19302

async function stunControl() {
  const [{ address }] = await dns.lookup(STUN_HOST, { all: true, family: 4 })
  const socket = dgram.createSocket('udp4')
  const id = randomBytes(12)
  const request = Buffer.concat([Buffer.from([0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42]), id])
  return await new Promise(resolve => {
    const timer = setTimeout(() => { socket.close(); resolve({ reached: false }) }, 4000)
    socket.on('message', message => {
      clearTimeout(timer); socket.close()
      let at = 20
      while (at + 4 <= message.length) {
        const type = message.readUInt16BE(at), length = message.readUInt16BE(at + 2)
        if (type === 0x0020) {
          const port = message.readUInt16BE(at + 6) ^ 0x2112
          const ip = [0, 1, 2, 3].map(i => message[at + 8 + i] ^ [0x21, 0x12, 0xa4, 0x42][i]).join('.')
          return resolve({ reached: true, mapped: `${ip}:${port}` })
        }
        at += 4 + length + ((4 - (length % 4)) % 4)
      }
      resolve({ reached: true, mapped: null })
    })
    socket.send(request, STUN_PORT, address)
  })
}

const PAGE = `data:text/html,${encodeURIComponent('<title>webrtc-probe</title><body>probe</body>')}`
const GATHER = `(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:${STUN_HOST}:${STUN_PORT}' }] })
  pc.createDataChannel('probe')
  const found = []
  pc.onicecandidate = event => { if (event.candidate) found.push(event.candidate.candidate) }
  await pc.setLocalDescription(await pc.createOffer())
  await new Promise(resolve => { const t = setTimeout(resolve, 8000); pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve() } } })
  const sdp = pc.localDescription?.sdp ?? ''
  pc.close()
  return { candidates: found, sdpCandidates: sdp.split('\\r\\n').filter(l => l.startsWith('a=candidate')) }
})()`

async function chrome() {
  const cdp = 'http://127.0.0.1:9222'
  const target = await (await fetch(`${cdp}/json/new?${PAGE}`, { method: 'PUT' })).json()
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise(resolve => ws.addEventListener('open', resolve))
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: GATHER, awaitPromise: true, returnByValue: true } }))
  const reply = await new Promise(resolve => ws.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.id === 1) resolve(m) }))
  ws.close()
  await fetch(`${cdp}/json/close/${target.id}`)
  return reply.result?.result?.value ?? { error: reply.result?.exceptionDetails?.text ?? 'no value' }
}

const policy = await import('node:fs').then(fs => { try { return fs.readFileSync('/etc/opt/chrome/policies/managed/dial8.json', 'utf8') } catch { return null } })
console.log(JSON.stringify({ control: await stunControl(), chrome: await chrome(), policy }, null, 2))
