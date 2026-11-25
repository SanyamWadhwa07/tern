# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Milestone 1, the harness core. The agent loop with four tools: `read` (lines tagged with a line
  number and a 2-character hash), `edit` (replace or insert by those tags, or write a whole file),
  `bash` (time limit, process tree killed) and `done`.
- System prompt and tool schemas: 638 tokens together, counted with `o200k_base` in a test.
- Streaming client for any OpenAI-compatible endpoint, OpenRouter by default: tool calls in
  fragments, usage and cost, retries on 429, 5xx and dropped connections, a stall timeout.
- Tool-call repair: markdown fences, trailing commas, double-encoded JSON, calls written as
  Qwen3-Coder XML, `<invoke>` XML, `<tool_call>` JSON or bare JSON, and wrong tool or argument
  names. Every fix is named in the run log.
- Verify gate: protected paths are read-only (refused by `edit`, restored after `bash`), `done` is
  accepted only when every check exits 0, and every claim is logged to `claims.jsonl`.
- A scripted fake model that streams real SSE, so the whole loop runs offline in `npm test`.
- `npm run tern` command line. Each run writes a training-ready log (`tern-trajectory/1`):
  `trajectory.jsonl` with raw and repaired calls, tool results, claims and token counts,
  `messages.json` in OpenAI chat format, `claims.jsonl` and `result.json`.
- `npm run label` adds the final grade to a finished run and marks it false-done when an accepted
  claim meets a failed grade.
- `docs/BASELINES.md`: the 24.6% Terminal-Bench 2.0 baseline and its setup, confirmed on the live
  board, and a check of the edit-format claim.
- `bench/`: a Harbor adapter stub and the benchmark plan. Not run.
