# Benchmark plan (not run yet)

Nothing in this folder has been run. Terminal-Bench needs Docker and is too heavy for the
development laptop, and model calls through OpenRouter cost money. Every paid run starts with a
written cost estimate and an explicit go-ahead.

## What will be compared

Terminal-Bench 2.0, 89 tasks × 5 trials, same model for every harness, via
[Harbor](https://github.com/harbor-framework/harbor):

| Harness | How it runs | Result |
|---|---|---|
| Tern | `bench/tern_agent.py`, installed in the container | not measured yet |
| Terminus 2 | Harbor built-in | not measured yet |
| little-coder | its own [Harbor adapter](https://github.com/itayinbarr/little-coder/tree/main/benchmarks/harbor_adapter) | 24.6% ± 3.2 on its own run (llama.cpp, Q4_K_M), see [BASELINES.md](../docs/BASELINES.md) |
| OpenCode | Harbor built-in | not measured yet |

little-coder's number came from a local Q4_K_M model. A run through OpenRouter serves a different
build of the same model, so the fair comparison reruns little-coder on the same endpoint.

## Reported for every harness

- resolution rate with a 95% interval, and the raw count (solved / 445)
- **cost per solved task**: total cost / tasks solved
- **false-done rate**: trials where the agent claimed done but the hidden tests failed / all trials
  with a done claim. Tern logs every claim in `claims.jsonl`; for other harnesses, a final message
  saying the task is complete counts as the claim.
- tokens per trial, turns per trial, and Tern's repair counts

## Commands (check flags against `harbor run --help` first)

```bash
harbor run --dataset terminal-bench@2.0 --agent-import-path bench.tern_agent:TernAgent \
  --model openrouter/<model-slug> --jobs-dir bench/runs --n-concurrent 1
harbor run --dataset terminal-bench@2.0 --agent terminus-2 \
  --model openrouter/<model-slug> --jobs-dir bench/runs --n-concurrent 1
```

Start with a pilot of 2 or 3 tasks (`--include-task-name <task>`) to measure tokens per trial, then
estimate the full run's cost from it before asking to go ahead.

## Before the first run

- Confirm the OpenRouter slug and provider for Qwen3.6-35B-A3B, and pin the provider so every trial
  hits the same quantization.
- Check `tern_agent.py` against the installed Harbor version. It follows Harbor main at `fc76b3a`
  (25 Nov 2026) and has never run.
- Set `TERN_NODE_VERSION` to an exact Node 24 release.
- Check that the task containers can reach openrouter.ai, and how Harbor passes the key into them.
