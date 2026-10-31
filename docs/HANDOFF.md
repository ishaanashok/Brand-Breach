# Handoff: from today to an end-to-end demo

Written 2026-10-31. For the agent implementing the remaining work. Read this file, then `README.md`, `docs/knowledge-graph-and-steering.md` and the "Demo plan" section of `docs/PRD.txt`.

## Where things stand

Customs finds brand abuse with a swarm of agents. Humans approve or reject drafted takedown notices, and no notice is ever really sent.

The app now runs on the intended stack: Terse's Durable Actors, running locally, plus Agent Relay's cloud service, Luna agents and the OpenAI Decisions API. This work is on `main`.

### Decisions made by the user

- **Hosting:** actors stay local on this computer. Terse's cloud is out of scope.
- **Screenshots:** deferred. PR 4 uses each page's own preview image only.
- **Actors:** one durable actor per brand, holding a persistent knowledge graph of earlier searches, what succeeded and failed, and how pages map across searches. This replaces the 16 shared case actors, and is being built by the coordinating thread. Built: each brand's actor keeps cases, pages (with every hunt that saw them), links and searches as table rows. See it at `GET /api/brands/:slug/memory`. Hunts stay as their own short-lived actors because they are the hot budget meter. Later hunts don't yet use the search history to choose where to look.

Last real run: New Balance, $0.50 limit, stopped at $0.43, with 542 pages, 76 awaiting review, 4 steers, 2 second opinions, about 20 actor processes and no errors.

The pipeline runs, but its output isn't good enough to demo. The review queue is full of coin-flip scores and articles about scams, and several things the user expects don't exist yet.

## How to work

- Branch from `main`, with one PR per work item below. Don't merge your own PRs: the coordinating agent reviews and integrates them.
- In the PR description, include what you ran, its result, what it cost, and anything you couldn't verify.
- Match the surrounding code. Comments are sparse and explain why, not what. UI text is plain language with no internal jargon.

### Running it

Start the actor runtime, then the app. If you use the desktop preview, the configs in `.claude/launch.json` are `actors` and `customs`.

```bash
bun run dev:actors
```

```bash
bun run generate
```

```bash
PORT=3000 bun src/server/main.ts
```

Checks that must pass on every PR:

```bash
bun test
```

```bash
bun run check
```

```bash
bun --env-file=.env run scripts/verify-actors.ts
```

### Rules

- **Never submit a real notice**, and always label results as candidates flagged for review.
- **Never open a suspected scam page in a browser**, including the agent's own preview browser. Fetching text on the server is fine. Don't embed images from those sites by their remote URL.
- **Real money:** live hunts bill the OpenAI key in `.env`. Use mock or tape modes when you can, and keep live test hunts to $0.50 unless told otherwise. Report what you spent.
- **Don't commit `.env`, `.customs/` or `generated/`.** Relay join tokens are saved under `.customs/`.
- **After changing an actor method,** rerun `bun run generate`. Every machine method needs a matching method on its actors: `tests/actors.test.ts` enforces this.
- **Test on the real stack before calling something done.** The file store calls the logic directly, so it hides actor bugs. Earlier real-stack failures were invisible there.
- **Shell:** the default shell is zsh, so quote globs such as `--include='*.ts'`.

## Blockers

### Needs the user

| # | Blocker | Blocks | Recommendation |
|---|---|---|---|
| B5 | Check real OpenAI costs against the app's estimates. The prices in the code come from resellers | Trusting cost figures in the demo | User compares the OpenAI bill for today's hunts with the app's total |

### Technical or external

| # | Blocker | Impact | Handling |
|---|---|---|---|
| B6 | Agent Relay was slow on 2026-10-31: 4–10 seconds per call in a bare test, with some overload errors | The PRD wants a steer to take effect within about 20 seconds. Relay could also fail during the demo | Measure it in PR 1. Rehearse a fallback to `CUSTOMS_BUS=memory` |
| B7 | Many fetched pages return no text. 64 of the 71 Columbia pages scored 50% had none, and Reddit made up 53 of the 139 items awaiting review. The cause isn't confirmed; bot blocking is the likely one | Weak evidence and 50% scores | Find the cause in PR 2. Don't rely on Reddit text being available |
| B8 | Hunts on the file store in `.customs/live` (Columbia, Patagonia, Lululemon and others) don't appear on the actor store | Their history and knowledge bases are missing | Don't delete them: PR 2 uses them as test data. Migrate only if the user asks |

## Work items, in order

