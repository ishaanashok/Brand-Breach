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
  if (showing === 'setup') { loadHunts(); renderReturn() }
  WebView.setVisible(showing === 'web')
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
      brand: f.get('brand'), keywords: list(f.get('keywords')).length ? list(f.get('keywords')) : [f.get('brand').trim()], officialDomains: list(f.get('officialDomains')),
      authorizedSellers: list(f.get('authorizedSellers')), budgetUsd: Number(f.get('budgetUsd')), precision: f.get('precision'),
    })
    const body = await res.json()
    if (!res.ok) { $('formError').textContent = body.error; return }
    openHunt(body.id)
    showTab('web')
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
  location.hash = id
  closePanel()
  WebView.reset(id)
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
  renderHud(hunt)
  renderCases()
  WebView.update(view, panelOpen() ? selected : null)
  renderReturn()
}

const needsReview = () => view.cases.filter(c => c.state === 'awaiting_approval')

function renderHud(h) {
  const n = needsReview().length
  $('webBrand').textContent = h.input.brand
  const spiders = view.cases.filter(c => ['verified', 'awaiting_approval', 'approved'].includes(c.state)).length
  const state = { running: 'Weaving', paused: 'Paused', done: 'Finished', budget_exhausted: 'Stopped at the limit' }[h.status] ?? h.status
  $('webLine').textContent = `${state}. ${view.cases.length} ${view.cases.length === 1 ? 'site' : 'sites'}, ${spiders} ${spiders === 1 ? 'spider' : 'spiders'}.`
  const searching = config.source === 'spiders'
  $('webSpend').textContent = searching
    ? `${searchCount(h)} so far.`
    : config.source === 'luna'
    ? `${searchCount(h)}, ${usd(h.spent)} of ${usd(h.input.budgetUsd)} used. ${costNote()}`
    : `${usd(h.spent)} of ${usd(h.input.budgetUsd)} used. ${costNote()}`
  const finished = h.status === 'done'
  $('pause').hidden = finished
  $('budgetForm').hidden = finished || searching
  $('pause').textContent = h.status === 'paused' ? 'Resume' : 'Pause'
  $('pause').disabled = h.status === 'budget_exhausted'
  if (document.activeElement !== $('budget')) $('budget').value = h.input.budgetUsd
  $('webTicker').textContent = h.events.at(-1)?.text ?? ''
  $('webNext').hidden = !n || panelOpen()
  $('webNext').textContent = `${n} ${n === 1 ? 'spider needs' : 'spiders need'} your decision`
  $('reviewCount').hidden = !n
  $('reviewCount').textContent = n
}

// Spiders open the same details the Review tab shows, beside the web.
const panelOpen = () => !$('webPanel').hidden
function openPanel(id) {
  selected = id
  $('webPanel').hidden = false
  $('webNext').hidden = true
  WebView.setInset(innerWidth > 900 ? 428 : 0)
  renderDetail()
  WebView.update(view, id)
}
function closePanel() {
  $('webPanel').hidden = true
  WebView.setInset(0)
  if (view) { renderHud(view.hunt); WebView.update(view, null) }
}
$('panelClose').onclick = closePanel
document.addEventListener('keydown', e => { if (e.key === 'Escape' && panelOpen()) closePanel() })
WebView.init($('webCanvas'), $('webPoints'), openPanel)
const nextToDecide = () => sortedCases().find(c => c.state === 'awaiting_approval')
$('webNext').onclick = () => { const c = nextToDecide(); if (c) openPanel(c.id) }

function renderReturn() {
  $('backToWeb').hidden = !view
  if (view) $('backToWeb').textContent = `Back to the ${view.hunt.input.brand} web →`
}
$('backToWeb').onclick = () => showTab('web')

const words = s => String(s ?? '').replaceAll('-', ' ').replaceAll('_', ' ')
const SURFACE_LABEL = { social: 'Social media', marketplace: 'Marketplaces', video: 'Video sites', domains: 'Websites', channels: 'Group chats' }
const SCOUT_STATUS = { online: 'Searching', blocked: 'Blocked, waiting for a new direction', exhausted: 'Nothing new, waiting for a new direction' }
const STEER_LABEL = { exhausted: 'Ran dry', blocked: 'Site failing', stalled: 'Not working', yield: 'Better results elsewhere', 'cross-surface': 'Changed direction', manual: 'You redirected it' }
const TRIGGER_LABEL = { undecided: 'Quick check failed', unsure: 'Quick check unsure', top: 'Top candidate' }

