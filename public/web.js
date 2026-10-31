// The hunt, drawn as a web being woven. Agents spin radial and spiral silk as they search, with a
// point at each junction. A listing sits on a junction, and a spider stays behind at each one
// flagged as an infringement. Agents only spin when they really search or read, and never retrace silk for show.
;(() => {
  const SURFACES = ['social', 'marketplace', 'video', 'domains', 'channels']
  const AGENT_LABEL = { social: 'Social media', marketplace: 'Marketplaces', video: 'Video sites', domains: 'Websites', channels: 'Group chats' }
  const RADIALS_PER_SURFACE = 3
  const SPREAD_RINGS = 6 // Listings scatter over this many rings, so spiders don't bunch up.
  const AMBIENT_RINGS = 8
  const FAR = 2600
  const SILK_PER_ACTION = 3
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
        const reach = (radial.knots[ring - 1]?.reach ?? 30) + 40 + noise(seed, 'gap', r, ring) * 34
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
        const radial = sector[pick % sector.length]
        // Starts on a scattered ring and moves on until it finds a free junction in this surface's part of the web.
        for (let tries = 0; ; tries++) {
          const r = sector[(radial.index % sector.length + tries) % sector.length]
          const k = ((pick >>> 8) % SPREAD_RINGS) + 1 + Math.floor(tries / sector.length)
          const j = knot(r.index, k)
          if (!j.caseId) {
            j.caseId = id
            placed.set(id, j)
            return j
          }
        }
      },
    }
  }

  const HUB = { id: 'hub', x: 0, y: 0, woven: true }
  const INFRINGING = new Set(['verified', 'awaiting_approval', 'approved'])
  const SPIDER = `<svg viewBox="-20 -20 40 40" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
    <path d="M-3 -3 L-9 -9 L-14 -6 M3 -3 L9 -9 L14 -6 M-4 -1 L-11 -3 L-17 1 M4 -1 L11 -3 L17 1 M-4 1 L-11 3 L-16 9 M4 1 L11 3 L16 9 M-3 3 L-8 8 L-10 15 M3 3 L8 8 L10 15"/></g>
    <ellipse cx="0" cy="4" rx="4.4" ry="5.6" fill="currentColor"/><circle cx="0" cy="-3.2" r="2.9" fill="currentColor"/></svg>`

  let canvas, ctx, overlay, onPick
  let layout, edges, built, adjacency, agents, points, seed, status, started, seen, cases, seenEvents
  let visible = false, frame = 0, last = 0, hover = false, topRing = 0
  let cam = { x: 0, y: 0, s: 1 }, inset = 0, width = 0, height = 0
  const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

  function init(c, o, pick) {
    canvas = c; overlay = o; onPick = pick
    ctx = c.getContext('2d')
    overlay.addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) onPick(b.dataset.id) })
    overlay.addEventListener('pointerover', e => { hover = !!e.target.closest('button[data-id]') })
    overlay.addEventListener('pointerleave', () => { hover = false })
    new ResizeObserver(resize).observe(c)
    reset('')
  }

  function reset(s) {
    seed = s
    layout = createLayout(s)
    edges = []
    built = new Set()
    adjacency = new Map([['hub', []]])
    agents = new Map()
    points = new Map()
    seen = new Set()
    cases = new Map()
    seenEvents = new Set()
    status = 'running'
    started = null
    topRing = 0
    if (overlay) overlay.textContent = ''
    cam = { x: width / 2, y: height / 2, s: 1.5 }
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
    if (e.b.caseId) syncPoint(e.b)
  }

  const spineFrom = j => (j.ring ? layout.knot(j.radial, j.ring - 1) : HUB)
  const nextRadial = r => (r + 1) % layout.radials.length

  /** The next stretch of silk towards a listing's junction, innermost first. */
  function towards(j) {
    for (let k = 0; k <= j.ring; k++) {
      const knot = layout.knot(j.radial, k)
      const from = spineFrom(knot)
      if (!built.has(`${from.id}>${knot.id}`)) return from.woven ? { from, to: knot, kind: 'spine' } : null
    }
    return null
  }

  /** The next stretch of spiral in this surface's part of the web, working outwards. */
  function ambient(surface, ceiling) {
    const sector = layout.radials.filter(r => r.surface === surface)
    for (let k = 0; k < ceiling; k++) {
      for (const r of sector) {
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

  /** What this agent does next, or nothing. Listings it found come first, then silk for what it really did. */
  function nextWork(a) {
    while (a.jobs.length) {
      const j = a.jobs[0]
      if (j.woven) { a.jobs.shift(); continue }
      const stretch = towards(j)
      if (stretch) return stretch
      break
    }
    if (!a.surface || a.silk <= 0 || status !== 'running') return null
    const stretch = ambient(a.surface, Math.max(AMBIENT_RINGS, topRing + 2))
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
    const spider = INFRINGING.has(c.state)
    const klass = `web-point state-${c.state}${spider ? ' spider' : ''}${c.id === chosen ? ' chosen' : ''}`
    if (el.className !== klass) el.className = klass
    if (spider && !el.firstChild) el.innerHTML = SPIDER
    if (!spider && el.firstChild) el.textContent = ''
    const label = `${spider ? 'Spider' : 'Site'}: ${c.hit?.title ?? 'listing'}`
    if (el.title !== label) { el.title = label; el.setAttribute('aria-label', label) }
  }
  let chosen = null

  const sx = x => x * cam.s + cam.x
  const sy = y => y * cam.s + cam.y
  function position(el, j) { el.style.transform = `translate(${sx(j.x).toFixed(1)}px, ${sy(j.y).toFixed(1)}px)` }

  function updateCamera(dt) {
    let reach = 130
    for (const r of layout.radials) for (const j of r.knots) if (j.woven) reach = Math.max(reach, j.reach + 34)
    const room = Math.min(width - inset, height) / 2
    const target = { s: Math.min(1.6, Math.max(0.3, room / reach)), x: (width - inset) / 2, y: height / 2 }
    if (hover) return // A target doesn't move while it is about to be clicked.
    const k = Math.min(1, dt * 1.6)
    cam.s += (target.s - cam.s) * k
    cam.x += (target.x - cam.x) * k
    cam.y += (target.y - cam.y) * k
  }

  const thread = (alpha, w = 0.9) => { ctx.strokeStyle = `rgba(255,255,255,${alpha})`; ctx.lineWidth = w }

  function drawEdge(e) {
    ctx.beginPath()
    ctx.moveTo(sx(e.a.x), sy(e.a.y))
    if (e.done >= 1) ctx.quadraticCurveTo(sx(e.c.x), sy(e.c.y), sx(e.b.x), sy(e.b.y))
    else for (let i = 1; i <= 10; i++) { const p = at(e, e.a, e.done * i / 10); ctx.lineTo(sx(p.x), sy(p.y)) }
    ctx.stroke()
  }

  function drawAnchors(age) {
    // Anchor threads shoot out first and carry on past the last junction on each radial.
    const grow = calm() ? 1 : Math.min(1, age / 1.4)
    const eased = 1 - (1 - grow) ** 3
    thread(0.2, 0.8)
    for (const r of layout.radials) {
      const tip = r.knots.filter(j => j.woven).at(-1) ?? HUB
      ctx.beginPath()
      ctx.moveTo(sx(tip.x), sy(tip.y))
      const dist = Math.max(tip === HUB ? 0 : tip.reach, FAR * eased)
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
    if (status !== 'paused') for (const a of agents.values()) advance(a, dt)
    for (const a of agents.values()) {
      const parked = a.idle && !a.lay && !a.step && !a.walk.length
      if (parked && (a.leaving || (status !== 'running' && status !== 'paused'))) {
        a.alpha -= dt * 3.5 // More than advance adds back, so it fades out.
        if (a.alpha <= 0 && a.leaving) agents.delete(a.name)
      }
    }
    ctx.clearRect(0, 0, width, height)
    drawAnchors((now - started) / 1000)
    for (const e of edges) { thread(e.kind === 'ring' ? 0.74 : 0.5, 0.9); drawEdge(e) }
    ctx.fillStyle = '#fff'
    for (const r of layout.radials) for (const j of r.knots) {
      if (!j.woven || j.caseId) continue
      ctx.beginPath(); ctx.arc(sx(j.x), sy(j.y), 1.7, 0, Math.PI * 2); ctx.fill()
    }
    ctx.beginPath(); ctx.arc(cam.x, cam.y, 3.5, 0, Math.PI * 2); ctx.fill()
    const labels = []
    for (const a of agents.values()) drawAgent(a, labels)
    for (const [id, el] of points) position(el, layout.placed.get(id))
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
    const instant = calm() || (first && view.cases.length > 0)
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
    if (instant) weaveNow()
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
  const setInset = px => { inset = px }

  globalThis.WebLayout = createLayout
  globalThis.WebView = { init, reset, update, setVisible, setInset }
})()
