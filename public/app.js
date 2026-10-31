const $ = id => document.getElementById(id)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const usd = n => `$${(n ?? 0).toFixed(n < 0.1 ? 4 : 2)}`

let huntId = null
let view = null
let selected = null
let socket = null
let version = -1
let currentTab = 'setup'
let caseFilter = 'review'
let config = { billed: [] }
let lanes = null

/** Rewriting a list while a button in it is held down loses the click, so a list is only rewritten when it changed. */
function setHtml(el, html) {
  if (el._html === html) return
  el._html = html
  el.innerHTML = html
}
// Updates also wait for a press to finish. The delay lets the click land first.
let pressed = false
let renderWaiting = false
document.addEventListener('pointerdown', () => { pressed = true }, true)
const release = () => {
  pressed = false
  if (renderWaiting) setTimeout(() => { if (!pressed && view) { renderWaiting = false; render() } }, 60)
}
document.addEventListener('pointerup', release, true)
document.addEventListener('pointercancel', release, true)

let toastTimer
function toast(text, bad = false) {
  const t = $('toast')
  t.textContent = text
  t.classList.toggle('bad', bad)
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, bad ? 7000 : 3500)
}

document.querySelectorAll('#tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab) })
$('goSetup').onclick = () => showTab('setup')
function showTab(tab) {
  currentTab = tab
  const showing = huntId || tab === 'setup' ? tab : 'noHunt'
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab))
  document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== showing })
  if (showing === 'report') renderReport()
  if (showing === 'setup') loadHunts()
  GraphView.setVisible(showing === 'graph')
}

const post = (path, body) => fetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) })
/** Every action tells the person what happened. Returns the reply, or null after showing the error. */
async function act(path, body, button) {
  if (button) button.disabled = true
  try {
    const res = await post(path, body)
    const reply = await res.json().catch(() => ({}))
    if (!res.ok) { toast(reply.error ?? `That didn't work (error ${res.status}).`, true); return null }
    return reply
  } catch {
    toast('Could not reach the server. Is it still running?', true)
    return null
  } finally {
    if (button) button.disabled = false
  }
}
const list = v => v.split(',').map(s => s.trim()).filter(Boolean)

$('form').onsubmit = async e => {
  e.preventDefault()
  $('formError').textContent = ''
  const f = new FormData(e.target)
  const b = $('startHunt')
  b.disabled = true
  b.textContent = 'Starting…'
  try {
    const res = await post('/api/hunts', {
      brand: f.get('brand'), keywords: list(f.get('keywords')), officialDomains: list(f.get('officialDomains')),
      authorizedSellers: list(f.get('authorizedSellers')), budgetUsd: Number(f.get('budgetUsd')), precision: f.get('precision'),
    })
    const body = await res.json()
    if (!res.ok) { $('formError').textContent = body.error; return }
    openHunt(body.id)
    showTab('live')
  } catch {
    $('formError').textContent = 'Could not reach the server. Is it still running?'
  } finally {
    b.disabled = false
    b.textContent = 'Start hunt'
  }
}

function openHunt(id) {
  huntId = id
  version = -1
  view = null
  selected = null
  lanes = null
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
    if (pressed) renderWaiting = true
    else render()
  }
  // Keeps the screen live across a server restart.
  ws.onclose = () => { if (socket === ws) { $('status').textContent = 'Reconnecting…'; setTimeout(connect, 1000) } }
}

const STATUS_LABEL = { running: 'running', paused: 'paused', done: 'finished', budget_exhausted: 'hit its limit' }

function render() {
  const { hunt } = view
  $('status').textContent = `${hunt.input.brand}: ${STATUS_LABEL[hunt.status] ?? hunt.status}`
  renderLive(hunt)
  renderCases()
  GraphView.update(view.graph)
  renderGraphText()
  renderKb()
}

const needsReview = () => view.cases.filter(c => c.state === 'awaiting_approval')

