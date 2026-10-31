# Laya sidecar

Local decider, free per call, used for triage in `laya` and `hybrid` modes.

```bash
uv venv --python 3.12 sidecar/.venv
uv pip install --python sidecar/.venv/bin/python "laya[serve]"
LAYA_HOST=127.0.0.1 LAYA_MODELS=english sidecar/.venv/bin/laya-serve
```

`laya-serve` has no flags and ignores `--help`: it starts the server. It is configured only by
environment variables and binds `0.0.0.0` unless told otherwise, hence `LAYA_HOST` above.
Customs expects it on port 8000; set `LAYA_URL` to point elsewhere.

## Wire format, checked against laya 0.4.18

`POST /v1/systemone` with `{ state, questions: { name: { type, instructions, criteria } } }`.

| Type | `criteria` | Answer |
| --- | --- | --- |
| `noul` | optional | `noul` is P(true) |
| `choice` | object, value to description | `choice`, `probabilities` by value, `confidence` |
| `score` | list of levels, lowest first | `score` is the expected level, `probabilities` by index |

## Measured on the synthetic tape (27 hits, Apple MPS)

Contract check passed. Median 61 ms, p95 473 ms including the first cold call. Triage agreed with the
tape's labels on 25 of 27. That tape is synthetic, so this shows the adapter works, not real-world accuracy.
