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
  GraphView.setVisible(tab === 'graph')
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
  GraphView.reset()
  selectedNode = null
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
  GraphView.update(view.graph)
  renderGraphText()
  renderKb()
}

function renderLive(h) {
  const c = h.counters
  const costPer = c.verified ? h.spent / c.verified : 0
  $('counters').innerHTML = [
    ['Seen', c.seen], ['Triaged', c.triaged], ['Shortlisted', c.shortlisted], ['Verified', c.verified], ['Approved', c.approved],
    ['Duplicates prevented', c.duplicates], ['Undecided', c.undecided], ['Reasoned', c.reasoned ?? 0], ['Verified presences known', view.kb.entities.filter(e => e.status === 'verified').length], ['Cost per verified', c.verified ? usd(costPer) : '–'],
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
    `<li><span class="badge steer-${esc(s.kind ?? 'yield')}">${esc(STEER_LABEL[s.kind] ?? 'steered')}</span> <b>${esc(s.scout)}</b>: ${esc(s.from)} → ${esc(s.to)}<br><span class="muted">${esc(s.reason)}</span></li>`).join('') || '<li class="muted">No steers yet.</li>'
  $('spawns').innerHTML = [...(h.spawns ?? [])].reverse().map(s => {
    const c = view.cases.find(x => x.id === s.caseId)
    return `<tr class="click" data-id="${esc(s.caseId)}"><td>${esc(s.agent)}</td><td>${esc(TRIGGER_LABEL[s.trigger] ?? s.trigger)}</td><td class="url">${esc(c?.hit?.title)}</td><td>${esc(s.reasonerId)}</td><td>${esc(s.outcome ?? 'running')}</td></tr>`
  }).join('') || '<tr><td colspan="5" class="muted">None spawned yet.</td></tr>'
  $('spawns').querySelectorAll('tr[data-id]').forEach(r => { r.onclick = () => openCase(r.dataset.id) })
  $('events').innerHTML = [...h.events].reverse().slice(0, 12).map(e => `<li>${esc(e.text)}</li>`).join('') || '<li>None.</li>'
  $('fallbacks').innerHTML = [...view.fallbacks].reverse().map(f =>
    `<li><b>${esc(f.from)}</b> fell through: <span class="muted">${esc(f.error)}</span></li>`).join('') || '<li class="muted">None.</li>'
}

const STEER_LABEL = { exhausted: 'Ran dry', blocked: 'Site failing', stalled: 'Not working', yield: 'Better yield', 'cross-surface': 'Changed direction', manual: 'Reviewer' }
const TRIGGER_LABEL = { undecided: 'Decision failed', unsure: 'Decision unsure', top: 'Top candidate' }
const openCase = id => { selected = id; showTab('cases'); renderCases() }

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

