// Prueba de interfaz: maneja la ventana de Cancun con eventos reales de mouse y
// teclado por el protocolo de depuración de Chromium (abrir Cancun con
// --remote-debugging-port=9333). Uso: node scripts/ui.mjs <pasos.json>
// Cada paso: {"shot": "archivo.png"} | {"click": [x,y], "mods"?: 2} | {"drag": [[x,y],[x,y]]}
//            {"key": "Delete", "code"?: "Delete", "mods"?: 0} | {"wait": ms} | {"eval": "expresión"}

import { readFileSync, writeFileSync } from 'node:fs'

const steps = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const targets = await (await fetch('http://127.0.0.1:9333/json')).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
setTimeout(() => ws.send(JSON.stringify({ id: 99999, method: 'Runtime.enable' })), 0)
const pending = new Map()
let intercepted = null
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data)
  if (msg.method === 'Input.dragIntercepted') intercepted = msg.params.data
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) console.log('consola', msg.params.type, msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300))
  if (msg.method === 'Runtime.exceptionThrown') console.log('excepción', msg.params.exceptionDetails.exception?.description?.slice(0, 300) ?? msg.params.exceptionDetails.text)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const n = ++id
    pending.set(n, resolve)
    ws.send(JSON.stringify({ id: n, method, params }))
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra })

for (const s of steps) {
  if (s.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(s.shot, Buffer.from(r.result.data, 'base64'))
    console.log('captura', s.shot)
  } else if (s.click) {
    const [x, y] = s.click
    await mouse('mouseMoved', x, y, { button: 'none' })
    await mouse('mousePressed', x, y, { modifiers: s.mods ?? 0, buttons: 1 })
    await mouse('mouseReleased', x, y, { modifiers: s.mods ?? 0 })
    if (s.right) {
      await mouse('mousePressed', x, y, { button: 'right', buttons: 2 })
      await mouse('mouseReleased', x, y, { button: 'right' })
    }
  } else if (s.rightclick) {
    const [x, y] = s.rightclick
    await mouse('mousePressed', x, y, { button: 'right', buttons: 2 })
    await mouse('mouseReleased', x, y, { button: 'right' })
  } else if (s.drag) {
    const [[x0, y0], [x1, y1]] = s.drag
    await mouse('mouseMoved', x0, y0, { button: 'none' })
    await mouse('mousePressed', x0, y0, { buttons: 1 })
    const n = 12
    for (let i = 1; i <= n; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, { buttons: 1 })
      await sleep(16)
    }
    await mouse('mouseReleased', x1, y1)
  } else if (s.dnd) {
    // Arrastrar y soltar HTML5 (paneles → línea de tiempo).
    const [[x0, y0], [x1, y1]] = s.dnd
    intercepted = null
    await send('Input.setInterceptDrags', { enabled: true })
    await mouse('mouseMoved', x0, y0, { button: 'none' })
    await mouse('mousePressed', x0, y0, { buttons: 1 })
    for (let i = 1; i <= 6 && !intercepted; i++) {
      await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6, { buttons: 1 })
      await sleep(30)
    }
    if (!intercepted) console.log('no se interceptó el arrastre')
    else {
      for (const type of ['dragEnter', 'dragOver', 'drop']) await send('Input.dispatchDragEvent', { type, x: x1, y: y1, data: intercepted })
    }
    await mouse('mouseReleased', x1, y1)
    await send('Input.cancelDragging')
    await send('Input.setInterceptDrags', { enabled: false })
  } else if (s.key) {
    const base = { key: s.key, code: s.code ?? s.key, modifiers: s.mods ?? 0, windowsVirtualKeyCode: s.vk ?? 0 }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  } else if (s.profile) {
    // Perfil de CPU: funciones con más tiempo propio durante s.profile ms.
    await send('Profiler.enable')
    await send('Profiler.start')
    await sleep(s.profile)
    const r = await send('Profiler.stop')
    const prof = r.result.profile
    const self = new Map()
    const dt = prof.timeDeltas
    const byId = new Map(prof.nodes.map((n) => [n.id, n]))
    prof.samples.forEach((id, i) => {
      const n = byId.get(id)
      const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0))
    })
    const total = [...self.values()].reduce((a, b) => a + b, 0)
    for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(((v / total) * 100).toFixed(1) + '%', k)
  } else if (s.wait) {
    await sleep(s.wait)
  } else if (s.eval) {
    const r = await send('Runtime.evaluate', { expression: s.eval, returnByValue: true, awaitPromise: true })
    console.log('eval', JSON.stringify(r.result?.result?.value ?? r.result))
  }
  await sleep(s.after ?? 250)
}
ws.close()
