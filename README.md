# Customs

A cost-aware agent swarm that hunts brand abuse across five surfaces. Scouts search, a cheap decider triages, a stronger one verifies, an orchestrator steers the search and calls in reasoning agents for what decisions can't settle, and a human approves every notice.

Results are candidates flagged for review, not accusations. Notices are drafts, submission is simulated, and nothing here is legal advice.

Design notes for the knowledge base, graph, steering and reasoners are in [docs/knowledge-graph-and-steering.md](docs/knowledge-graph-and-steering.md). The original plan and its deviations are in [docs/superpowers/plans/2026-10-30-customs.md](docs/superpowers/plans/2026-10-30-customs.md).

## Run the offline demo

Needs [Bun](https://bun.sh) 1.4. No keys and no other processes.

```bash
bun install
```

```bash
CUSTOMS_STORE=file CUSTOMS_BUS=memory DECIDER_MODE=mock REASONER_MODE=mock bun start
```

Open http://localhost:3000 and start a hunt for `Tesla`. Everything shown comes from the synthetic tapes in `tapes/`, and the dashboard labels mock results as such.

The tabs:

- **Live hunt:** scouts, budget, the steering timeline with the reason for each switch, reasoner spawns, events.
- **Graph:** the brand's verified presences, findings and agents. Turn each layer on or off, click a node for its evidence.
- **Knowledge base:** what counts as real for this brand, where each entry came from, and manual add or remove.
- **Cases:** the review queue, with the reasoner's verdict and evidence. Approve or reject here.
- **Report:** spend per finding, run history, decider disagreements, fallbacks.

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
| `CUSTOMS_SOURCE` | `live`, anything else | tape | `live` needs `OPENAI_API_KEY` and falls back to the tape if it finds too little |
| `DECIDER_MODE` | `laya`, `openai`, `hybrid`, `mock` | `laya` | Who triages and verifies. `laya` needs the [sidecar](sidecar/README.md) |
| `LAYA_URL` | URL | `http://localhost:8000` | Where the sidecar listens |
| `REASONER_MODE` | `openai`, `mock` | `openai` with a key, else `mock` | Who builds the knowledge base and verifies escalations |
| `REASONER_MODEL` | model id | see `src/reasoners/openai.ts` | Reasoning model |
| `REASONER_USD_PER_M_INPUT`, `REASONER_USD_PER_M_OUTPUT` | number | 1, 4 | **Placeholder prices.** Set real ones before trusting the budget |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | | | OpenAI credentials and endpoint |
| `PORT` | number | 3000 | Dashboard port |

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
| Test suite and types | `bun test`, `tsc` | 97 pass, clean |
| Case dedupe and no budget overshoot | `verify-actors.ts` on real actors | 1 first and 4 duplicates, 0 overshoot |
| Full hunt on real actors and real Relay | Tesla tape, mock deciders, $0.50 budget | Finished at $0.132: 18 verified, 3 own presences skipped, 12 steers, 5 reasoners |
| `kill -9` of the server mid-hunt | Real stack | Resumes, and triages cases the crash stranded |
| `kill -9` of the actor runtime mid-hunt | Real stack | State kept, scouts restart, hunt finishes |
| Laya wire format | Sidecar 0.4.18 against the tape | Median 61ms, p95 473ms, triage 25/27 on synthetic data |
| Dashboard | Browser, offline demo | Graph, KB, cases, approve, reject, repeat decision refused, 375px width without page scroll |

## What has not been verified

- **OpenAI:** no key was available. The Decisions and Responses adapters, the live search source and `gpt-6-luna` have only run against stubs. Real prices and response shapes may differ.
- **Reasoning quality:** every knowledge base and verdict so far came from `mock-reasoner` and `tapes/kb.json`. The real presences in that file are made up.
- **Reasoner disagreement in the UI:** the machine and tests cover it, but no browser run produced one.
- **Decision accuracy:** the Laya triage figure comes from a small synthetic tape and says nothing about real listings.

## Known limits

- A crash in the instant between creating a case and adding it to its hunt loses that case from the hunt's list. A later report only counts as a duplicate.
- Screenshot capture needs a sandbox vendor and isn't built, so live mode has no visual evidence. The other P2 items in the plan are also not built.
- One server death early in development was never explained or reproduced. A later outage test found a startup crash that could be the same thing, now fixed.
