# Knowledge base, graph, steering and reasoners

These four additions answer one question: how does the swarm avoid spending money on, or accusing, the brand's own presences, and what does it do when the search or the decider isn't working?

## Knowledge base

Each brand has a list of its real domains, accounts, channels and sellers, stored on the durable Brand actor (`src/core/machines/brand.ts`, logic in `src/core/kb.ts`). It is built once per brand, before any scout starts, and every later hunt reuses it at no cost.

A reasoning model proposes entries with evidence (`src/harness/kb-builder.ts`). Whether an entry counts is decided by code, not by the model:

| Source | Becomes verified when |
| --- | --- |
| Operator, from the setup form | Always |
| Human, from the Knowledge base tab | Always |
| Reasoner | Confidence is at least 0.8 (`VERIFY_AT`) |

Everything else stays a `candidate`, which is only a hint and clears nothing. Shared platforms (`SHARED_HOSTS`) and bare-host accounts are refused, so a model can't whitelist a whole marketplace by naming it.

In the search path, `src/core/rules.ts` skips a listing that matches a verified entry before triage, so it costs nothing and can't be flagged. A failed build costs nothing, and the hunt carries on with what the operator entered.

## Graph

The graph lives in the Brand and Hunt actors and is computed on read by `buildGraph` in `src/core/graph.ts`. There is no separate graph database. The data is small, already durable, and a second store would need keeping in sync through crashes.

It has three layers:

- **Knowledge:** the brand and its presences, with a trust value.
- **Findings:** listings and the sellers, domains and wallets linked from them, plus `resembles` edges from a lookalike to the real site it copies.
- **Orchestration:** surfaces, lanes and spawned reasoners, with edges to what they found or checked.

Query it with:

```
GET /api/brands/:slug/graph
GET /api/brands/:slug/graph?node=<id>
GET /api/brands/:slug/kb
```

`POST` and `DELETE` on the `kb` route add or remove entries. Shared platforms get a 400.

The dashboard's `public/graph.js` draws it with a hand-written force layout on canvas, so it needs no library. It settles 220 ticks before first paint so the demo doesn't open on a tangle.

## Steering

The orchestrator (`src/harness/orchestrator.ts`) reviews each scout on a timer. `chooseSteer` in `src/core/lanes.ts` picks the switch and states why:

| Kind | Trigger |
| --- | --- |
| `blocked` | The search failed, for example a 403 |
| `exhausted` | No results, or only repeats twice running |
| `stalled` | At least 3 tries with a hit rate under 0.1 |
| `yield` | Another lane has clearly better returns |
| `cross-surface` | This surface is spent, so the scout moves to one with lanes left |
| `manual` | A human boosted a lane |

The kind and reason are stored on the Hunt actor and shown in the steering timeline. Lane results also feed the Brand and Playbook actors, so a later hunt starts on what worked.

## Reasoners

The orchestrator spawns a short-lived reasoning agent for what `/v1/decisions` can't settle (`src/core/escalate.ts`, `src/harness/reasoner-agent.ts`):

- **Unsure:** a score between 0.35 and 0.65, or confidence under 0.5.
- **Top:** the 2 highest-scoring findings per hunt, because they are the ones most likely to reach a human.

The limits are 8 reasoners per hunt, 2 running at once, and a budget hold taken before each starts. A claim on the Case actor stops two reasoners taking one case, and a claim older than 120 seconds can be retaken after a crash.

A verdict counts at confidence 0.7 or above (`REASONER_ACT_AT`). A reasoner can move a case towards the human, but it can't remove one from the queue. If it disagrees with a case already there, the case stays and the disagreement is shown.

A hunt without a reasoner runs on decisions alone.

## Failure behaviour

| Failure | What happens |
| --- | --- |
| Server killed | Hunts rebuild from actors. Saved tokens rejoin Relay. Cases left between report and triage are recovered |
| Actor runtime killed | Scouts restart under a supervisor, and timed loops log and retry. Startup resume retries for a minute |
| Relay sheds load | `withBackoff` honours `retryable` and `retryAfterMs` |
| Reasoner throws | The hold is released and the case is marked failed. The hunt carries on |
