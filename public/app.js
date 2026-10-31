const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const usd = n => `$${(n ?? 0).toFixed(n < 0.1 ? 4 : 2)}`

let huntId = null
let view = null
let selected = null
let socket = null
let version = -1

document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab) })
function showTab(tab) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== tab })
  if (tab === 'report') renderReport()
}

const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
const list = v => v.split(',').map(s => s.trim()).filter(Boolean)

$('form').onsubmit = async e => {
  e.preventDefault()
  $('formError').textContent = ''
  const f = new FormData(e.target)
  const res = await post('/api/hunts', {
    brand: f.get('brand'), keywords: list(f.get('keywords')), officialDomains: list(f.get('officialDomains')),
    authorizedSellers: list(f.get('authorizedSellers')), budgetUsd: Number(f.get('budgetUsd')), precision: f.get('precision'),
  })
  const body = await res.json()
  if (!res.ok) { $('formError').textContent = body.error; return }
  open(body.id)
  showTab('live')
}

function open(id) {
  huntId = id
  version = -1
  selected = null
  location.hash = id
  connect()
}

function connect() {
  socket?.close()
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws?hunt=${huntId}`)
  socket = ws
  ws.onmessage = e => {
    const v = JSON.parse(e.data)
    // Socket messages can arrive out of order, so older versions are dropped.
    if (v.version <= version) return
    version = v.version
    view = v
    render()
  }
  // Keeps the screen live across a server restart.
  ws.onclose = () => { if (socket === ws) { $('status').textContent = 'Reconnecting'; setTimeout(connect, 1000) } }
}

function render() {
  const { hunt } = view
  $('status').textContent = `${hunt.input.brand}: ${hunt.status.replace('_', ' ')}`
  renderLive(hunt)
  renderCases()
  renderGraph()
}

function renderLive(h) {
  const c = h.counters
  const costPer = c.verified ? h.spent / c.verified : 0
  $('counters').innerHTML = [
    ['Seen', c.seen], ['Triaged', c.triaged], ['Shortlisted', c.shortlisted], ['Verified', c.verified], ['Approved', c.approved],
    ['Duplicates prevented', c.duplicates], ['Undecided', c.undecided], ['Cost per verified', c.verified ? usd(costPer) : '–'],
  ].map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join('')
  const pct = Math.min(100, (h.spent / h.input.budgetUsd) * 100)
  $('meterFill').style.width = `${pct}%`
  $('meterText').textContent = `${usd(h.spent)} of ${usd(h.input.budgetUsd)} spent. Decider: ${h.mode}.${view.priorHunts > 0 ? ` Remembering ${view.priorHunts} earlier hunt(s).` : ''}`
  $('pause').textContent = h.status === 'paused' ? 'Resume' : 'Pause'
  if (document.activeElement !== $('budget')) $('budget').value = h.input.budgetUsd
  $('roster').innerHTML = Object.entries(h.roster).map(([name, s]) => {
    const key = `${s.lane.source}/${s.lane.strategy}`
    const st = view.lanes[key]
    const rate = st && st.costUsd > 0 ? (st.hits / st.costUsd).toFixed(0) : '–'
    return `<tr><td>${esc(name)}</td><td>${esc(s.lane.strategy)}</td><td>${esc(s.status.split(':')[0])}</td><td>${rate}</td></tr>`
  }).join('')
  $('steers').innerHTML = [...h.steers].reverse().map(s =>
    `<li><b>${esc(s.scout)}</b>: ${esc(s.from)} → ${esc(s.to)}. <span class="muted">${esc(s.reason)}</span></li>`).join('') || '<li class="muted">No steers yet.</li>'
  $('fallbacks').innerHTML = [...view.fallbacks].reverse().map(f =>
    `<li><b>${esc(f.from)}</b> fell through: <span class="muted">${esc(f.error)}</span></li>`).join('') || '<li class="muted">None.</li>'
}

const stageLabel = s => s.replaceAll('_', ' ')
const rank = c => ['awaiting_approval', 'undecided', 'verified', 'shortlisted', 'triaged'].indexOf(c.state)

function renderCases() {
  const rows = [...view.cases].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)].map(r => (r < 0 ? 9 : r))
    return x - y || (b.triage?.score ?? 0) - (a.triage?.score ?? 0)
  })
  $('caseRows').innerHTML = rows.map(c => {
    const d = c.verification ?? c.triage
    return `<tr class="click ${selected === c.id ? 'sel' : ''}" data-id="${esc(c.id)}">
      <td class="url">${esc(c.hit?.title)}</td><td>${esc(c.hit?.surface)}</td>
      <td>${d ? d.score.toFixed(2) : '–'}</td><td>${d ? d.confidence.toFixed(2) : '–'}</td>
      <td>${esc(d?.deciderId ?? '–')}</td><td class="state-${esc(c.state)}">${esc(stageLabel(c.state))}</td></tr>`
  }).join('')
  $('caseRows').querySelectorAll('tr').forEach(r => { r.onclick = () => { selected = r.dataset.id; renderCases() } })
  renderDetail()
}

function renderDetail() {
  const c = view.cases.find(x => x.id === selected)
  if (!c) { $('caseDetail').innerHTML = ''; return }
  const d = c.verification ?? c.triage
  const pending = c.state === 'awaiting_approval'
  $('caseDetail').innerHTML = `<div class="detail">
    <h2>${esc(c.hit?.title)}</h2>
    <p class="url">${esc(c.hit?.url)} <span class="muted">(do not open outside a sandbox)</span></p>
    <p>${esc(c.hit?.snippet)}</p>
    <p><b>Why flagged:</b> ${esc(d?.why ?? c.skipReason ?? 'not classified')}</p>
    ${d?.visualEvidenceUnavailable ? '<p class="muted">Visual evidence unavailable to this decider.</p>' : ''}
    ${c.hit?.evidenceText ? `<p><b>Evidence:</b> ${esc(c.hit.evidenceText)}</p>` : ''}
    <p class="muted">Reported by ${esc(c.reporters.join(', '))}</p>
    ${c.notice ? `<h2>Drafted notice</h2><pre>${esc(c.notice)}</pre>` : ''}
    ${c.approval ? `<p class="state-${esc(c.state)}">${c.approval.decision === 'approve' ? 'Approved. Simulated submit recorded; nothing was sent.' : 'Rejected. Stored as a label for this brand.'}</p>` : ''}
    ${c.recheck ? `<p>Re-check: ${esc(c.recheck.result)}</p>` : ''}
    <div class="actions">
      ${pending ? '<button class="primary" data-act="approve">Approve</button><button data-act="reject">Reject</button>' : ''}
      ${c.approval?.decision === 'approve' ? '<button data-act="resolved">Mark resolved</button><button data-act="relisted">Mark relisted</button>' : ''}
    </div></div>`
  $('caseDetail').querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      const a = b.dataset.act
      b.disabled = true
      if (a === 'approve' || a === 'reject') await post(`/api/hunts/${huntId}/cases/${c.id}/decision`, { decision: a })
      else await post(`/api/hunts/${huntId}/cases/${c.id}/recheck`, { result: a })
    }
  })
}

function renderGraph() {
  if (!view.graph.edges.length) { $('graphSvg').innerHTML = ''; return }
  const kind = n => n.split(':')[0]
  const nodes = [...new Set(view.graph.edges.flatMap(e => [e.from, e.to]))]
  const W = 900, H = 560
  const pos = new Map(nodes.map((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2
    const r = kind(n) === 'listing' ? 240 : 130
    return [n, [W / 2 + Math.cos(a) * r * 1.5, H / 2 + Math.sin(a) * r]]
  }))
  const label = n => { const v = n.slice(n.indexOf(':') + 1).replace(/^https:\/\//, ''); return v.length > 22 ? `${v.slice(0, 21)}…` : v }
  $('graphSvg').innerHTML =
    view.graph.edges.map(e => `<line x1="${pos.get(e.from)[0]}" y1="${pos.get(e.from)[1]}" x2="${pos.get(e.to)[0]}" y2="${pos.get(e.to)[1]}"/>`).join('') +
    nodes.map(n => `<g><circle class="k-${esc(kind(n))}" data-n="${esc(n)}" cx="${pos.get(n)[0]}" cy="${pos.get(n)[1]}" r="8"><title>${esc(kind(n))}</title></circle><text x="${pos.get(n)[0] + 10}" y="${pos.get(n)[1] + 3}">${esc(label(n))}</text></g>`).join('')
  $('graphSvg').querySelectorAll('circle').forEach(c => { c.onclick = () => showNode(c.dataset.n) })
}

function showNode(node) {
  const linked = new Set(view.graph.edges.filter(e => e.from === node || e.to === node).flatMap(e => [e.from, e.to]))
  const hits = view.cases.filter(c => linked.has(`listing:${c.hit?.url}`))
  $('graphCases').innerHTML = hits.map(c => `<li><a href="#" data-id="${esc(c.id)}">${esc(c.hit.title)}</a></li>`).join('') || '<li class="muted">No cases linked.</li>'
  $('graphCases').querySelectorAll('a').forEach(a => {
    a.onclick = e => { e.preventDefault(); selected = a.dataset.id; showTab('cases'); renderCases() }
  })
}

async function renderReport() {
  if (!huntId) { $('reportBody').innerHTML = '<p class="muted">Start or open a hunt first.</p>'; return }
  const r = await (await fetch(`/api/hunts/${huntId}/report`)).json()
  const t = r.totals
  const num = v => (typeof v === 'number' ? v.toFixed(v < 1 && v > 0 ? 4 : 0) : '–')
  $('reportBody').innerHTML = `<p class="muted">${esc(r.disclaimer)}</p>
    <div class="grid">
      <div class="tile"><b>${usd(t.spentUsd)}</b><span>Spend</span></div>
      <div class="tile"><b>${t.verified ? usd(t.costPerVerified) : '–'}</b><span>Cost per verified</span></div>
      <div class="tile"><b>${t.firstVerifiedSpendUsd === null ? '–' : usd(t.firstVerifiedSpendUsd)}</b><span>Spend to first verified</span></div>
      <div class="tile"><b>${t.duplicates}</b><span>Duplicates prevented</span></div>
    </div>
    <h2>Across runs for this brand</h2><table><thead><tr><th>Hunt</th><th>Spend</th><th>Verified</th><th>Spend to first verified</th><th>Seconds to first verified</th></tr></thead><tbody>
    ${r.history.map(h => `<tr><td>${esc(h.id)}</td><td>${usd(h.spentUsd)}</td><td>${h.verified}</td><td>${h.firstVerifiedSpendUsd === null ? '–' : usd(h.firstVerifiedSpendUsd)}</td><td>${h.secondsToFirstVerified === null ? '–' : h.secondsToFirstVerified.toFixed(1)}</td></tr>`).join('')}</tbody></table>
    <h2>By surface</h2><table><thead><tr><th>Surface</th><th>Candidates</th><th>Verified</th><th>Model spend</th></tr></thead><tbody>
    ${Object.entries(r.bySurface).map(([s, v]) => `<tr><td>${esc(s)}</td><td>${v.candidates}</td><td>${v.verified}</td><td>${usd(v.usd)}</td></tr>`).join('')}</tbody></table>
    <h2>Deciders</h2><table><thead><tr><th>Decider</th><th>Calls</th><th>Median ms</th><th>p95 ms</th></tr></thead><tbody>
    ${Object.entries(r.deciders).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.calls}</td><td>${num(v.medianMs)}</td><td>${num(v.p95Ms)}</td></tr>`).join('')}</tbody></table>
    <p class="muted">Fallbacks: ${r.fallbacks}. Shadow comparisons: ${r.shadow.compared}${r.shadow.disagreementRate === null ? '' : `, ${(r.shadow.disagreementRate * 100).toFixed(0)}% disagreement`}.</p>
    <h2>Per case</h2><table><thead><tr><th>Candidate</th><th>State</th><th>Score</th><th>Why</th></tr></thead><tbody>
    ${r.perCase.map(c => `<tr><td class="url">${esc(c.url)}</td><td>${esc(stageLabel(c.state))}</td><td>${c.score === null ? '–' : c.score.toFixed(2)}</td><td>${esc(c.why)}</td></tr>`).join('')}</tbody></table>`
}