const STATE_LABEL = {
  new: 'Checking', skipped: 'Skipped: looks real', triaged: 'Low risk so far', undecided: "Couldn't decide", shortlisted: 'Being checked',
  cleared: 'Cleared', unreadable: "Couldn't read", verified: 'Confirmed', awaiting_approval: 'Needs your decision', approved: 'Approved', rejected: 'Rejected',
}
const stageLabel = s => STATE_LABEL[s] ?? words(s)
const rank = c => ['awaiting_approval', 'undecided', 'verified', 'shortlisted', 'triaged'].indexOf(c.state)
const FILTERS = [
  ['review', 'Needs your decision', c => c.state === 'awaiting_approval'],
  ['decided', 'Decided', c => c.state === 'approved' || c.state === 'rejected'],
  ['unreadable', "Couldn't read", c => c.state === 'unreadable'],
  ['other', 'Not flagged', c => !['awaiting_approval', 'approved', 'rejected', 'unreadable'].includes(c.state)],
  ['all', 'All', () => true],
]
// Nobody read an unreadable page, so any score it has is a guess from its address.
const decisionOf = c => (c.state === 'unreadable' ? null : c.verification ?? c.triage)
const risk = d => (d ? `${Math.round(d.score * 100)}%` : '–')

function sortedCases() {
  return [...view.cases].sort((a, b) => {
    const [x, y] = [rank(a), rank(b)].map(r => (r < 0 ? 9 : r))
    return x - y || (b.verification ?? b.triage)?.score - (a.verification ?? a.triage)?.score || 0
  })
}