PRs 2–7 can run in parallel where they don't touch the same files, except that PR 3 and PR 4 both change Review, so run PR 4 after PR 3.

### PR 1: Harden the real stack

**Why:** the demo includes a live restart, and these checks predate today's changes.

- Rerun both `kill -9` tests on the current code, killing the server and then the actor runtime mid-hunt. Fix what breaks.
- Fix pages stranded when the budget runs out. The New Balance hunt ended with 4 pages in "Being checked" and 1 confirmed page that never reached review. `verifier.ts` reserves money, shortlists, then can stop partway. Either finish in-flight work or return those pages to a clear state.
- Reduce the pauses in the hunt view. It took up to about 15 seconds during bursts of new pages, with 11–14 seconds seen several times. Find the cause first. Suspects are that each write stores a shard's whole state in `CaseShard`, and `Scout.handleHit` makes several awaited actor calls per page.
- Check memory. Actor processes used about 1.7 GB in total, on a run with 20 processes.
- Measure how long a steer takes from send to lane change under real Relay latency (B6).
- Add one command that starts the actors and the app together, and fails clearly if the runtime is down.
- Fix scouts that still show "online" after a hunt ends.

**Done when:** both kill tests pass, no case is stranded after a budget stop, the view stays under 2 seconds during a 500-page hunt, and steer latency is reported.

**Files:** `src/harness/verifier.ts`, `src/harness/scout.ts`, `src/harness/hunt-runner.ts`, `src/actors.ts`, `src/server/api.ts`, `package.json`.

### PR 2: Fix review queue accuracy (highest user priority)

**The user's explicit request:** articles about scams must be avoided, because they shouldn't be taken down, and this should exist as a rule or knowledge. Also, most risk scores sit at 50%.

**Evidence from the Columbia hunt:**

- 71 of 139 items awaiting review scored almost exactly 50%, and only 7 of those 71 had page text. Patagonia and Lululemon show the same spike (82 of 111, and 119 of 178, in the 50–60% range).
- `summarize` in `src/core/questions.ts` labels 0.50 as "impersonation likely". `VERIFIED_AT = 0.5` in `src/harness/verifier.ts` then passes it. So "I don't know" becomes a hit.
- The top of the queue is scam commentary: malware-guide.com at 100%, makingsenseofsecurity.com at 100%, malwaretips.com at 98%, the FTC's consumer.ftc.gov at 97%, faux.fr at 97%, plus scamadviser.com, gridinsoft.com, scam-detector.com, scamwatcher and r/Scams.
- The cause: the question "does this content promote a scam" scores pages about scams highly. Luna agents are told to skip such pages, but search results go straight to the classifier without passing through them.
- Real fakes must keep scoring high: uscolumbia-shop.com at 96% and columbiausoutlet.com at 85–95%.

**Do this:**

1. Build a labelled test set first, from `.customs/live` cases: at least 30 scam articles or discussions and 30 likely real abuse pages. Measure before and after. The user should review the labels, since they are judgement calls.
2. Add a Decisions question to triage and verify, such as "does this page warn about, report on or discuss a scam, rather than commit one?". Triage already has 4 questions and the adapter splits at 5, so adding one doesn't add a call.
3. Add a cleared outcome with a plain reason, such as "Page discusses scams; not a takedown target". Keep these under "Not flagged" so a person can still check them.
4. Add shared knowledge that applies to every brand, listing consumer protection sites, scam checkers, security vendors and scam forums such as r/Scams. `rulesCheck` in `src/core/rules.ts` is the free first step. The Playbook actor is global, so store it there and seed it from a small list in code. Never skip a whole shared platform: `reddit.com/r/Scams` is fine, `reddit.com` isn't.
5. Treat pages with no readable text as "couldn't read", not 50%. They need their own label and Review filter, and must not count as confirmed. Find the cause of B7, and try the search snippet as fallback evidence.
6. Stop scores of about 0.50 counting as "likely" or confirmed. Choose the new bar using the test set. Check the effect of `precision` and `thresholdFor` in `src/core/policy.ts`.
7. Let a confident "legitimate" second opinion clear a case. Today `setReasoning` in `src/core/machines/case.ts` only adds a note to one already awaiting approval. Keep the second opinion's limit of 8 per hunt unless the test set shows that's too low.

**Done when:** on the test set, at least 90% of scam articles stay out of the queue and at least 90% of real abuse pages stay in; the live queue's top 20 has no scam articles; fewer than 10% of queue items sit at 45–55%; and every cleared page shows why. These targets are proposals, so report results even if you miss them.

