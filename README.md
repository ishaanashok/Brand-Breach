# Customs

A cost-aware agent swarm that hunts brand abuse across five surfaces. Scouts search, a cheap decider triages, a stronger one verifies, an orchestrator steers the search and calls in reasoning agents for what decisions can't settle, and a human approves every notice.

Results are candidates flagged for review, not accusations. Notices are drafts, submission is simulated, and nothing here is legal advice.

Design notes for the knowledge base, graph, steering and reasoners are in [docs/knowledge-graph-and-steering.md](docs/knowledge-graph-and-steering.md). The original plan and its deviations are in [docs/superpowers/plans/2026-10-30-customs.md](docs/superpowers/plans/2026-10-30-customs.md).

## Run a real hunt

Agents are GLM 5.3 Flash on NVIDIA NIM, at low reasoning. They choose their own searches, search the live web (DuckDuckGo, then Bing) and read pages as plain text. [Laya](sidecar/README.md), running on this computer, is the only classifier. GLM never gives a verdict, and a URL only counts if it really came back from the web.

Needs [Bun](https://bun.sh) 1.4, the [Laya sidecar](sidecar/README.md) installed, and `NIM_API_KEY` in `.env`:

```bash
NIM_API_KEY=nvapi-...
CUSTOMS_SOURCE=spiders
REASONER_MODE=glm
DECIDER_MODE=laya
```

Start Laya, then the dashboard:

```bash
bun run laya
```

```bash
CUSTOMS_STORE=file CUSTOMS_BUS=memory CUSTOMS_STATE_DIR=.customs/live bun start
```

Open http://localhost:3000 and name any brand. If Laya is down, cases are marked undecided: nothing else judges them. To use OpenAI's Decisions API once there's a key, set `OPENAI_API_KEY` and `DECIDER_MODE=target`.

## Run the offline demo

For the made-up recorded data, with no keys or network:

```bash
CUSTOMS_STORE=file CUSTOMS_BUS=memory CUSTOMS_SOURCE=tape DECIDER_MODE=mock REASONER_MODE=mock bun start
```

The dashboard labels this as a recorded demo.

The dashboard has two pages:

- **New hunt:** name a brand and press Start hunt. Search terms, the brand's own sites, sellers and the spending limit are under Options. Earlier hunts are listed below.
- **Review:** every candidate in a list with filters, its evidence, and approve or reject.

Starting a hunt opens the web. Agents spin silk outwards from the brand at the centre, with a point at each junction. A listing they find sits on a larger point in that agent's part of the web, and a spider stays behind on each one flagged as an infringement. Press a spider for the same details and decisions as Review. Only those larger points are data: the rest of the silk is how the search looks, and doesn't count sites.

Pause, the spending limit and the report download are on the web page. The graph, knowledge base and steering are still available through the API, but the dashboard no longer shows them.

## Run on the real stack

Start the actor runtime first, because `generate` reads from it. Rerun `generate` whenever an actor method changes.

```bash
bun run dev:actors
```

```bash
bun run generate
```

```bash
DECIDER_MODE=mock REASONER_MODE=mock bun start
```

With no `CUSTOMS_STORE` or `CUSTOMS_BUS` set, state lives in Durable Actors and agents talk over Agent Relay. Relay join tokens are saved to `.customs/relay-<huntId>.json`, mode 0600 and gitignored, so a restarted server rejoins the same room.

## Configuration

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `CUSTOMS_STORE` | `file`, anything else | actors | `file` keeps state in `.customs/actors` |
| `CUSTOMS_BUS` | `memory`, anything else | Relay | `memory` is an in-process bus |
| `CUSTOMS_SOURCE` | `luna`, `spiders`, `live`, `tape` | `luna` with `OPENAI_API_KEY`, `spiders` with `NIM_API_KEY`, else `tape` | `luna` is Luna agents searching through OpenAI. `spiders` is NIM agents scraping search engines. Neither falls back to the tape. `live` is OpenAI web search, which can |
| `NIM_API_KEY`, `NIM_BASE_URL` | | | NVIDIA NIM credentials |
| `NIM_MODEL` | | `nvidia/nemotron-3.5-bolt-e4b` | Fast model for the spiders. About 1s a turn when measured |
| `NIM_KB_MODEL` | | `z-ai/glm-5.3-flash` | Builds the knowledge base at low reasoning. Gets 45s, then the spider model takes over |
| `CUSTOMS_STATE_DIR` | path | `.customs` | Where the file store keeps state |
| `DECIDER_MODE` | `openai`, `laya`, `target`, `hybrid`, `shadow`, `mock` | `openai` with a key, else `laya` | Who triages and verifies. `openai` is the Decisions API alone. `target` uses OpenAI with Laya behind it, `hybrid` uses Laya then OpenAI, `shadow` compares both. All but `mock` need the [sidecar](sidecar/README.md) or a fallback to it. `laya` has no fallback |
| `LAYA_URL` | URL | `http://localhost:8000` | Where the sidecar listens |
| `REASONER_MODE` | `glm`, `openai`, `mock` | `openai` with a key, else `mock` | Who builds the knowledge base and verifies escalations. `glm` only builds the knowledge base, from real search results, and never judges a case |
| `REASONER_MODEL` | model id | see `src/reasoners/openai.ts` | Reasoning model |
| `REASONER_USD_PER_M_INPUT`, `REASONER_USD_PER_M_OUTPUT` | number | 1, 4 | **Placeholder prices.** Set real ones before trusting the budget |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | | | OpenAI credentials and endpoint |
| `LUNA_MODEL`, `LUNA_USD_PER_M_INPUT`, `LUNA_USD_PER_M_OUTPUT`, `LUNA_SEARCH_USD` | | `gpt-6-luna`, 0.10, 0.50, 0.012 | Search agents and their prices. The prices come from resellers, so check them against OpenAI's rate card |
| `PORT` | number | 3000 | Dashboard port |

## The budget

The budget is a spending limit for one hunt, not money you pay into Customs. Before each paid step, an agent reserves its estimated cost on the Hunt actor, which refuses once the limit would be passed. The actual cost replaces the estimate afterwards.

- **Offline demo and `mock` modes:** no money moves. Search costs come from the tape's `searchUsd`, and the mock reasoner charges a pretend amount, so you can see the budget logic at work.
- **GLM on NIM:** runs on NVIDIA's credits, so money can't stop these hunts. There is no search limit: agents cover every lane once, then follow up to 8 leads. A hunt ends when that is done, when 5 agents in a row find nothing the classifier scores at 0.8 or above, or when no agent has anything to do for 10 seconds. Agents share what the hunt has covered: a search that repeats an earlier one is refused, results already seen are hidden, no page is read twice, and at most 3 pages are read per site. Pages found by earlier hunts for the brand count as covered.
- **What gets classified:** every new search result goes straight to Laya as it arrives, so agents only choose where to look. A page is only fetched once its search result earns a closer look, and that text is what the second check reads.
- **Search quality:** without a key, search scrapes DuckDuckGo at one search every 3 seconds, and DuckDuckGo may still block a machine that searches a lot. Bing is the fallback, but it often ignores most of a query, so its off-topic results are dropped and a hunt can find little. Set `BRAVE_SEARCH_API_KEY` to use Brave's search API instead. The hunt's last line says when DuckDuckGo wasn't answering.
- **With `OPENAI_API_KEY`:** adding the key switches the app over with no other settings: Luna agents search through OpenAI, the Decisions API replaces Laya, and the sidecar and DuckDuckGo aren't needed. Hunts end the same way, with the money limit as a backstop. Leave `CUSTOMS_SOURCE`, `DECIDER_MODE` and `REASONER_MODE` unset, because they override this.
- **Real providers:** the money comes from whichever `OPENAI_API_KEY` you configure, billed by OpenAI to that account. That covers `/v1/decisions`, the reasoner and live search. Customs has no billing of its own and never handles a payment.
- **Not counted:** Laya on your own machine (free per call), and any charges from hosting Durable Actors or Agent Relay.

The dashboard says which case applies. The limit stops new spending, but it is only as accurate as the provider prices in the code, and the reasoner prices are placeholders. Set a spending cap in your OpenAI account too.

## Tests

```bash
bun test
```

```bash
bun run check
```

`scripts/verify-actors.ts` runs the dedupe and budget races against the real actor runtime.

## What has been verified

| Check | How | Result |
| --- | --- | --- |
| Test suite and types | `bun test`, `tsc` | 138 pass, clean |
| Case dedupe, grouped cases and no budget overshoot | `verify-actors.ts` on real actors | 1 first and 4 duplicates, 600 of 600 cases kept, 0 overshoot |
| Full hunt on real actors and real Relay | New Balance, Luna and Decisions, $0.50 budget | Stopped at its limit at $0.43: 542 pages, 76 awaiting review, 4 steers, 2 reasoners, about 20 actor processes, no errors. The longest wait for the hunt view was about 15s, during bursts of new pages |
| `kill -9` of the server mid-hunt | Real stack, before cases were grouped | Resumes, and triages cases the crash stranded |
| `kill -9` of the actor runtime mid-hunt | Real stack, before cases were grouped | State kept, scouts restart, hunt finishes |
| Laya wire format | Sidecar 0.4.18 against the tape | Median 61ms, p95 473ms, triage 25/27 on synthetic data |
| Dashboard | Browser, offline demo | Search, weaving, spider details, approve, reject, finished hunt reopened, Review, 375px width without page scroll |

## What has not been verified

- **Classifier accuracy on the real web:** see the hunt in the table above. Laya flagged pages that warn about scams as well as scams, so a human decision still matters.
- **OpenAI prices:** the Decisions API, Luna and web search have run for real, but the prices come from resellers and may differ from OpenAI's bill.
- **Reasoning quality:** knowledge bases and verdicts now come from Luna, but nobody has checked how accurate they are.
- **Reasoner disagreement in the UI:** the machine and tests cover it, but no browser run produced one.

## Known limits

- The local actor runtime runs one process per live actor, so cases share 16 actors per brand. Hunts started on the file store (`.customs/live`) don't appear on the actor store.
- Relay can take seconds a call. Sends never hold up an agent: direct messages go first, and when more than 100 channel posts are waiting the oldest are dropped. The actors stay the record of what happened.
- A crash in the instant between creating a case and adding it to its hunt loses that case from the hunt's list. A later report only counts as a duplicate.
- Screenshot capture needs a sandbox vendor and isn't built, so live mode has no visual evidence. The other P2 items in the plan are also not built.
- One server death early in development was never explained or reproduced. A later outage test found a startup crash that could be the same thing, now fixed.
