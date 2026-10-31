// The Knowledge base tab and the opening sequence before a Rolex hunt. Both draw from kb-data.js.
const KbGraph = (() => {
  const COLOR = {
    root: '#fff', hub: '#6e6e6e', 'official-hub': '#d9b44a', 'risk-hub': '#e5534b', 'tag-hub': '#1fbf6b', 'image-hub': '#5b9dff',
    official: '#d9b44a', risk: '#e5534b', tag: '#1fbf6b', image: '#5b9dff',
  }
  const KIND_LABEL = { root: 'Brand', hub: 'Topic', fact: 'Fact', official: 'Official', risk: 'Abuse signal', tag: 'Hashtag', image: 'Visual reference' }
  const leafColor = '#b5b5b5'
  const REVEAL_MS = 1600
  let canvas, ctx, info, graph, near, byId
  let w = 0, h = 0, scale = 0.6, ox = 0, oy = 0
  let hover = null, chosen = null, visible = false, started = 0, placed = false
  // Where the mouse is and how it is moving, in screen pixels.
  let mouse = null, lastFrame = 0
  const REACH = 180
  const CLEAR = 14 // Nodes this close stay put, or the one being pointed at would slide away from the click.
  const PUSH = 1.1
  const WAKE = 0.05
  const SPRING = 0.022
  const TUG = 0.012
  const DAMPING = 0.88
  const STILL = matchMedia('(prefers-reduced-motion: reduce)').matches

  const color = n => COLOR[n.kind] ?? leafColor
  const radius = n => n.kind === 'root' ? 30 : n.kind.endsWith('hub') ? 15 + Math.min(near.get(n.id).size, 20) * 0.45 : 3.5 + Math.min(near.get(n.id).size, 6) * 0.9

  function size() {
    const r = canvas.parentElement.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    w = r.width; h = r.height
    canvas.width = w * dpr; canvas.height = h * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  function fit() {
    scale = Math.min(w / 3300, h / 2800)
    ox = w / 2; oy = h / 2
  }
  const zoomAt = (px, py, by) => {
    const next = Math.min(3, Math.max(0.12, scale * by))
    ox = px - (px - ox) * (next / scale)
    oy = py - (py - oy) * (next / scale)
    scale = next
  }
  const drift = (n, t) => n.kind === 'root' ? [n.x, n.y] : [n.x + Math.sin(t / 1900 + n.x) * 3, n.y + Math.cos(t / 2300 + n.y) * 3]

  /** Moves nodes away from the mouse and along with its motion. Links pull neighbours along, and springs bring all of them home. */
  function flow(steps) {
    const home = n => [ox + (n.x + n.dx) * scale, oy + (n.y + n.dy) * scale]
    for (const n of graph.nodes) {
      n.ax = -n.dx * SPRING
      n.ay = -n.dy * SPRING
      if (!mouse) continue
      const [x, y] = home(n)
      const ddx = x - mouse.x, ddy = y - mouse.y
      const d = Math.hypot(ddx, ddy) || 1
      if (d > REACH) continue
      const near = 1 - d / REACH
      const push = d > CLEAR ? PUSH * near * near : 0
      n.ax += (ddx / d * push + mouse.vx * WAKE * near) / scale
      n.ay += (ddy / d * push + mouse.vy * WAKE * near) / scale
    }
    for (const [a, b] of graph.edges) {
      const p = byId.get(a), q = byId.get(b)
      const fx = (q.dx - p.dx) * TUG, fy = (q.dy - p.dy) * TUG
      p.ax += fx; p.ay += fy; q.ax -= fx; q.ay -= fy
    }
    const damp = DAMPING ** steps
    for (const n of graph.nodes) {
      n.vx = (n.vx + n.ax * steps) * damp
      n.vy = (n.vy + n.ay * steps) * damp
      n.dx += n.vx * steps
      n.dy += n.vy * steps
    }
    if (mouse) { mouse.vx *= 0.8 ** steps; mouse.vy *= 0.8 ** steps }
  }

  function draw(t) {
    if (!visible) return
    requestAnimationFrame(draw)
    flow(Math.min(2, (t - lastFrame) / 16.67 || 1))
    lastFrame = t
    const grown = Math.min(1, (t - started) / REVEAL_MS)
    ctx.clearRect(0, 0, w, h)
    const focus = hover ?? chosen
    const lit = focus ? near.get(focus.id) : null
    const at = new Map(graph.nodes.map(n => {
      const [x, y] = drift(n, t)
      return [n.id, { x: ox + (x * grown + n.dx) * scale, y: oy + (y * grown + n.dy) * scale }]
    }))
    ctx.lineWidth = 1
    for (const [a, b] of graph.edges) {
      const on = focus && (a === focus.id || b === focus.id)
      ctx.strokeStyle = on ? 'rgba(255,255,255,.75)' : focus ? 'rgba(255,255,255,.05)' : 'rgba(255,255,255,.2)'
      ctx.beginPath()
      ctx.moveTo(at.get(a).x, at.get(a).y)
      ctx.lineTo(at.get(b).x, at.get(b).y)
      ctx.stroke()
    }
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of graph.nodes) {
      const p = at.get(n.id)
      if (p.x < -160 || p.x > w + 160 || p.y < -60 || p.y > h + 60) continue
      const dim = focus && n !== focus && !lit.has(n.id)
      const r = radius(n) * Math.max(0.55, Math.min(1.5, scale * 1.7))
      ctx.globalAlpha = dim ? 0.15 : 1
      ctx.fillStyle = color(n)
      ctx.beginPath()
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fill()
      const big = n.kind === 'root' || n.kind.endsWith('hub')
      if (grown === 1 && (big || scale > 0.2 || n === focus || (lit && lit.has(n.id)))) {
        ctx.fillStyle = big ? '#fff' : '#cfcfcf'
        ctx.font = `${big ? 600 : 400} ${big ? 13 : 10}px system-ui, sans-serif`
        ctx.shadowColor = '#000'
        ctx.shadowBlur = 3
        ctx.fillText(n.label, p.x, p.y + r + 3)
        ctx.shadowBlur = 0
      }
    }
    ctx.globalAlpha = 1
  }

  function nodeAt(px, py) {
    let best = null, bestD = 16
    for (const n of graph.nodes) {
      const d = Math.hypot(ox + (n.x + n.dx) * scale - px, oy + (n.y + n.dy) * scale - py) - radius(n) * Math.max(0.55, Math.min(1.5, scale * 1.7))
      if (d < bestD) { best = n; bestD = d }
    }
    return best
  }

  function showInfo(n) {
    if (!n) {
      info.innerHTML = `<h2>Rolex</h2><p class="muted">Starter knowledge gathered before any hunt. Select a node to see what it connects to.</p>
        <p class="kb-stats"><b>${graph.nodes.length}</b> entries<br><b>${graph.edges.length}</b> links</p>`
      return
    }
    const links = [...near.get(n.id)].sort()
    const safe = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
    info.innerHTML = `<h2>${safe(n.label)}</h2><p class="kb-kind" style="color:${color(n)}">${KIND_LABEL[n.kind.replace('-hub', '')] ?? 'Topic'}</p>
      <p class="muted">${safe(n.about)}</p><p class="small muted">${links.length} ${links.length === 1 ? 'connection' : 'connections'}</p>
      <ul class="kb-links">${links.slice(0, 16).map(id => `<li>${safe(graph.nodes.find(x => x.id === id).label)}</li>`).join('')}</ul>`
  }

  function init(canvasEl, infoEl) {
    canvas = canvasEl
    ctx = canvas.getContext('2d')
    info = infoEl
    graph = RolexKb.buildGraph()
    near = new Map(graph.nodes.map(n => [n.id, new Set()]))
    for (const [a, b] of graph.edges) { near.get(a).add(b); near.get(b).add(a) }
    byId = new Map(graph.nodes.map(n => [n.id, n]))
    for (const n of graph.nodes) Object.assign(n, { dx: 0, dy: 0, vx: 0, vy: 0, ax: 0, ay: 0 })
    showInfo(null)
    let drag = null
    canvas.onpointerdown = e => {
      drag = { x: e.offsetX, y: e.offsetY, ox, oy, moved: false }
      mouse = null
      canvas.setPointerCapture(e.pointerId)
      canvas.classList.add('dragging')
    }
    canvas.onpointermove = e => {
      if (drag) {
        if (Math.hypot(e.offsetX - drag.x, e.offsetY - drag.y) > 4) drag.moved = true
        ox = drag.ox + e.offsetX - drag.x
        oy = drag.oy + e.offsetY - drag.y
        return
      }
      if (!STILL && e.pointerType === 'mouse') {
        mouse = { x: e.offsetX, y: e.offsetY, vx: mouse ? e.offsetX - mouse.x : 0, vy: mouse ? e.offsetY - mouse.y : 0 }
      }
      hover = nodeAt(e.offsetX, e.offsetY)
      canvas.style.cursor = hover ? 'pointer' : ''
    }
    canvas.onpointerup = e => {
      canvas.classList.remove('dragging')
      if (drag && !drag.moved) { chosen = nodeAt(e.offsetX, e.offsetY); showInfo(chosen) }
      drag = null
    }
    canvas.onpointerleave = () => { hover = null; mouse = null }
    canvas.addEventListener('wheel', e => {
      e.preventDefault()
      zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015))
    }, { passive: false })
    addEventListener('resize', () => { if (visible) size() })
  }

  function setVisible(on) {
    if (on === visible) return
    visible = on
    if (!on) return
    size()
    if (!placed) { fit(); placed = true; started = performance.now() }
    requestAnimationFrame(draw)
  }

  return { init, setVisible, zoom: by => zoomAt(w / 2, h / 2, by), fit: () => fit() }
})()