**Files:** `src/core/questions.ts`, `src/core/rules.ts`, `src/core/machines/case.ts`, `src/core/machines/playbook.ts`, `src/harness/verifier.ts`, `src/harness/scout.ts`, `src/actors.ts`, `public/app.js`.

### PR 3: Group pages by site

**Why:** `columbiausoutlet.com` alone produced 34 of 139 queue items, and a reviewer shouldn't approve 34 separate notices for one site.

- Group the queue by domain, except on shared platforms, where each account or path is its own group.
- Show the highest risk, the number of pages and the evidence for the group. Allow one decision for the whole group, recorded on each case so the existing learning still works.
- One draft notice should cover a group's listed URLs.

**Done when:** a site with many pages appears once, one approval resolves all its pages, and rejecting a group updates the learning for the brand.

**Files:** `public/app.js`, `src/server/api.ts`, `src/core/notice.ts`, `src/harness/hunt-runner.ts`.

### PR 4: Review page with candidate cards

**The user's explicit request:** Review shows the top candidates, each with its own card containing an image from the page, the URL, confidence and so on. Today it's a table with one detail panel, and no images are captured.

- Replace the table with ranked cards: image, a readable title, URL, risk, confidence, reason, where found, second opinion, and approve and reject buttons. Many cases have the URL as their title, so derive a better title from the fetched page.
- Capture the image on the server. The fetched HTML's `og:image` is a reasonable first step: `readPage` in `src/harness/web.ts` currently returns text only.
- **Safety:** download on the server with limits on size and time, accept raster formats only, and serve only the stored copy. Don't send the browser to the remote image. Remember the blur rules for handles.
- **Storage:** keep image files on disk, such as `.customs/evidence/<caseId>`, with only a reference on the case. Putting image data in the Brand actor's case rows would make every write to that shard slower.
- Pages without an image need a clear placeholder. Real screenshots are deferred.
- Optional, once images exist: send them to Decisions through `Evidence.images`. The adapter already supports it. Measure the cost and the benefit before enabling it.
- Keep it usable at 375px wide, with no page scroll sideways.

**Done when:** a live hunt's Review page shows cards with stored images where available, no network request goes from the browser to a candidate site, and the page works at phone width.

**Files:** `public/app.js`, `public/index.html`, `public/style.css`, `src/harness/web.ts`, `src/harness/spiders.ts`, `src/harness/verifier.ts`, `src/server/api.ts`, `src/core/types.ts`.

### PR 5: Knowledge base graph view

**The user's explicit request:** a visual graph of the brand's knowledge base, separate from the spider web. It's also a P1 in the PRD and step 5 of the demo. The data exists but no page uses it.

- Add a brand page using the existing `GET /api/brands/:slug/graph` and `GET`/`POST /api/brands/:slug/kb`. These haven't been exercised from a browser, so check them first.
- Show the brand's real sites and accounts, sellers, listings, domains, wallets and channels, with kinds of link visibly distinct. Clicking a node shows its neighbours through `?node=`, along with evidence and which hunts found it.
- Let a person add or remove knowledge base entries from this page. Show the graph across all hunts for a brand.
- Handles and wallets stay blurred. The API already redacts them, so don't work around that.
- Check whether leads between scouts actually create edges and follow-up searches on the Luna source. The PRD demo depends on it, and it wasn't checked in today's review. If they don't, fix that here.

**Done when:** after two hunts for one brand, the view shows what both found, it stays usable at 500+ nodes, and an added entry is respected by the next hunt.

**Files:** new `public/graph.js`, `public/app.js`, `public/index.html`, `public/style.css`, `src/core/graph.ts`, maybe `src/harness/luna.ts`.

### PR 6: Final report from the orchestrator

**The user's explicit request:** the orchestrator compiles a report at the end. Today no compile step runs. "Download report" fetches statistics from `src/core/report.ts` when clicked.

- When a hunt ends, for any reason, have the orchestrator write one report and store it on the Hunt actor, so it survives restarts. A failed report must not stop the hunt from ending.
- Contents: summary, top candidates and sites, totals by surface, cost per verified finding, what steering did and why, how this compares with earlier hunts, what was left unchecked and why, and the standard "candidates, not findings" disclaimer.
- Numbers come from code. A model writes only the narrative, and never invents figures. Count its cost against the budget, keeping back enough to write the report.
- Show it in the dashboard and make the download button return it.

**Done when:** every way a hunt can end produces one report, its figures match the case data, and a restart doesn't lose or duplicate it.