function renderCases() {
  setHtml($('caseFilters'), FILTERS.map(([id, label, f]) =>
    `<button data-filter="${id}" class="${caseFilter === id ? 'on' : ''}" aria-pressed="${caseFilter === id}">${esc(label)} (${view.cases.filter(f).length})</button>`).join(''))
  const pass = FILTERS.find(f => f[0] === caseFilter)[2]
  const rows = sortedCases().filter(pass)
  setHtml($('caseRows'), rows.map(c => {
    const d = decisionOf(c)
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

const WHY_LABEL = { cleared: 'Why cleared', skipped: 'Why skipped', unreadable: "Why we couldn't read it", undecided: "Why it couldn't be decided" }

function renderDetail() {
  const c = view.cases.find(x => x.id === selected)
  if (!c) {
    const n = needsReview().length
    setHtml($('caseDetail'), `<div class="detail muted">${n ? 'Select a candidate to see the evidence and decide.' : 'Select a candidate to see the evidence.'}</div>`)
    setHtml($('panelBody'), '')
    return
  }
  const d = decisionOf(c)
  const pending = c.state === 'awaiting_approval'
  const html = `<div class="detail">
    <h2>${esc(c.hit?.title)}</h2>
    <p class="${'state-' + esc(c.state)}">${esc(stageLabel(c.state))}${d ? ` · ${risk(d)} risk, ${Math.round(d.confidence * 100)}% sure` : ''}</p>
    ${pending ? `<div class="actions"><button class="primary" data-act="approve">Approve notice</button><button data-act="reject">Reject: not a problem</button></div>
      <p class="muted small">Approving records a simulated submission. Nothing is sent. Rejecting teaches this brand's future hunts.</p>` : ''}
    <p class="url">${esc(c.hit?.url)} <span class="muted">(don't open this outside a sandbox)</span></p>
    <p>${esc(c.hit?.snippet)}</p>
    <p><b>${WHY_LABEL[c.state] ?? 'Why flagged'}:</b> ${esc(c.skipReason ?? d?.why ?? 'not classified')}</p>
    ${reasoningHtml(c.reasoning)}
    ${d?.visualEvidenceUnavailable ? '<p class="muted">This model could not check images.</p>' : ''}
    ${c.hit?.evidenceText ? `<p><b>Evidence:</b> ${esc(c.hit.evidenceText)}</p>` : ''}
    <p class="muted small">Found by ${esc(c.reporters.map(r => SURFACE_LABEL[r] ?? r).join(', '))}${d?.deciderId ? `, checked by ${esc(d.deciderId)}` : ''}</p>
    ${c.notice ? `<details class="fold" open><summary>Drafted notice</summary><pre>${esc(c.notice)}</pre></details>` : ''}
    ${c.approval ? `<p class="state-${esc(c.state)}">${c.approval.decision === 'approve' ? 'Approved. A simulated submission was recorded; nothing was sent.' : "Rejected. Saved so this brand's future hunts learn from it."}</p>` : ''}
    ${c.recheck ? `<p>Follow-up: ${esc(c.recheck.result === 'relisted' ? 'listed again' : 'taken down')}</p>` : ''}
    ${c.approval?.decision === 'approve' ? '<div class="actions"><span class="muted small">What happened afterwards?</span><button data-act="resolved">It was taken down</button><button data-act="relisted">It came back</button></div>' : ''}
  </div>`
  setHtml($('caseDetail'), html)
  setHtml($('panelBody'), html)
}

const onDetailClick = async e => {
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
    // Moves on to the next one, in the web's panel as well as on the Review tab.
    if (after) { selected = after.id; renderCases(); if (panelOpen()) WebView.update(view, selected) }
  } else if (await act(`/api/hunts/${huntId}/cases/${c.id}/recheck`, { result: a }, b)) {
    toast('Follow-up saved.')
  }
}

$('caseDetail').onclick = onDetailClick
$('panelBody').onclick = onDetailClick

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

const searchCount = h => `${h.counters.searches ?? 0} ${h.counters.searches === 1 ? 'search' : 'searches'}`
const costNote = () => (config.billed.length ? 'Real money.' : config.source === 'tape' ? 'Simulated.' : 'No charge counted: NIM credits and local Laya.')

function renderBilling() {
  const real = config.billed.length > 0
  $('billingNote').hidden = !real && config.source !== 'tape'
  if (!real && config.source === 'tape') $('billingNote').innerHTML = '<b>Recorded demo.</b> These results come from a made-up tape, not the web. Set NIM_API_KEY to search for real.'
  $('billingNote').classList.toggle('real', real)
  if (real) $('billingNote').innerHTML = `<b>Real money.</b> ${esc(config.billed.join(', '))} ${config.billed.length === 1 ? 'is' : 'are'} charged by OpenAI to the account of the configured API key. Customs stops at your limit, but set a cap in your OpenAI account too.`
  if (config.source === 'luna') document.querySelector('[name=budgetUsd]').value = '1.00'
  $('spendLimit').hidden = config.source === 'spiders'
  $('budgetHelp').textContent = real
    ? 'The most this hunt may charge to your OpenAI account.'
    : config.source === 'tape' ? 'Demo mode: costs are simulated, no real money.' : 'The agents run on NIM credits and Laya runs here, so nothing is counted against this yet.'
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
async function loadHunts() {
  const res = await fetch('/api/hunts').catch(() => null)
  if (!res?.ok) return
  const { summaries } = await res.json()
  setHtml($('huntList'), summaries.length
    ? `<ul class="hunts">${summaries.map(h =>
      `<li><button class="${h.id === huntId ? 'sel' : ''}" data-h="${esc(h.id)}"><span>${esc(h.brand)}</span><span>${h.verified} confirmed</span><span>${esc(WHEN.format(h.startedAt))}</span><span>${esc(STATUS_LABEL[h.status] ?? h.status)}${config.source === 'spiders' ? '' : `, ${usd(h.spentUsd)}`}</span></button></li>`).join('')}</ul>`
    : '<p class="muted">None yet. Your first hunt will appear here.</p>')
}
$('huntList').onclick = e => {
  const r = e.target.closest('button[data-h]')
  if (!r) return
  if (r.dataset.h !== huntId) openHunt(r.dataset.h)
  showTab('web')
}

async function boot() {
  const [cfg, hunts] = await Promise.all([fetch('/api/config').then(r => r.json()), fetch('/api/hunts').then(r => r.json())])
  config = cfg
  renderBilling()
  await loadHunts()
  const id = location.hash.slice(1)
  if (id && hunts.hunts.includes(id)) { openHunt(id); showTab('web') }
}
boot().catch(() => toast('Could not reach the server. Is it still running?', true))
