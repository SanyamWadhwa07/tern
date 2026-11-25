# Changelog

All notable changes are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-26

### Added

- The harness core: the agent loop with four tools: `read` (lines tagged with a line
  number and a 2-character hash), `edit` (replace or insert by those tags, or write a whole file),
  `bash` (time limit, process tree killed) and `done`.
- System prompt and tool schemas: 696 tokens together (with the notes-file line), counted with
  `o200k_base` in a test.
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
- Budget guard: `--time-limit` and `--token-limit` give the model a note at 75% and 90% and stop
  the run at 100% with its logs written; the same call with the same result warns at the 3rd
  repeat and stops the run at the 6th. Notes and stops are logged as `guard` records.
- `docs/BASELINES.md`: the 24.6% Terminal-Bench 2.0 baseline and its setup, confirmed on the live
  board, and a check of the edit-format claim.
- `bench/`: a Harbor adapter stub and the benchmark plan. Not run.
- Scratchpad instead of lossy compaction: past 70% of `--context-limit` the oldest tool outputs
  become one-line placeholders (the newest 6 stay whole), and the agent's notes file is shown
  again. The full outputs stay in `trajectory.jsonl`.
- The Harbor adapter passes `TERN_TIME_LIMIT`, `TERN_TOKEN_LIMIT` and `TERN_CONTEXT_LIMIT` through.

### Fixed

Found by an independent review before release, each with a regression test:

- Ctrl-C was ignored unless it landed during a model request. It now stops the client, retry
  waits, running commands and checks, and the loop between turns.
- Files that checks write into a protected folder (`__pycache__`, logs) made the next done claim
  fail as tampering. Caches are no longer guarded, and the gate cleans up after its own checks.
- A command that left a background process holding the output pipes could hang `bash`. The
  command now ends when its shell exits.
- Calls after an accepted `done` in the same reply got no tool message, which made
  `messages.json` invalid chat format.
- Whole tool calls with empty ids and no index were merged into one.
- JSON in ordinary text with a `name` key was read as a tool call, and a fence inside an edit's
  text broke parsing when the arguments had a trailing comma.
- Non-ASCII output split across two chunks was garbled.
- Context trimming undercounted escaped characters and trimmed more than needed.