$('pause').onclick = () => huntId && view && post(`/api/hunts/${huntId}/control`, { action: view.hunt.status === 'paused' ? 'resume' : 'pause' })
$('setBudget').onclick = () => huntId && post(`/api/hunts/${huntId}/control`, { action: 'budget', usd: Number($('budget').value) })
$('export').onclick = async () => {
  if (!huntId) return
  const blob = await (await fetch(`/api/hunts/${huntId}/report`)).blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `customs-${huntId}.json`
  a.click()
  URL.revokeObjectURL(a.href)
}

async function boot() {
  const [cfg, hunts] = await Promise.all([fetch('/api/config').then(r => r.json()), fetch('/api/hunts').then(r => r.json())])
  $('deciderInfo').textContent = `Triage: ${cfg.triage}. Verify: ${cfg.verify}.`
  $('huntList').innerHTML = hunts.hunts.map(h => `<li><a href="#${esc(h)}" data-h="${esc(h)}">${esc(h)}</a></li>`).join('') || '<li>None yet.</li>'
  $('huntList').querySelectorAll('a').forEach(a => { a.onclick = e => { e.preventDefault(); open(a.dataset.h); showTab('live') } })
  const id = location.hash.slice(1)
  if (id && hunts.hunts.includes(id)) { open(id); showTab('live') }
}
boot()