function renderNextStep(h) {
  const n = needsReview().length
  const parts = []
  if (h.status === 'budget_exhausted') parts.push('<b>This hunt reached its spending limit and stopped searching.</b> Raise the limit below to continue.')
  else if (h.status === 'paused') parts.push('<b>This hunt is paused.</b> Scouts wait until you resume.')
  else if (h.status === 'done') parts.push('<b>This hunt has finished.</b>')
  else parts.push('<b>Searching.</b> Results appear as they are found.')
  if (n) parts.push(`${n} ${n === 1 ? 'candidate needs' : 'candidates need'} your decision. <button class="primary" data-go="cases">Review now</button>`)
  setHtml($('nextStep'), parts.join(' '))
  $('nextStep').hidden = false
}
$('nextStep').onclick = e => {
  if (e.target.dataset.go) { caseFilter = 'review'; showTab('cases'); renderCases() }
}

function renderLive(h) {
  const c = h.counters
  renderNextStep(h)
  setHtml($('counters'), [
    ['Listings looked at', c.seen], ['Passed the quick check', c.shortlisted], ['Confirmed suspicious', c.verified], ['You approved', c.approved],
    ['Second opinions', c.reasoned ?? 0], ['Repeats not paid for', c.duplicates], ['Cost per confirmed', c.verified ? usd(h.spent / c.verified) : '–'],
  ].map(([k, v]) => `<div class="tile"><b>${esc(v)}</b><span>${esc(k)}</span></div>`).join(''))
  const pct = Math.min(100, (h.spent / h.input.budgetUsd) * 100)
  $('meterFill').style.width = `${pct}%`
  $('meterText').textContent = `${usd(h.spent)} of ${usd(h.input.budgetUsd)} used. ${billingText()}${view.priorHunts > 0 ? ` Using what ${view.priorHunts} earlier ${view.priorHunts === 1 ? 'hunt' : 'hunts'} learned.` : ''}`

  const finished = h.status === 'done'
  $('controls').hidden = finished
  $('finishedNote').hidden = !finished
  $('steerForm').hidden = finished || h.status === 'budget_exhausted'
  $('pause').textContent = h.status === 'paused' ? 'Resume' : 'Pause'
  $('pause').disabled = h.status === 'budget_exhausted'
  if (document.activeElement !== $('budget')) $('budget').value = h.input.budgetUsd
  if (!finished) loadLanes()

  setHtml($('roster'), Object.entries(h.roster).map(([name, s]) =>
    `<tr><td>${esc(SURFACE_LABEL[name] ?? name)}</td><td>${esc(words(s.lane.strategy))}</td><td>${esc(SCOUT_STATUS[s.status.split(':')[0]] ?? s.status.split(':')[0])}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Scouts are starting.</td></tr>')
  setHtml($('steers'), [...h.steers].reverse().map(s =>
    `<li><span class="badge steer-${esc(s.kind ?? 'yield')}">${esc(STEER_LABEL[s.kind] ?? 'Changed')}</span> <b>${esc(SURFACE_LABEL[s.scout] ?? s.scout)}</b>: ${esc(s.from)} → ${esc(s.to)}<br><span class="muted">${esc(s.reason)}</span></li>`).join('') || '<li class="muted">No changes yet.</li>')
  setHtml($('spawns'), [...(h.spawns ?? [])].reverse().map(s => {
    const c = view.cases.find(x => x.id === s.caseId)
    return `<tr class="click" data-id="${esc(s.caseId)}"><td>${esc(s.agent)}</td><td>${esc(TRIGGER_LABEL[s.trigger] ?? s.trigger)}</td><td class="url">${esc(c?.hit?.title)}</td><td>${esc(s.outcome ?? 'Working…')}</td></tr>`
  }).join('') || '<tr><td colspan="4" class="muted">None yet.</td></tr>')
  setHtml($('events'), [...h.events].reverse().slice(0, 30).map(e => `<li>${esc(e.text)}</li>`).join('') || '<li>Nothing yet.</li>')
  setHtml($('fallbacks'), [...view.fallbacks].reverse().map(f =>
    `<li><b>${esc(f.from)}</b> failed, so another model took over: <span class="muted">${esc(f.error)}</span></li>`).join('') || '<li class="muted">None.</li>')
  const n = needsReview().length
  $('reviewCount').hidden = !n
  $('reviewCount').textContent = n
}

$('spawns').onclick = e => {
  const r = e.target.closest('tr[data-id]')
  if (r) openCase(r.dataset.id)
}

const words = s => String(s ?? '').replaceAll('-', ' ').replaceAll('_', ' ')
const SURFACE_LABEL = { social: 'Social media', marketplace: 'Marketplaces', video: 'Video sites', domains: 'Websites', channels: 'Group chats' }
const SCOUT_STATUS = { online: 'Searching', blocked: 'Blocked, waiting for a new direction', exhausted: 'Nothing new, waiting for a new direction' }
const STEER_LABEL = { exhausted: 'Ran dry', blocked: 'Site failing', stalled: 'Not working', yield: 'Better results elsewhere', 'cross-surface': 'Changed direction', manual: 'You redirected it' }
const TRIGGER_LABEL = { undecided: 'Quick check failed', unsure: 'Quick check unsure', top: 'Top candidate' }
const openCase = id => { selected = id; caseFilter = 'all'; showTab('cases'); renderCases() }

const STATE_LABEL = {
  new: 'Checking', skipped: 'Skipped: looks real', triaged: 'Low risk so far', undecided: "Couldn't decide", shortlisted: 'Being checked',
  cleared: 'Cleared', verified: 'Confirmed', awaiting_approval: 'Needs your decision', approved: 'Approved', rejected: 'Rejected',
}
const stageLabel = s => STATE_LABEL[s] ?? words(s)
const rank = c => ['awaiting_approval', 'undecided', 'verified', 'shortlisted', 'triaged'].indexOf(c.state)
const FILTERS = [
  ['review', 'Needs your decision', c => c.state === 'awaiting_approval'],
  ['decided', 'Decided', c => c.state === 'approved' || c.state === 'rejected'],
  ['other', 'Not flagged', c => !['awaiting_approval', 'approved', 'rejected'].includes(c.state)],
  ['all', 'All', () => true],
]
const risk = d => (d ? `${Math.round(d.score * 100)}%` : '–')

function sortedCases() {
  return [...view.cases].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)].map(r => (r < 0 ? 9 : r))
    return x - y || (b.triage?.score ?? 0) - (a.triage?.score ?? 0)
  })
}

function renderCases() {
  setHtml($('caseFilters'), FILTERS.map(([id, label, f]) =>
    `<button data-filter="${id}" class="${caseFilter === id ? 'on' : ''}" aria-pressed="${caseFilter === id}">${esc(label)} (${view.cases.filter(f).length})</button>`).join(''))
  const pass = FILTERS.find(f => f[0] === caseFilter)[2]
  const rows = sortedCases().filter(pass)
  setHtml($('caseRows'), rows.map(c => {
    const d = c.verification ?? c.triage
    return `<tr class="click ${selected === c.id ? 'sel' : ''}" data-id="${esc(c.id)}" tabindex="0">
      <td class="url">${esc(c.hit?.title)}</td><td>${esc(SURFACE_LABEL[c.hit?.surface] ?? c.hit?.surface)}</td>
      <td>${risk(d)}</td><td class="state-${esc(c.state)}">${esc(stageLabel(c.state))}</td></tr>`
  }).join(''))
  $('casesEmpty').hidden = rows.length > 0
  $('casesEmpty').textContent = caseFilter === 'review'
    ? (view.hunt.status === 'done' ? 'Nothing left to decide. Everything is reviewed.' : 'Nothing to decide yet. Candidates appear here as they are confirmed.')
    : 'Nothing here yet.'
  renderDetail()
}
$('caseFilters').onclick = e => {
  const f = e.target.dataset.filter
  if (f) { caseFilter = f; renderCases() }
}
const pickRow = r => { selected = r.dataset.id; renderCases() }
$('caseRows').onclick = e => { const r = e.target.closest('tr[data-id]'); if (r) pickRow(r) }
$('caseRows').onkeydown = e => { const r = e.target.closest('tr[data-id]'); if (r && e.key === 'Enter') pickRow(r) }

function reasoningHtml(r) {
  if (!r) return ''
  if (r.status === 'running') return `<p class="muted">${esc(r.agent)} is looking at this case.</p>`
  if (r.status === 'failed') return `<p class="muted">The second opinion failed: ${esc(r.error)}</p>`
  return `<div class="reasoned ${r.disagrees ? 'disagree' : ''}">
    <p><b>Second opinion from ${esc(r.reasonerId)}:</b> ${esc(words(r.verdict))} (${Math.round((r.confidence ?? 0) * 100)}% sure). ${esc(r.reasoning)}</p>
    ${r.disagrees ? '<p><b>This contradicts the quick check. Look closely before deciding.</b></p>' : ''}</div>`
}

function renderDetail() {
  const c = view.cases.find(x => x.id === selected)
  if (!c) {
    const n = needsReview().length
    setHtml($('caseDetail'), `<div class="detail muted">${n ? 'Select a candidate to see the evidence and decide.' : 'Select a candidate to see the evidence.'}</div>`)
    return
  }
  const d = c.verification ?? c.triage
  const pending = c.state === 'awaiting_approval'
  setHtml($('caseDetail'), `<div class="detail">
    <h2>${esc(c.hit?.title)}</h2>
    <p class="${'state-' + esc(c.state)}">${esc(stageLabel(c.state))}${d ? ` · ${risk(d)} risk, ${Math.round(d.confidence * 100)}% sure` : ''}</p>
    ${pending ? `<div class="actions"><button class="primary" data-act="approve">Approve notice</button><button data-act="reject">Reject: not a problem</button></div>
      <p class="muted small">Approving records a simulated submission. Nothing is sent. Rejecting teaches this brand's future hunts.</p>` : ''}
    <p class="url">${esc(c.hit?.url)} <span class="muted">(don't open this outside a sandbox)</span></p>
    <p>${esc(c.hit?.snippet)}</p>
    <p><b>Why flagged:</b> ${esc(d?.why ?? c.skipReason ?? 'not classified')}</p>
    ${reasoningHtml(c.reasoning)}
    ${d?.visualEvidenceUnavailable ? '<p class="muted">This model could not check images.</p>' : ''}
    ${c.hit?.evidenceText ? `<p><b>Evidence:</b> ${esc(c.hit.evidenceText)}</p>` : ''}
    <p class="muted small">Found by ${esc(c.reporters.map(r => SURFACE_LABEL[r] ?? r).join(', '))}${d?.deciderId ? `, checked by ${esc(d.deciderId)}` : ''}</p>
    ${c.notice ? `<details class="fold" open><summary>Drafted notice</summary><pre>${esc(c.notice)}</pre></details>` : ''}
    ${c.approval ? `<p class="state-${esc(c.state)}">${c.approval.decision === 'approve' ? 'Approved. A simulated submission was recorded; nothing was sent.' : "Rejected. Saved so this brand's future hunts learn from it."}</p>` : ''}
    ${c.recheck ? `<p>Follow-up: ${esc(c.recheck.result === 'relisted' ? 'listed again' : 'taken down')}</p>` : ''}
    ${c.approval?.decision === 'approve' ? '<div class="actions"><span class="muted small">What happened afterwards?</span><button data-act="resolved">It was taken down</button><button data-act="relisted">It came back</button></div>' : ''}
  </div>`)
}

$('caseDetail').onclick = async e => {
  const b = e.target.closest('button[data-act]')
  if (!b) return
  const a = b.dataset.act
  const c = view.cases.find(x => x.id === selected)
  if (a === 'approve' || a === 'reject') {
    const after = sortedCases().filter(x => x.state === 'awaiting_approval' && x.id !== c.id)[0]
    const r = await act(`/api/hunts/${huntId}/cases/${c.id}/decision`, { decision: a }, b)
    if (!r) return
    if (!r.changed) { toast('This case was already decided.'); return }
    toast(a === 'approve' ? 'Approved. Simulated only: nothing was sent.' : 'Rejected and saved for future hunts.')
    if (after) { selected = after.id; renderCases() }
  } else if (await act(`/api/hunts/${huntId}/cases/${c.id}/recheck`, { result: a }, b)) {
    toast('Follow-up saved.')
  }
}

const LEGEND = [
  ['verified', 'Verified real'], ['candidate', 'Possibly real, unproven'], ['infringing', 'Flagged for review'],
  ['suspect', 'Linked or undecided'], ['cleared', 'Cleared'], ['agent', 'Agents and searches'],
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
  setHtml($('graphList'), [...nodes].sort((a, b) => a.kind.localeCompare(b.kind)).map(n =>
    `<li><button class="linklike" data-id="${esc(n.id)}"><i class="dot t-${esc(n.trust)}"></i>${esc(n.kind)}: ${esc(n.label)}</button></li>`).join(''))
  if (selectedNode) showNode(nodes.find(n => n.id === selectedNode.id) ?? null)
}
$('graphList').onclick = e => {
  const b = e.target.closest('button[data-id]')
  if (b) GraphView.select(b.dataset.id)
}

let selectedNode = null
const TRUST_LABEL = Object.fromEntries(LEGEND)
function showNode(node) {
  selectedNode = node
  if (!node) { setHtml($('graphInfo'), '<p class="muted">Click a node for details. Drag to rearrange, scroll to zoom.</p>'); return }
  const nameOf = id => view.graph.nodes.find(n => n.id === id)?.label ?? id
  const links = view.graph.edges.filter(e => e.from === node.id || e.to === node.id)
  setHtml($('graphInfo'), `<h2>${esc(node.label)}</h2>
    <p><i class="dot t-${esc(node.trust)}"></i>${esc(TRUST_LABEL[node.trust] ?? node.kind)} <span class="muted">· ${esc(node.kind)}</span></p>
    ${node.detail ? `<p class="muted url">${esc(node.detail)}</p>` : ''}
    ${node.source ? `<p class="muted">From ${esc(node.source)}, ${Math.round(node.confidence * 100)}% sure</p>` : ''}
    ${node.caseId ? `<p><button data-case="${esc(node.caseId)}">Open case</button></p>` : ''}
    <ul class="edgelist">${links.slice(0, 14).map(e => `<li><b>${esc(e.kind.replaceAll('_', ' '))}</b> ${esc(nameOf(e.from === node.id ? e.to : e.from))}${e.reason ? `<br><span class="muted">${esc(e.reason)}</span>` : ''}</li>`).join('')}</ul>`)
}
$('graphInfo').onclick = e => {
  const id = e.target.dataset.case
  if (id) openCase(id)
}

const KIND_LABEL = { domain: 'Website', account: 'Account', channel: 'Channel', seller: 'Seller' }
const SOURCE_LABEL = { operator: 'You, at setup', human: 'You', reasoner: 'Reasoning model' }
function renderKb() {
  const k = view.kb
  $('kbInfo').textContent = k.builtBy
    ? `Researched by ${k.builtBy}${k.builtBy === 'mock-reasoner' ? ', using made-up demo data rather than real research' : ''}. Listings matching a verified entry are never flagged. Unproven entries are only hints. This list is kept for later hunts on this brand.`
    : 'Only what you entered so far.'
  const order = { verified: 0, candidate: 1 }
  setHtml($('kbRows'), [...k.entities].sort((a, b) => order[a.status] - order[b.status]).map(e =>
    `<tr><td>${esc(KIND_LABEL[e.kind] ?? e.kind)}</td><td class="url">${esc(e.value)}</td><td class="status-${esc(e.status)}">${e.status === 'verified' ? 'Verified' : 'Unproven'}</td><td>${esc(SOURCE_LABEL[e.source] ?? e.source)}</td><td class="muted">${esc(e.evidence)} (${Math.round(e.confidence * 100)}% sure)</td><td><button data-id="${esc(e.id)}" data-value="${esc(e.value)}" aria-label="Remove ${esc(e.value)}">Remove</button></td></tr>`).join(''))
}
$('kbRows').onclick = async e => {
  const b = e.target.closest('button[data-id]')
  if (b && await act(kbPath(), { action: 'remove', id: b.dataset.id }, b)) toast(`Removed ${b.dataset.value}.`)
}
const brandSlug = () => view.hunt.input.brand.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const kbPath = () => `/api/brands/${brandSlug()}/kb`
$('kbForm').onsubmit = async e => {
  e.preventDefault()
  $('kbError').textContent = ''
  if (!view) { $('kbError').textContent = 'This hunt is still loading. Try again in a moment.'; return }
  const f = new FormData(e.target)
  const res = await post(kbPath(), { action: 'add', kind: f.get('kind'), value: f.get('value') })
  if (res.ok) { toast(`Added ${f.get('value')}.`); e.target.reset() }
  else $('kbError').textContent = (await res.json()).error
}

async function renderReport() {
  let r
  try { r = await (await fetch(`/api/hunts/${huntId}/report`)).json() } catch {
    $('reportBody').innerHTML = '<p class="error">Could not load the report. Is the server still running?</p>'
    return
  }
  const t = r.totals
  const num = v => (typeof v === 'number' ? v.toFixed(v < 1 && v > 0 ? 4 : 0) : '–')
  $('reportBody').innerHTML = `<p class="muted">${esc(r.disclaimer)}</p>
    <div class="grid">
      <div class="tile"><b>${usd(t.spentUsd)}</b><span>Used of the limit</span></div>
      <div class="tile"><b>${t.verified ? usd(t.costPerVerified) : '–'}</b><span>Cost per confirmed</span></div>
      <div class="tile"><b>${t.firstVerifiedSpendUsd === null ? '–' : usd(t.firstVerifiedSpendUsd)}</b><span>Used before the first confirmed</span></div>
      <div class="tile"><b>${t.duplicates}</b><span>Repeats not paid for</span></div>
    </div>
    <p class="muted small">${esc(billingText())}</p>
    <h2>Across hunts for this brand</h2><table><thead><tr><th>Hunt</th><th>Used</th><th>Confirmed</th><th>Used before first confirmed</th><th>Seconds to first confirmed</th></tr></thead><tbody>
    ${r.history.map(h => `<tr><td>${esc(h.id)}</td><td>${usd(h.spentUsd)}</td><td>${h.verified}</td><td>${h.firstVerifiedSpendUsd === null ? '–' : usd(h.firstVerifiedSpendUsd)}</td><td>${h.secondsToFirstVerified === null ? '–' : h.secondsToFirstVerified.toFixed(1)}</td></tr>`).join('')}</tbody></table>
    <h2>Where it was found</h2><table><thead><tr><th>Where</th><th>Candidates</th><th>Confirmed</th><th>Model cost</th></tr></thead><tbody>
    ${Object.entries(r.bySurface).map(([s, v]) => `<tr><td>${esc(SURFACE_LABEL[s] ?? s)}</td><td>${v.candidates}</td><td>${v.verified}</td><td>${usd(v.usd)}</td></tr>`).join('')}</tbody></table>
    <details class="fold"><summary>Model speed and every case</summary>
    <h2>Models</h2><table><thead><tr><th>Model</th><th>Calls</th><th>Median ms</th><th>p95 ms</th></tr></thead><tbody>
    ${Object.entries(r.deciders).map(([d, v]) => `<tr><td>${esc(d)}</td><td>${v.calls}</td><td>${num(v.medianMs)}</td><td>${num(v.p95Ms)}</td></tr>`).join('')}</tbody></table>
    <p class="muted">Fallbacks: ${r.fallbacks}. Comparisons between models: ${r.shadow.compared}${r.shadow.disagreementRate === null ? '' : `, ${(r.shadow.disagreementRate * 100).toFixed(0)}% disagreement`}.</p>
    <h2>Every case</h2><table><thead><tr><th>Candidate</th><th>Status</th><th>Risk</th><th>Why</th></tr></thead><tbody>
    ${r.perCase.map(c => `<tr><td class="url">${esc(c.url)}</td><td>${esc(stageLabel(c.state))}</td><td>${c.score === null ? '–' : `${Math.round(c.score * 100)}%`}</td><td>${esc(c.why)}</td></tr>`).join('')}</tbody></table>
    </details>`
}

$('pause').onclick = async e => {
  if (!view) return
  const resume = view.hunt.status === 'paused'
  if (await act(`/api/hunts/${huntId}/control`, { action: resume ? 'resume' : 'pause' }, e.target)) toast(resume ? 'Hunt resumed.' : 'Hunt paused. No new searches until you resume.')
}
$('budgetForm').onsubmit = async e => {
  e.preventDefault()
  const asked = Number($('budget').value)
  if (!(asked > 0)) { toast('Enter a limit above zero.', true); return }
  const r = await act(`/api/hunts/${huntId}/control`, { action: 'budget', usd: asked }, $('setBudget'))
  if (r) toast(r.budgetUsd > asked ? `Limit set to ${usd(r.budgetUsd)}, because that much is already used or committed.` : `Limit set to ${usd(r.budgetUsd)}.`)
}

async function loadLanes() {
  if (lanes || !huntId) return
  lanes = {}
  const id = huntId
  const res = await fetch(`/api/hunts/${id}/lanes`).catch(() => null)
  if (!res?.ok || id !== huntId) { lanes = null; return }
  lanes = (await res.json()).lanes
  $('steerScout').innerHTML = Object.keys(lanes).map(s => `<option value="${esc(s)}">${esc(SURFACE_LABEL[s] ?? s)}</option>`).join('')
  fillLanes()
}
function fillLanes() {
  $('steerLane').innerHTML = (lanes[$('steerScout').value] ?? []).map(l => `<option value="${esc(l)}">${esc(words(l))}</option>`).join('')
}
$('steerScout').onchange = fillLanes
$('steerForm').onsubmit = async e => {
  e.preventDefault()
  const scout = $('steerScout').value
  if (await act(`/api/hunts/${huntId}/control`, { action: 'boost', scout, strategy: $('steerLane').value }, e.target.querySelector('button'))) toast(`${SURFACE_LABEL[scout] ?? scout} scout redirected.`)
}

$('export').onclick = async () => {
  const res = await fetch(`/api/hunts/${huntId}/report`).catch(() => null)
  if (!res?.ok) { toast('Could not download the report.', true); return }
  const blob = await res.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `customs-${huntId}.json`
  a.click()
  URL.revokeObjectURL(a.href)
  toast('Report downloaded.')
}

function billingText() {
  return config.billed.length
    ? `Real money: ${config.billed.join(', ')} are charged to the OpenAI account of the configured key.`
    : 'Simulated: no real money is being spent.'
}

function renderBilling() {
  const real = config.billed.length > 0
  $('billingNote').hidden = false
  $('billingNote').classList.toggle('real', real)
  $('billingNote').innerHTML = real
    ? `<b>Real money.</b> ${esc(config.billed.join(', '))} ${config.billed.length === 1 ? 'is' : 'are'} charged by OpenAI to the account of the configured API key. Customs stops at your limit, but set a cap in your OpenAI account too.`
    : '<b>Demo mode: no real money.</b> The spending limit counts simulated costs, so you can see how it works.'
  $('budgetHelp').textContent = real
    ? 'The most this hunt may charge to your OpenAI account.'
    : 'The most this hunt may spend. Simulated in demo mode.'
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
async function loadHunts() {
  const res = await fetch('/api/hunts').catch(() => null)
  if (!res?.ok) return
  const { summaries } = await res.json()
  setHtml($('huntList'), summaries.length
    ? `<table><thead><tr><th>Brand</th><th>Started</th><th>Status</th><th>Confirmed</th><th>Used</th></tr></thead><tbody>${summaries.map(h =>
      `<tr class="click ${h.id === huntId ? 'sel' : ''}" data-h="${esc(h.id)}" tabindex="0"><td>${esc(h.brand)}</td><td>${esc(WHEN.format(h.startedAt))}</td><td>${esc(STATUS_LABEL[h.status] ?? h.status)}</td><td>${h.verified}</td><td>${usd(h.spentUsd)}</td></tr>`).join('')}</tbody></table>`
    : '<p class="muted">None yet. Your first hunt will appear here.</p>')
}
const pickHunt = r => { openHunt(r.dataset.h); showTab('live') }
$('huntList').onclick = e => { const r = e.target.closest('tr[data-h]'); if (r) pickHunt(r) }
$('huntList').onkeydown = e => { const r = e.target.closest('tr[data-h]'); if (r && e.key === 'Enter') pickHunt(r) }

async function boot() {
  const [cfg, hunts] = await Promise.all([fetch('/api/config').then(r => r.json()), fetch('/api/hunts').then(r => r.json())])
  config = cfg
  renderBilling()
  $('deciderInfo').textContent = `Quick check: ${cfg.triage}. Confirmation: ${cfg.verify}. Second opinions: ${cfg.reasoner ?? 'off'}.`
  await loadHunts()
  const id = location.hash.slice(1)
  if (id && hunts.hunts.includes(id)) { openHunt(id); showTab('live') }
}
boot().catch(() => toast('Could not reach the server. Is it still running?', true))
