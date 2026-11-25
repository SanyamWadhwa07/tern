# Run logs

Every run writes four files to its log directory (`--log-dir`, default `~/.tern/runs/<time>`).
They are meant to be read without the harness: by the benchmark join, and later as training data
for a fine-tune on verified successful runs and for a model that predicts false "done" claims.

Format version: `tern-trajectory/1`. Every record and file carries it, plus the run's `runId`.

| File | What it holds |
|---|---|
| `trajectory.jsonl` | one record per event, in order, each with `format`, `runId`, `at` and `type` |
| `messages.json` | the whole conversation in OpenAI chat format plus the tool schemas, ready for supervised fine-tuning |
| `claims.jsonl` | every `done` claim with its checks, accepted or not |
| `result.json` | the run's summary and a `label` slot for the final grade |

## trajectory.jsonl records

| `type` | Fields |
|---|---|
| `start` | `meta` (Tern version, model, endpoint, working directory, checks, protected paths, turn limit, start time), `system`, `tools`, `task` |
| `reply` | `turn`; `raw`: the model's text and tool calls exactly as streamed, before repair; `calls`: the repaired calls with ids; `bad`: calls that could not be repaired, with the error sent back; `repairs`: the name of every fix; `usage`: prompt and completion tokens, and cost when the endpoint reports it |
| `tool` | `turn`, `id`, `name`, `args`, `result` |
| `claim` | `claim`: turn, summary, accepted, verified (false when there were no checks), restored protected files, and each check's command, exit code, time and output tail |
| `guard` | `turn`, `notes`: budget and loop notes added to the last tool result before this turn's request, `stop` when the guard ends the run |
| `end` | `status` (`done`, `max_turns`, `time_limit`, `token_limit`, `loop` or `error`), `turns`, total `usage`, `repairs`, `badCalls`, `claimedDone` |
| `label` | added later: `passed`, `reward`, `source`, `falseDone`, `labeledAt` |

`raw` next to `calls` is what makes the repair layer measurable, and what a model trained to emit
well-formed calls learns from.

## The final grade

The grade comes after the run. On Terminal-Bench, the hidden tests run once the agent has stopped.
Record it with:

```bash
npm run label -- <log-dir> --passed|--failed [--reward <n>] [--source harbor]
```

This sets `result.json` → `label` and appends a `label` record to `trajectory.jsonl`. A run is
**false-done** when the agent had a `done` claim accepted but the grade failed.

For a fine-tune, the useful runs are the ones with `label.passed` true. For a stop-or-verify model,
each `claim` record is an example, and the run's `label` says whether that claim was true.