**Files:** `src/harness/orchestrator.ts`, `src/harness/hunt-runner.ts`, `src/core/machines/hunt.ts`, `src/actors.ts`, `src/core/report.ts`, `public/app.js`.

### PR 7: Steering based on quality

**The user's question:** is there active steering? Only partly. Every steer seen in real hunts was of the kind "exhausted", meaning a lane ran dry. Steers based on yield exist in `src/core/lanes.ts` but weren't seen firing. The PRD wants redirection based on yield per dollar.

- Find out why `yield` and `stalled` steers don't fire. Timing is a likely reason: hunts deliver bursts of pages, and short test hunts may end too early.
- Feed in quality signals after PR 2: a lane mostly returning articles or unreadable pages should lose out to one finding confirmed abuse.
- Each steer shows its reason in plain language. Keep the PRD's limit of one steer per scout every 20 seconds.
- Second opinions should go where they change a decision. Today they only cover 8 cases per hunt.

**Done when:** a live hunt shows at least one steer caused by quality or yield, its reason is visible on the dashboard, and the steered lane takes effect within about 20 seconds (subject to B6).

**Files:** `src/core/lanes.ts`, `src/harness/orchestrator.ts`, `src/harness/scout.ts`, `public/app.js`.

### PR 8: Demo readiness

**Depends on all the above.** Follow the PRD's three-minute plan:

| Time | Step | Depends on | Status today |
|---|---|---|---|
| 0:00 | Enter Tesla, a few keywords and a small budget | | Works, not rehearsed with Tesla on the current stack |
| 0:30 | Scouts light up, with cost meter and counters climbing | PR 1 | Works, but pauses during bursts |
| 1:00 | Duplicates prevented, and a budget bar that never passes its limit | | Actor race check passes |
| 1:30 | Orchestrator redirects a scout, with the reason visible | PR 7 | Only "ran dry" steers seen |
| 1:50 | A lead links a seller to channels and lookalike sites | PR 5 | No graph view; leads not checked |
| 2:15 | Open a case, see evidence and reason, approve, simulated submit | PR 2, 3, 4 | Works, but the queue is poor |
| 2:35 | Kill and restart the server, hunt and cases intact | PR 1 | Needs retesting |
| 2:50 | Cost per verified finding and second-run improvement | PR 6 | Second-run improvement unproven |

Also:

- Record a new replay tape from a good live hunt. Prove it runs on actors and Relay, and prove the automatic switch if live results are thin (`autoFallback`, `minHits: 5` within 30 seconds, in `src/server/main.ts`).
- Show on screen which decider made each call. The PRD requires it.
- Prove the second-run claim with real numbers on two hunts of one brand. Don't claim it otherwise.
- Check the safety rules on the screen used for the demo: blurred handles and wallets, "candidates" wording, no scam pages opened.
- Decide what's shown for Musk, since the PRD says "Tesla and Musk". Check that both run well.
- Fill in the README's "verified" table with results, and update the PRD for one actor per brand.
- Write a short runbook: start commands, the price and time of a run, what to do if Relay or live search fails, and how to reset between rehearsals.
- Rehearse the whole script three times in a row on the real stack, with the live fallback tested at least once.

**Done when:** a person following only the runbook completes the demo in about three minutes, three times in a row, and its live cost is known.

## Not needed for the demo

Don't build these unless asked: outside agent joining as a scout, Belt-style dashboard skin, Jev second opinion, Supabase, and Mastra approval workflow (all PRD P2). The re-check button already exists. Laya and NIM remain alternative modes, so don't remove them, but they aren't part of the demo stack.

## What the user asked for, and where it's covered

| Request | Status | Covered by |
|---|---|---|
| Agent Relay and Terse Durable Actors in use | Done | PR 1 |
| Persistent knowledge graph per brand | Stored on the Brand actor. Older brands need rebuilding on this stack | PR 5, B8 |
| Graph view of the knowledge base, separate from the spider web | Not built | PR 5 |
| Luna finds pages, Decisions classifies, scores reported directly | Done. Score is the higher of two Decisions probabilities. Agents don't filter search results | PR 2 |
| Active steering | Partial: only "ran dry" steers seen | PR 7 |
| Orchestrator compiles a report at the end | Not built | PR 6 |
| Review shows top candidates as cards with image, URL and confidence | Not built | PR 3, PR 4 |
| Explain and fix scores stuck at 50% | Explained, not fixed | PR 2 |
| Avoid articles about scams, as a rule or knowledge | Not built | PR 2 |