/** Plays the fixed gathering sequence, and resolves when it ends or the person skips it. */
const KbIntro = (() => {
  const ROW_MS = 340
  const END_MS = 1100
  const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`)
  const watch = w => {
    const bezel = w.bezel === 'split'
      ? '<path d="M18 40a22 22 0 0 1 44 0z" fill="#b3202a"/><path d="M18 40a22 22 0 0 0 44 0z" fill="#1c3f94"/>'
      : `<circle cx="40" cy="40" r="22" fill="${w.bezel}"/>`
    const ticks = Array.from({ length: 12 }, (_, i) => `<rect x="39.4" y="24" width="1.2" height="3" fill="#fff" transform="rotate(${i * 30} 40 40)"/>`).join('')
    return `<svg viewBox="0 0 80 80" aria-hidden="true"><rect x="28" y="0" width="24" height="80" rx="3" fill="${w.band}"/><circle cx="40" cy="40" r="24" fill="#d4d6d9"/>${bezel}<circle cx="40" cy="40" r="17" fill="${w.dial}" stroke="#333" stroke-width=".5"/>${ticks}<path d="M40 40V27M40 40l8 5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/><path d="M36.5 31l1 2.6h5l1-2.6-1.8 1.2L40 30l-1.700 2.200z" fill="#d6b25e"/></svg>`
  }
  const renderItem = (kind, item) => {
    if (kind === 'watches') return `<figure class="kb-shot">${watch(item)}<figcaption>${esc(item.name)}<small>rolex.com · ${esc(item.ref)}</small></figcaption></figure>`
    return `<li class="${kind === 'patterns' ? 'kb-pattern' : ''}">${esc(item)}</li>`
  }

  function play(root) {
    const sections = RolexKb.GATHER
    const total = sections.reduce((n, s) => n + s.items.length, 0)
    root.innerHTML = `<div class="kb-intro-head"><div><h2>Building starter knowledge for Rolex</h2>
        <p id="kbIntroLine" class="muted"></p></div><button id="kbIntroSkip" type="button">Skip</button></div>
      <div class="kb-bar"><i id="kbIntroBar"></i></div>
      <div class="kb-intro-grid">${sections.map((s, i) => `<section class="kb-col" data-col="${i}" hidden><h3>${esc(s.title)}</h3>
        ${s.kind === 'watches' ? '<div class="kb-shots"></div>' : '<ul class="kb-rows"></ul>'}</section>`).join('')}</div>`
    root.hidden = false
    return new Promise(resolve => {
      let timer
      let done = 0
      const finish = () => { clearTimeout(timer); root.hidden = true; root.innerHTML = ''; resolve() }
      root.querySelector('#kbIntroSkip').onclick = finish
      const line = root.querySelector('#kbIntroLine')
      const bar = root.querySelector('#kbIntroBar')
      const steps = sections.flatMap((s, i) => s.items.map(item => ({ i, s, item })))
      const next = () => {
        const step = steps[done]
        if (!step) {
          line.textContent = `Starter knowledge ready: ${total} references. Sending out the spiders.`
          timer = setTimeout(finish, END_MS)
          return
        }
        const col = root.querySelector(`[data-col="${step.i}"]`)
        col.hidden = false
        col.querySelector('.kb-rows, .kb-shots').insertAdjacentHTML('beforeend', renderItem(step.s.kind, step.item))
        done++
        line.textContent = `${step.s.title}: ${done} of ${total} references`
        bar.style.width = `${done / total * 100}%`
        timer = setTimeout(next, ROW_MS)
      }
      next()
    })
  }
  return { play }
})()
