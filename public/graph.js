// A small force-directed graph on canvas. No library, so the demo runs with no network.
const GraphView = (() => {
  const ZONE = { knowledge: -220, findings: 0, orchestration: 240 }
  const SIZE = { brand: 18, orchestrator: 15, domain: 10, account: 10, channel: 10, seller: 8, scout: 10, reasoner: 10, lane: 6, listing: 7, wallet: 8 }
  const FLOW = new Set(['steered', 'spawned', 'searching'])
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches

  let canvas, ctx, onSelect
  let nodes = new Map(), edges = [], layers = { knowledge: true, findings: true, orchestration: true }
  let view = { x: 0, y: 0, k: 1 }, alpha = 1, visible = false, raf = 0, colors = {}, selected = null, hover = null, t = 0
  let drag = null, autoFit = true, settle = true

  const shown = n => layers[n.layer] || n.kind === 'brand'
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const readColors = () => {
    colors = { ink: css('--ink'), muted: css('--muted'), line: css('--line'), panel: css('--panel'), accent: css('--accent') }
    for (const t of ['verified', 'candidate', 'infringing', 'suspect', 'cleared', 'agent', 'brand', 'unknown']) colors[t] = css(`--t-${t}`)
  }

  function init(el, select) {
    canvas = el; ctx = el.getContext('2d'); onSelect = select
    readColors()
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors)
    new ResizeObserver(() => { resize(); wake() }).observe(el)
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    el.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 0.89, e.offsetX, e.offsetY) }, { passive: false })
    resize()
  }

  function resize() {
    const r = canvas.getBoundingClientRect()
    if (!r.width) return
    const d = devicePixelRatio || 1
    canvas.width = r.width * d; canvas.height = r.height * d
  }

  function update(g) {
    const next = new Map()
    const seedFor = id => {
      const e = g.edges.find(x => (x.from === id && nodes.has(x.to)) || (x.to === id && nodes.has(x.from)))
      return e && nodes.get(e.from === id ? e.to : e.from)
    }
    let added = false
    for (const n of g.nodes) {
      const old = nodes.get(n.id)
      if (old) { next.set(n.id, Object.assign(old, n)); continue }
      const near = seedFor(n.id)
      const a = Math.random() * 6.28
      next.set(n.id, { ...n, x: (near?.x ?? ZONE[n.layer]) + Math.cos(a) * 30, y: (near?.y ?? 0) + Math.sin(a) * 30, vx: 0, vy: 0, born: t })
      added = true
    }
    const changed = added || next.size !== nodes.size || g.edges.length !== edges.length
    nodes = next
    edges = g.edges
    if (selected && !nodes.has(selected)) selected = null
    if (changed) { alpha = Math.max(alpha, 0.7); wake() }
  }

  function tick() {
    const list = [...nodes.values()].filter(shown)
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]
        let dx = a.x - b.x, dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = Math.random(); dy = Math.random(); d2 = 1 }
        if (d2 > 40000) continue
        const f = (620 / d2) * alpha
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f
      }
      // Each layer has its own side, so the three stories read apart.
      a.vx += (ZONE[a.layer] - a.x) * 0.016 * alpha
      a.vy += -a.y * 0.028 * alpha
    }
    for (const e of edges) {
      const [a, b] = [nodes.get(e.from), nodes.get(e.to)]
      if (!shown(a) || !shown(b)) continue
      const dx = b.x - a.x, dy = b.y - a.y
      const d = Math.hypot(dx, dy) || 1
      const f = ((d - (e.kind === 'owns' ? 62 : 38)) / d) * 0.05 * alpha
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f
    }
    for (const n of list) {
      if (n === drag?.node) { n.vx = n.vy = 0; continue }
      n.vx *= 0.82; n.vy *= 0.82
      n.x += n.vx; n.y += n.vy
    }
    const brand = list.find(n => n.kind === 'brand')
    if (brand && brand !== drag?.node) { brand.x = ZONE.knowledge; brand.y = 0 }
    alpha = Math.max(alpha * 0.985, 0.002)
  }

  function shape(n, r) {
    ctx.beginPath()
    if (n.kind === 'listing') ctx.rect(n.x - r, n.y - r, r * 2, r * 2)
    else if (['account', 'channel', 'seller'].includes(n.kind)) { ctx.moveTo(n.x, n.y - r * 1.2); ctx.lineTo(n.x + r * 1.2, n.y); ctx.lineTo(n.x, n.y + r * 1.2); ctx.lineTo(n.x - r * 1.2, n.y); ctx.closePath() }
    else if (n.kind === 'scout') { ctx.moveTo(n.x, n.y - r * 1.2); ctx.lineTo(n.x + r * 1.1, n.y + r * 0.8); ctx.lineTo(n.x - r * 1.1, n.y + r * 0.8); ctx.closePath() }
    else if (n.kind === 'wallet' || n.kind === 'orchestrator') { for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283; ctx[i ? 'lineTo' : 'moveTo'](n.x + Math.cos(a) * r * 1.1, n.y + Math.sin(a) * r * 1.1) } ctx.closePath() }
    else ctx.arc(n.x, n.y, r, 0, 6.283)
  }

  function draw() {
    const d = devicePixelRatio || 1
    ctx.setTransform(d, 0, 0, d, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.translate(view.x, view.y)
    ctx.scale(view.k, view.k)
    const focus = selected ?? hover
    const near = new Set(focus ? [focus] : [])
    if (focus) for (const e of edges) { if (e.from === focus) near.add(e.to); if (e.to === focus) near.add(e.from) }

    for (const e of edges) {
      const [a, b] = [nodes.get(e.from), nodes.get(e.to)]
      if (!shown(a) || !shown(b)) continue
      const lit = focus && (e.from === focus || e.to === focus)
      ctx.globalAlpha = focus && !lit ? 0.12 : 1
      const steer = e.kind === 'steered'
      ctx.strokeStyle = steer ? colors.accent : e.kind === 'resembles' ? colors.infringing : lit ? colors.ink : colors.muted
      if (!focus && !steer && e.kind !== 'resembles') ctx.globalAlpha = 0.45
      ctx.lineWidth = (steer ? 2.2 : lit ? 1.6 : 1) / Math.sqrt(view.k)
      ctx.setLineDash(FLOW.has(e.kind) || e.kind === 'resembles' ? [5, 4] : [])
      ctx.lineDashOffset = FLOW.has(e.kind) && !calm ? -t * 0.4 : 0
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke()
      if (steer) arrow(a, b)
      if (lit) label(e.kind.replaceAll('_', ' '), (a.x + b.x) / 2, (a.y + b.y) / 2, 9, colors.muted)
    }
    ctx.setLineDash([])

    for (const n of nodes.values()) {
      if (!shown(n)) continue
      const r = SIZE[n.kind] ?? 7
      ctx.globalAlpha = focus && !near.has(n.id) ? 0.2 : 1
      const running = n.kind === 'reasoner' && n.detail === 'running'
      if (!calm && (t - n.born < 80 || running)) {
        const p = running ? (t % 60) / 60 : (t - n.born) / 80
        ctx.strokeStyle = colors[n.trust]; ctx.lineWidth = 1.5
        ctx.globalAlpha *= 1 - p
        ctx.beginPath(); ctx.arc(n.x, n.y, r + p * 22, 0, 6.283); ctx.stroke()
        ctx.globalAlpha = focus && !near.has(n.id) ? 0.2 : 1
      }
      shape(n, r)
      if (n.trust === 'candidate') { ctx.fillStyle = colors.panel; ctx.fill(); ctx.strokeStyle = colors.candidate; ctx.lineWidth = 2; ctx.setLineDash([3, 2]); ctx.stroke(); ctx.setLineDash([]) }
      else { ctx.fillStyle = colors[n.trust] ?? colors.unknown; ctx.fill() }
      if (n.id === selected) { ctx.strokeStyle = colors.ink; ctx.lineWidth = 2; ctx.stroke() }
      const always = ['brand', 'orchestrator', 'scout', 'reasoner'].includes(n.kind) || (n.layer === 'knowledge' && n.kind !== 'listing')
      if (always || near.has(n.id) || view.k > 1.5) label(n.label, n.x, n.y + r + 11, n.kind === 'brand' ? 13 : 10, colors.ink)
    }
    ctx.globalAlpha = 1
  }

  function arrow(a, b) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x)
    const [x, y] = [b.x - Math.cos(ang) * 11, b.y - Math.sin(ang) * 11]
    ctx.fillStyle = colors.accent
    ctx.beginPath(); ctx.moveTo(x, y)
    ctx.lineTo(x - Math.cos(ang - 0.45) * 8, y - Math.sin(ang - 0.45) * 8)
    ctx.lineTo(x - Math.cos(ang + 0.45) * 8, y - Math.sin(ang + 0.45) * 8)
    ctx.closePath(); ctx.fill()
  }

  function label(text, x, y, size, color) {
    const s = text.length > 26 ? `${text.slice(0, 25)}…` : text
    // Text stays readable when the whole graph is zoomed out to fit.
    ctx.font = `${size / Math.min(1, view.k)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.lineWidth = 3; ctx.strokeStyle = colors.panel; ctx.strokeText(s, x, y)
    ctx.fillStyle = color; ctx.fillText(s, x, y)
  }

  const hasMotion = () => alpha > 0.005 || drag || (!calm && [...nodes.values()].some(n => n.layer === 'orchestration' || t - n.born < 80))
  function frame() {
    raf = 0
    if (!visible) return
    t++
    // Lay out ahead of time, so opening a finished hunt does not start from a tangle.
    if (settle && nodes.size) { settle = false; for (let i = 0; i < 220; i++) tick(); fit(false); for (const n of nodes.values()) n.born = -999 }
    tick()
    if (autoFit) fit(true)
    draw()
    if (hasMotion()) raf = requestAnimationFrame(frame)
  }
  function wake() { if (visible && !raf) raf = requestAnimationFrame(frame) }

  function fit(soft) {
    const list = [...nodes.values()].filter(shown)
    const r = canvas.getBoundingClientRect()
    if (!list.length || !r.width) return
    const xs = list.map(n => n.x), ys = list.map(n => n.y)
    const [x0, x1, y0, y1] = [Math.min(...xs) - 50, Math.max(...xs) + 50, Math.min(...ys) - 50, Math.max(...ys) + 50]
    const k = Math.min(1.6, r.width / (x1 - x0), r.height / (y1 - y0))
    const target = { k, x: r.width / 2 - (k * (x0 + x1)) / 2, y: r.height / 2 - (k * (y0 + y1)) / 2 }
    const m = soft ? 0.15 : 1
    view = { k: view.k + (target.k - view.k) * m, x: view.x + (target.x - view.x) * m, y: view.y + (target.y - view.y) * m }
    if (!soft) { autoFit = true; alpha = Math.max(alpha, 0.05); wake() }
  }

  function zoomAt(f, x, y) {
    autoFit = false
    const k = Math.min(5, Math.max(0.2, view.k * f))
    view.x = x - ((x - view.x) / view.k) * k
    view.y = y - ((y - view.y) / view.k) * k
    view.k = k
    alpha = Math.max(alpha, 0.01)
    wake()
  }

  const toWorld = e => ({ x: (e.offsetX - view.x) / view.k, y: (e.offsetY - view.y) / view.k })
  function pick(e) {
    const p = toWorld(e)
    let best = null, bestD = 18 / view.k + 4
    for (const n of nodes.values()) {
      if (!shown(n)) continue
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      if (d < bestD) { best = n; bestD = d }
    }
    return best
  }
  function down(e) {
    canvas.setPointerCapture(e.pointerId)
    const node = pick(e)
    drag = { node, sx: e.offsetX, sy: e.offsetY, vx: view.x, vy: view.y, moved: false }
    autoFit = false
  }
  function move(e) {
    if (!drag) {
      const n = pick(e)
      if ((n?.id ?? null) !== hover) { hover = n?.id ?? null; canvas.style.cursor = n ? 'pointer' : 'grab'; alpha = Math.max(alpha, 0.01); wake() }
      return
    }
    if (Math.hypot(e.offsetX - drag.sx, e.offsetY - drag.sy) > 3) drag.moved = true
    if (drag.node) { const p = toWorld(e); drag.node.x = p.x; drag.node.y = p.y; alpha = Math.max(alpha, 0.15) }
    else { view.x = drag.vx + e.offsetX - drag.sx; view.y = drag.vy + e.offsetY - drag.sy }
    wake()
  }
  function up() {
    if (drag && !drag.moved) select(drag.node?.id ?? null)
    drag = null
  }
  function select(id) {
    selected = id
    onSelect(id ? nodes.get(id) : null)
    alpha = Math.max(alpha, 0.01)
    wake()
  }

  return {
    init, update, select,
    fit: () => fit(false),
    zoom: f => { const r = canvas.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2) },
    setLayer(name, on) { layers[name] = on; alpha = Math.max(alpha, 0.5); autoFit = true; wake() },
    setVisible(on) { visible = on; if (on) { resize(); readColors(); alpha = Math.max(alpha, 0.3); autoFit = true; wake() } },
    reset() { nodes = new Map(); edges = []; selected = null; hover = null; alpha = 1; autoFit = true; settle = true; view = { x: 0, y: 0, k: 1 } },
  }
})()