function reasoningHtml(r) {
  if (!r) return ''
  if (r.status === 'running') return `<p class="muted">${esc(r.agent)} is reasoning about this case.</p>`
  if (r.status === 'failed') return `<p class="muted">The reasoning agent failed: ${esc(r.error)}</p>`
  return `<div class="reasoned ${r.disagrees ? 'disagree' : ''}">
    <p><b>${esc(r.reasonerId)}</b> says <b>${esc(r.verdict)}</b> (${(r.confidence ?? 0).toFixed(2)}): ${esc(r.reasoning)}</p>
    ${r.disagrees ? '<p><b>This contradicts the decider. Look closely before deciding.</b></p>' : ''}</div>`
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
    ${reasoningHtml(c.reasoning)}
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

const LEGEND = [
  ['verified', 'Verified real'], ['candidate', 'Possibly real, unproven'], ['infringing', 'Flagged for review'],
  ['suspect', 'Linked or undecided'], ['cleared', 'Cleared'], ['agent', 'Agents and search lanes'],
]
$('graphLegend').innerHTML = LEGEND.map(([t, l]) => `<li><i class="dot t-${t}"></i>${l}</li>`).join('')
document.querySelectorAll('[data-layer]').forEach(c => { c.onchange = () => GraphView.setLayer(c.dataset.layer, c.checked) })
$('gZoomIn').onclick = () => GraphView.zoom(1.25)
$('gZoomOut').onclick = () => GraphView.zoom(0.8)
$('gFit').onclick = () => GraphView.fit()

GraphView.init($('graphCanvas'), node => showNode(node))

function renderGraphText() {
  const { nodes } = view.graph
  $('graphEmpty').hidden = nodes.length > 0
  $('graphListTitle').textContent = `All nodes (${nodes.length})`
  $('graphList').innerHTML = [...nodes].sort((a, b) => a.kind.localeCompare(b.kind)).map(n =>
    `<li><button class="linklike" data-id="${esc(n.id)}"><i class="dot t-${esc(n.trust)}"></i>${esc(n.kind)}: ${esc(n.label)}</button></li>`).join('')
  $('graphList').querySelectorAll('button').forEach(b => { b.onclick = () => GraphView.select(b.dataset.id) })
  if (selectedNode) showNode(nodes.find(n => n.id === selectedNode.id) ?? null)
}

let selectedNode = null
const TRUST_LABEL = Object.fromEntries(LEGEND)
function showNode(node) {
  selectedNode = node
  if (!node) { $('graphInfo').innerHTML = '<p class="muted">Select a node. Drag to rearrange, scroll to zoom.</p>'; return }
  const nameOf = id => view.graph.nodes.find(n => n.id === id)?.label ?? id
  const links = view.graph.edges.filter(e => e.from === node.id || e.to === node.id)
  $('graphInfo').innerHTML = `<h2>${esc(node.label)}</h2>
    <p><i class="dot t-${esc(node.trust)}"></i>${esc(TRUST_LABEL[node.trust] ?? node.kind)} <span class="muted">· ${esc(node.kind)}</span></p>
    ${node.detail ? `<p class="muted url">${esc(node.detail)}</p>` : ''}
    ${node.source ? `<p class="muted">From ${esc(node.source)}, confidence ${node.confidence.toFixed(2)}</p>` : ''}
    ${node.caseId ? `<p><button id="gOpenCase">Open case</button></p>` : ''}
    <ul class="edgelist">${links.slice(0, 14).map(e => `<li><b>${esc(e.kind.replaceAll('_', ' '))}</b> ${esc(nameOf(e.from === node.id ? e.to : e.from))}${e.reason ? `<br><span class="muted">${esc(e.reason)}</span>` : ''}</li>`).join('')}</ul>`
  const open = $('gOpenCase')
  if (open) open.onclick = () => openCase(node.caseId)
}

function renderKb() {
  const k = view.kb
  $('kbInfo').textContent = k.builtBy
    ? `Built by ${k.builtBy}${k.builtBy === 'mock-reasoner' ? ' from synthetic data, not real research' : ''}. Only verified entries clear a listing; candidates are hints. Kept for every later hunt on this brand.`
    : 'No reasoning-model build yet; operator entries only.'
  const order = { verified: 0, candidate: 1 }
  $('kbRows').innerHTML = [...k.entities].sort((a, b) => order[a.status] - order[b.status]).map(e =>
    `<tr><td>${esc(e.kind)}</td><td class="url">${esc(e.value)}</td><td class="status-${esc(e.status)}">${esc(e.status)}</td><td>${esc(e.source)}</td><td>${e.confidence.toFixed(2)}</td><td class="muted">${esc(e.evidence)}</td><td><button data-id="${esc(e.id)}" aria-label="Remove ${esc(e.value)}">Remove</button></td></tr>`).join('')
  $('kbRows').querySelectorAll('button').forEach(b => { b.onclick = () => { b.disabled = true; post(kbPath(), { action: 'remove', id: b.dataset.id }) } })
}
const brandSlug = () => view.hunt.input.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const kbPath = () => `/api/brands/${brandSlug()}/kb`
$('kbForm').onsubmit = async e => {
  e.preventDefault()
  $('kbError').textContent = ''
  if (!view) { $('kbError').textContent = 'Start or open a hunt first.'; return }
  const f = new FormData(e.target)
  const res = await post(kbPath(), { action: 'add', kind: f.get('kind'), value: f.get('value') })
  if (res.ok) e.target.reset()
  else $('kbError').textContent = (await res.json()).error
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
  $('deciderInfo').textContent = `Triage: ${cfg.triage}. Verify: ${cfg.verify}. Reasoning: ${cfg.reasoner ?? 'off'}.`
  $('huntList').innerHTML = hunts.hunts.map(h => `<li><a href="#${esc(h)}" data-h="${esc(h)}">${esc(h)}</a></li>`).join('') || '<li>None yet.</li>'
  $('huntList').querySelectorAll('a').forEach(a => { a.onclick = e => { e.preventDefault(); open(a.dataset.h); showTab('live') } })
  const id = location.hash.slice(1)
  if (id && hunts.hunts.includes(id)) { open(id); showTab('live') }
}
boot()
