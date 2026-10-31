// The hunt, drawn as a web being woven. Agents spin radial and spiral silk as they search, with a
// point at each junction. A listing sits on a junction, and a spider stays behind at each one
// flagged as an infringement. Agents only spin when they really search or read, and never retrace silk for show.
;(() => {
  const SURFACES = ['social', 'marketplace', 'video', 'domains', 'channels']
  const AGENT_LABEL = { social: 'Social media', marketplace: 'Marketplaces', video: 'Video sites', domains: 'Websites', channels: 'Group chats' }
  const RADIALS_PER_SURFACE = 6
  const SPREAD_RINGS = 6 // Listings scatter over this many rings, so spiders don't bunch up.
  const SPILL_RINGS = 3 // How far ahead a surface's part of the web gets before listings overflow elsewhere.
  const AMBIENT_RINGS = 8
  const MIN_SCALE = 0.03, MAX_SCALE = 5, ZOOM_STEP = 1.35
  const SILK_PER_ACTION = 3
  const CATCH_UP_PER_STRETCH = 10
  const hash = s => {
    let h = 2166136261
    for (const ch of String(s)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
    return h >>> 0
  }
  const noise = (seed, ...parts) => hash(`${seed}:${parts.join(':')}`) / 2 ** 32

  /** Where junctions go. Pure, and the same for the same hunt and the same case order. */
  function createLayout(seed) {
    const count = SURFACES.length * RADIALS_PER_SURFACE
    const gap = (Math.PI * 2) / count
    const radials = Array.from({ length: count }, (_, i) => ({
      index: i,
      surface: SURFACES[Math.floor(i / RADIALS_PER_SURFACE)],
      angle: i * gap + (noise(seed, 'angle', i) - 0.5) * gap * 0.7,
      knots: [],
    }))
    const placed = new Map()
    const knot = (r, k) => {
      const radial = radials[r]
      while (radial.knots.length <= k) {
        const ring = radial.knots.length
        const reach = (radial.knots[ring - 1]?.reach ?? 30) + 28 + noise(seed, 'gap', r, ring) * 20
        const angle = radial.angle + (noise(seed, 'bend', r, ring) - 0.5) * 0.09
        radial.knots.push({ id: `${r}/${ring}`, radial: r, ring, reach, x: Math.cos(angle) * reach, y: Math.sin(angle) * reach, woven: false, caseId: null })
      }
      return radial.knots[k]
    }
    return {
      radials,
      placed,
      knot,
      place(id, surface) {
        if (placed.has(id)) return placed.get(id)
        const known = SURFACES.includes(surface) ? surface : SURFACES[hash(surface) % SURFACES.length]
        const sector = radials.filter(r => r.surface === known)
        const pick = hash(id)
        const claim = j => { j.caseId = id; placed.set(id, j); return j }
        const scattered = knot(sector[pick % sector.length].index, ((pick >>> 8) % SPREAD_RINGS) + 1)
        if (!scattered.caseId) return claim(scattered)
        const nearest = among => {
          for (let k = 1; ; k++) {
            const free = among.filter(r => !knot(r.index, k).caseId)
            if (free.length) return knot(free[pick % free.length].index, k)
          }
        }
        // A busy surface spills into the emptiest part of the web, so no part of it sits bare.
        const own = nearest(sector), anywhere = nearest(radials)
        return claim(own.ring - anywhere.ring > SPILL_RINGS ? anywhere : own)
      },
    }
  }

  /** The same risk percent the Review tab shows. */
  const levelOf = c => c.verification?.score ?? c.triage?.score ?? 0.5
  // Most flagged pages score above 90%, so the top of the scale gets most of the hues.
  const HUE_STOPS = [[0, 140], [0.5, 125], [0.7, 95], [0.85, 65], [0.95, 40], [1, 0]]
  const riskHue = score => {
    const s = Math.min(1, Math.max(0, score))
    const i = HUE_STOPS.findIndex(([at]) => at >= s)
    if (i <= 0) return HUE_STOPS[0][1]
    const [a, hueA] = HUE_STOPS[i - 1], [b, hueB] = HUE_STOPS[i]
    return Math.round(hueA + (hueB - hueA) * (s - a) / (b - a))
  }
  const riskColor = score => `hsl(${riskHue(score)} 85% 55%)`
  /** Small nodes take a paler shade of the same hue, so that spiders stand out. */
  const paleRiskColor = score => `hsl(${riskHue(score)} 70% 82%)`

  const HUB = { id: 'hub', x: 0, y: 0, woven: true }
  const INFRINGING = new Set(['verified', 'awaiting_approval', 'approved'])
  const SPIDER = `<svg viewBox="-20 -20 40 40" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-3 -3 L-9 -9 L-14 -6 M3 -3 L9 -9 L14 -6 M-4 -1 L-11 -3 L-17 1 M4 -1 L11 -3 L17 1 M-4 1 L-11 3 L-16 9 M4 1 L11 3 L16 9 M-3 3 L-8 8 L-10 15 M3 3 L8 8 L10 15"/></g>
    <ellipse cx="0" cy="4" rx="4.4" ry="5.6" fill="currentColor"/><circle cx="0" cy="-3.2" r="2.9" fill="currentColor"/></svg>`

  let canvas, ctx, overlay, onPick
  let layout, edges, built, adjacency, agents, points, seed, status, started, seen, cases, seenEvents
  let live = false, earlierDue = false, visible = false, frame = 0, last = 0, hover = false, topRing = 0
  let cam = { x: 0, y: 0, s: 1 }, inset = 0, width = 0, height = 0, autoFit = true, drawnCam = ''
  const pointers = new Map()
  let pinch = 0
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  function init(c, o, pick) {
    canvas = c; overlay = o; onPick = pick
    ctx = c.getContext('2d')
    overlay.addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) onPick(b.dataset.id) })
    overlay.addEventListener('pointerover', e => { hover = !!e.target.closest('button[data-id]') })
    overlay.addEventListener('pointerleave', () => { hover = false })
    new ResizeObserver(resize).observe(c)
    bindZoom()
    reset('')
  }

  function reset(s, startingNow = false) {
    seed = s
    live = startingNow && !calm()
    earlierDue = false
    layout = createLayout(s)
    edges = []
    built = new Set()
    adjacency = new Map([['hub', []]])
    agents = new Map()
    points = new Map()
    seen = new Set()
    cases = new Map()
    seenEvents = new Set()
    earlierIds = new Set()
    status = 'running'
    started = null
    topRing = 0
    if (overlay) overlay.textContent = ''
    cam = { x: width / 2, y: height / 2, s: 1.5 }
    setAutoFit(true)
  }

  function setAutoFit(on) {
    autoFit = on
    document.getElementById('zoomFit')?.setAttribute('aria-pressed', String(on))
  }

  /** Zooms about a point on screen, which stays put. Any manual move stops the automatic fit until Fit is pressed. */
  function zoomAt(px, py, factor) {
    setAutoFit(false)
    const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cam.s * factor))
    cam.x = px - (px - cam.x) * (s / cam.s)
    cam.y = py - (py - cam.y) * (s / cam.s)
    cam.s = s
  }

  function bindZoom() {
    const middle = () => [(width - inset) / 2, height / 2]
    document.getElementById('zoomIn').onclick = () => zoomAt(...middle(), ZOOM_STEP)
    document.getElementById('zoomOut').onclick = () => zoomAt(...middle(), 1 / ZOOM_STEP)
    document.getElementById('zoomFit').onclick = () => setAutoFit(true)
    const stage = canvas.parentElement
    stage.addEventListener('wheel', e => {
      if (e.target.closest('.panel, .hud-actions')) return
      e.preventDefault()
      const r = canvas.getBoundingClientRect()
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)))
    }, { passive: false })
    canvas.addEventListener('pointerdown', e => {
      canvas.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      pinch = 0
      canvas.classList.add('dragging')
    })
    canvas.addEventListener('pointermove', e => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 1) {
        if (e.clientX === prev.x && e.clientY === prev.y) return
        setAutoFit(false)
        cam.x += e.clientX - prev.x
        cam.y += e.clientY - prev.y
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const apart = Math.hypot(a.x - b.x, a.y - b.y)
        const r = canvas.getBoundingClientRect()
        if (pinch) zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, apart / pinch)
        pinch = apart
      }
    })
    const release = e => {
      pointers.delete(e.pointerId)
      pinch = 0
      if (!pointers.size) canvas.classList.remove('dragging')
    }
    canvas.addEventListener('pointerup', release)
    canvas.addEventListener('pointercancel', release)
  }

  function resize() {
    const r = canvas.getBoundingClientRect()
    if (!r.width) return
    const dpr = devicePixelRatio || 1
    canvas.width = r.width * dpr
    canvas.height = r.height * dpr
    width = r.width; height = r.height
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  function curve(a, b, kind, id) {
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
    if (kind === 'ring') return { x: mx * 0.9, y: my * 0.9 } // Silk between radials sags towards the hub.
    const w = (noise(seed, 'wobble', id) - 0.5) * 5
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: mx - ((b.y - a.y) / len) * w, y: my + ((b.x - a.x) / len) * w }
  }
  const at = (e, from, t) => {
    const [p, q] = from === e.a ? [e.a, e.b] : [e.b, e.a]
    const u = 1 - t
    return { x: u * u * p.x + 2 * u * t * e.c.x + t * t * q.x, y: u * u * p.y + 2 * u * t * e.c.y + t * t * q.y }
  }
  function addEdge(a, b, kind) {
    const id = `${a.id}>${b.id}`
    built.add(id)
    const e = { a, b, kind, c: curve(a, b, kind, id), done: 0, length: Math.hypot(b.x - a.x, b.y - a.y) }
    edges.push(e)
    return e
  }
  function finish(e) {
    e.done = 1
    e.b.woven = true
    for (const [p, q] of [[e.a, e.b], [e.b, e.a]]) {
      if (!adjacency.has(p.id)) adjacency.set(p.id, [])
      adjacency.get(p.id).push({ to: q, edge: e })
    }
    for (const j of [e.a, e.b]) if (j.caseId) syncPoint(j)
  }

  const spineFrom = j => (j.ring ? layout.knot(j.radial, j.ring - 1) : HUB)
  const nextRadial = r => (r + 1) % layout.radials.length

  /** The next stretch of silk anywhere in the web, ring by ring from the middle, starting in this surface's part. */
  function frontier(surface, ceiling) {
    const start = Math.max(0, SURFACES.indexOf(surface)) * RADIALS_PER_SURFACE
    const order = [...layout.radials.slice(start), ...layout.radials.slice(0, start)]
    for (let k = 0; k < ceiling; k++) {
      for (const r of order) {
        const knot = layout.knot(r.index, k)
        const from = spineFrom(knot)
        if (!built.has(`${from.id}>${knot.id}`)) {
          if (from.woven) return { from, to: knot, kind: 'spine' }
          continue
        }
        const other = layout.knot(nextRadial(r.index), k)
        if (knot.woven && other.woven && !built.has(`${knot.id}>${other.id}`)) return { from: knot, to: other, kind: 'ring' }
      }
    }
    return null
  }

  function route(from, to) {
    if (from.id === to.id) return []
    const back = new Map([[from.id, null]])
    const queue = [from]
    while (queue.length) {
      const here = queue.shift()
      for (const step of adjacency.get(here.id) ?? []) {
        if (back.has(step.to.id)) continue
        back.set(step.to.id, { from: here, ...step })
        if (step.to.id === to.id) {
          const path = []
          for (let s = back.get(to.id); s; s = back.get(s.from.id)) path.unshift(s)
          return path
        }
        queue.push(step.to)
      }
    }
    return []
  }

  function agentFor(name, label, surface) {
    if (!agents.has(name)) agents.set(name, { name, label, surface, node: HUB, x: 0, y: 0, jobs: [], walk: [], step: null, lay: null, t: 0, silk: 0, phase: noise(seed, 'p', name) * 6, alpha: 0, heading: noise(seed, 'h', name) * 6 })
    return agents.get(name)
  }

  /** What this agent does next, or nothing. A listing waits for every ring inside it, then silk for what it really did. */
  function nextWork(a) {
    while (a.jobs.length && a.jobs[0].woven) a.jobs.shift()
    if (a.jobs.length) return frontier(a.surface, topRing + 1)
    if (!a.surface || a.silk <= 0 || status !== 'running') return null
    const stretch = frontier(a.surface, Math.max(AMBIENT_RINGS, topRing + 2))
    return stretch && { ...stretch, earned: true }
  }

  function advance(a, dt) {
    a.alpha = Math.min(1, a.alpha + dt * 2)
    const speed = (120 + a.jobs.length * 110) * dt
    if (a.lay) {
      a.t = Math.min(1, a.t + speed / Math.max(a.lay.length, 1))
      a.lay.done = a.t
      place(a, at(a.lay, a.lay.a, a.t))
      if (a.t >= 1) { a.node = a.lay.b; finish(a.lay); a.lay = null }
      return
    }
    if (a.step || a.walk.length) {
      if (!a.step) { a.step = a.walk.shift(); a.t = 0 }
      const e = a.step.edge
      a.t = Math.min(1, a.t + (speed * 1.8) / Math.max(e.length, 1))
      place(a, at(e, a.step.from, a.t))
      if (a.t >= 1) { a.node = a.step.to; a.step = null }
      return
    }
    if (a.post) {
      if (a.node.id !== a.post.id && a.post.woven) a.walk = route(a.node, a.post)
      return
    }
    const work = nextWork(a)
    if (work) {
      if (a.node.id !== work.from.id) {
        a.walk = route(a.node, work.from)
        if (a.walk.length) return
      }
      if (work.earned) a.silk--
      a.lay = addEdge(work.from, work.to, work.kind)
      a.t = 0
      return
    }
    a.idle = true
  }

  function place(a, p) {
    const dx = p.x - a.x, dy = p.y - a.y
    if (Math.abs(dx) + Math.abs(dy) > 0.01) a.heading = Math.atan2(dy, dx)
    a.x = p.x; a.y = p.y
    a.phase += Math.hypot(dx, dy) * 0.3
    a.idle = false
  }

  function syncPoint(j) {
    const c = cases.get(j.caseId)
    if (!c || !j.woven) return
    // A spider waits for ring silk to reach its node. An earlier find has no node until then.
    const tied = (adjacency.get(j.id)?.length ?? 0) >= 3 || status !== 'running'
    if (earlierIds.has(c.id) && !tied) return
    let el = points.get(j.caseId)
    if (!el) {
      el = document.createElement('button')
      el.type = 'button'
      el.dataset.id = j.caseId
      el.style.setProperty('--turn', `${Math.round(noise(seed, 'turn', j.id) * 360)}deg`)
      overlay.append(el)
      points.set(j.caseId, el)
      position(el, j)
    }
    const spider = INFRINGING.has(c.state) && tied
    const old = earlierIds.has(c.id)
    const klass = `web-point state-${c.state}${spider ? ' spider' : ''}${old ? ' earlier' : ''}${c.id === chosen ? ' chosen' : ''}`
    if (el.className !== klass) el.className = klass
    // Nobody read an unreadable page, so it has no real score to show.
    const color = spider ? riskColor(levelOf(c)) : c.state === 'unreadable' ? '' : paleRiskColor(levelOf(c))
    if (el.style.color !== color) el.style.color = color
    if (spider && !el.firstChild) el.innerHTML = SPIDER
    if (!spider && el.firstChild) el.textContent = ''
    const label = `${spider ? `Spider, ${Math.round(levelOf(c) * 100)}% risk` : 'Site'}${old ? ', earlier hunt' : ''}: ${c.hit?.title ?? 'listing'}`
    if (el.title !== label) { el.title = label; el.setAttribute('aria-label', label) }
  }
  let chosen = null
  let earlierIds = new Set()

  const sx = x => x * cam.s + cam.x
  const sy = y => y * cam.s + cam.y
  function position(el, j) { el.style.transform = `translate(${sx(j.x).toFixed(1)}px, ${sy(j.y).toFixed(1)}px)` }

  function updateCamera(dt) {
    if (!autoFit) return
    let reach = 130
    for (const r of layout.radials) for (const j of r.knots) if (j.woven) reach = Math.max(reach, j.reach + 34)
    const room = Math.min(width - inset, height) / 2
    const target = { s: Math.min(1.6, Math.max(MIN_SCALE, room / reach)), x: (width - inset) / 2, y: height / 2 }
    if (hover) return // A target doesn't move while it is about to be clicked.
    const k = Math.min(1, dt * 1.6)
    cam.s += (target.s - cam.s) * k
    cam.x += (target.x - cam.x) * k
    cam.y += (target.y - cam.y) * k
  }

  const thread = (alpha, w = 0.9) => { ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = w }

  function traceEdge(e) {
    ctx.moveTo(sx(e.a.x), sy(e.a.y))
    if (e.done >= 1) ctx.quadraticCurveTo(sx(e.c.x), sy(e.c.y), sx(e.b.x), sy(e.b.y))
    else for (let i = 1; i <= 10; i++) { const p = at(e, e.a, e.done * i / 10); ctx.lineTo(sx(p.x), sy(p.y)) }
  }

  function drawAnchors(age) {
    // Anchor threads shoot out first and carry on past the last junction on each radial.
    const grow = calm() ? 1 : Math.min(1, age / 1.4)
    const eased = 1 - (1 - grow) ** 3
    thread(0.14, 0.8)
    const edge = Math.hypot(width, height) + Math.hypot(cam.x - width / 2, cam.y - height / 2)
    for (const r of layout.radials) {
      const tip = r.knots.filter(j => j.woven).at(-1) ?? HUB
      ctx.beginPath()
      ctx.moveTo(sx(tip.x), sy(tip.y))
      const dist = Math.max(tip === HUB ? 0 : tip.reach, (edge / cam.s) * eased)
      ctx.lineTo(sx(Math.cos(r.angle) * dist), sy(Math.sin(r.angle) * dist))
      ctx.stroke()
    }
  }

  function drawAgent(a, labels) {
    if (a.alpha <= 0) return
    const x = sx(a.x), y = sy(a.y)
    ctx.save()
    ctx.globalAlpha = a.alpha
    ctx.translate(x, y)
    ctx.save()
    ctx.rotate(a.heading + Math.PI / 2)
    ctx.strokeStyle = '#fff'
    ctx.lineWidth = 1
    ctx.lineCap = 'round'
    ctx.beginPath()
    for (let i = 0; i < 4; i++) {
      for (const side of [-1, 1]) {
        const swing = Math.sin(a.phase + i * 1.7 + (side > 0 ? Math.PI : 0)) * 1.3
        const out = 6.5 + (i === 0 || i === 3 ? 1 : 0)
        const fy = -3.5 + i * 2.4
        ctx.moveTo(0, -1 + i * 0.8)
        ctx.lineTo(side * out * 0.7, fy - 2 + swing * 0.4)
        ctx.lineTo(side * out, fy + 1.5 + swing)
      }
    }
    ctx.stroke()
    ctx.fillStyle = '#fff'
    ctx.beginPath(); ctx.ellipse(0, 2, 2.3, 3.1, 0, 0, Math.PI * 2); ctx.fill()
    ctx.beginPath(); ctx.arc(0, -2.2, 1.6, 0, Math.PI * 2); ctx.fill()
    ctx.restore()
    if (!labels.some(l => Math.abs(l.x - x) < 90 && Math.abs(l.y - y) < 16)) {
      labels.push({ x, y })
      ctx.font = '11px system-ui, sans-serif'
      ctx.lineWidth = 3
      ctx.strokeStyle = '#000'
      ctx.strokeText(a.label, 11, 4)
      ctx.fillStyle = 'rgba(255,255,255,.72)'
      ctx.fillText(a.label, 11, 4)
    }
    ctx.restore()
  }

  function tick(now) {
    frame = visible ? requestAnimationFrame(tick) : 0
    if (!width) { resize(); if (!width) return }
    const dt = Math.min(0.05, (now - last) / 1000 || 0)
    last = now
    if (started === null) started = now
    updateCamera(dt)
    if (status !== 'paused') {
      for (const a of agents.values()) advance(a, dt)
      catchUp()
    }
    for (const a of agents.values()) {
      const parked = a.idle && !a.lay && !a.step && !a.walk.length
      if (parked && (a.leaving || (status !== 'running' && status !== 'paused'))) {
        a.alpha -= dt * 3.5 // More than advance adds back, so it fades out.
        if (a.alpha <= 0 && a.leaving) agents.delete(a.name)
      }
    }
    ctx.clearRect(0, 0, width, height)
    drawAnchors((now - started) / 1000)
    for (const [kind, alpha] of [['spine', 0.5], ['ring', 0.74]]) {
      thread(alpha, 0.9)
      ctx.beginPath()
      for (const e of edges) if (e.kind === kind) traceEdge(e)
      ctx.stroke()
    }
    ctx.fillStyle = '#fff'
    for (const r of layout.radials) for (const j of r.knots) {
      if (!j.woven || j.caseId) continue
      ctx.beginPath(); ctx.arc(sx(j.x), sy(j.y), Math.max(0.5, Math.min(1.7, cam.s * 1.4)), 0, Math.PI * 2); ctx.fill()
    }
    ctx.beginPath(); ctx.arc(cam.x, cam.y, 3.5, 0, Math.PI * 2); ctx.fill()
    const labels = []
    for (const a of agents.values()) drawAgent(a, labels)
    const moved = `${cam.x.toFixed(1)},${cam.y.toFixed(1)},${cam.s.toFixed(4)}`
    if (moved !== drawnCam) {
      drawnCam = moved
      overlay.style.setProperty('--z', Math.max(0.4, Math.min(1, cam.s / 0.8)).toFixed(2))
      for (const [id, el] of points) position(el, layout.placed.get(id))
    }
  }

  /** Agents spin one stretch at a time, so when pages pour in the web weaves itself to keep up with them. */
  function catchUp() {
    let backlog = 0
    for (const a of agents.values()) {
      while (a.jobs.length && a.jobs[0].woven) a.jobs.shift()
      backlog += a.jobs.length
    }
    for (let n = Math.ceil(backlog / CATCH_UP_PER_STRETCH); n > 0 && backlog; n--) {
      const work = frontier(SURFACES[n % SURFACES.length], topRing + 1)
      if (!work) break
      finish(addEdge(work.from, work.to, work.kind))
    }
  }

  /** Spin everything out to the highest listing at once, for a hunt that was already under way when opened. */
  function weaveNow() {
    for (let k = 0; k < topRing + 2; k++) {
      for (const r of layout.radials) {
        const knot = layout.knot(r.index, k)
        const from = spineFrom(knot)
        if (!built.has(`${from.id}>${knot.id}`)) finish(addEdge(from, knot, 'spine'))
      }
      for (const r of layout.radials) {
        const a = layout.knot(r.index, k), b = layout.knot(nextRadial(r.index), k)
        if (!built.has(`${a.id}>${b.id}`)) finish(addEdge(a, b, 'ring'))
      }
    }
  }

  /** Bring the picture up to date with the hunt. */
  function update(view, selected) {
    const first = !seen.size && !agents.size
    status = view.hunt.status
    chosen = selected
    const instant = calm() || (!live && first && view.cases.length > 0)
    for (const name of Object.keys(view.hunt.roster ?? {})) agentFor(name, AGENT_LABEL[name] ?? name, name)
    for (const c of view.cases) {
      if (!c.hit) continue
      cases.set(c.id, c)
      const j = layout.place(c.id, c.hit.surface)
      topRing = Math.max(topRing, j.ring)
      if (seen.has(c.id)) continue
      seen.add(c.id)
      if (!instant) {
        const surface = layout.radials[j.radial].surface
        agentFor(surface, AGENT_LABEL[surface] ?? surface, surface).jobs.push(j)
      }
    }
    // Already found, so they appear at once when opening a hunt. In a hunt starting now, its own searches
    // weave the web and these wait for the silk, without making it grow.
    let added = false
    for (const c of view.earlier ?? []) {
      if (!c.hit || seen.has(c.id)) continue
      seen.add(c.id)
      earlierIds.add(c.id)
      cases.set(c.id, c)
      const j = layout.place(c.id, c.hit.surface)
      if (live) continue
      topRing = Math.max(topRing, j.ring)
      added = true
    }
    // Once the hunt has stopped, the web finishes so that every earlier find has a place on it.
    if (live && !earlierDue && status !== 'running' && status !== 'paused') {
      earlierDue = true
      for (const id of earlierIds) {
        const j = layout.placed.get(id)
        topRing = Math.max(topRing, j.ring)
        const surface = layout.radials[j.radial].surface
        agentFor(surface, AGENT_LABEL[surface] ?? surface, surface).jobs.push(j)
      }
    }
    if (instant || added) weaveNow()
    for (const e of view.hunt.events ?? []) {
      const key = `${e.at}:${e.text}`
      if (seenEvents.has(key)) continue
      seenEvents.add(key)
      if (first || !/: (searching|reading) /.test(e.text)) continue
      const surface = SURFACES.find(s => e.text.startsWith(`${AGENT_LABEL[s]}:`))
      if (surface) agentFor(surface, AGENT_LABEL[surface], surface).silk += SILK_PER_ACTION
    }
    for (const id of seen) syncPoint(layout.placed.get(id))
    for (const s of view.hunt.spawns ?? []) {
      const j = layout.placed.get(s.caseId)
      const name = `r:${s.agent}`
      if (!j || calm()) continue
      if (!s.outcome) agentFor(name, 'Second opinion').post = j
      else if (agents.has(name)) Object.assign(agents.get(name), { post: null, leaving: true })
    }
  }

  function setVisible(on) {
    visible = on
    if (on && !frame) { resize(); last = performance.now(); frame = requestAnimationFrame(tick) }
  }
  const setInset = px => {
    inset = px
    const zoom = document.getElementById('webZoom')
    if (zoom) zoom.style.right = `${20 + px}px`
  }

  globalThis.WebLayout = createLayout
  globalThis.WebRiskColor = riskColor
  globalThis.WebPaleRiskColor = paleRiskColor
  globalThis.WebView = { init, reset, update, setVisible, setInset }
})()
