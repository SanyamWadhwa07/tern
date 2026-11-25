<h1 align="center">Tern</h1>

<p align="center">
  <strong>A terminal coding agent built for small open models.</strong><br>
  Four tools, 696 tokens before the task, and a gate that checks every "done".
</p>

<p align="center">
  <a href="#run-it">Run it</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#results">Results</a> ·
  <a href="docs/BASELINES.md">Baselines</a>
</p>

<p align="center">
  <a href="https://github.com/SanyamWadhwa07/tern/actions/workflows/test.yml"><img src="https://github.com/SanyamWadhwa07/tern/actions/workflows/test.yml/badge.svg" alt="tests"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-000000" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-22.16%2B,_no_build_step-000000" alt="Node 22.16+, no build step">
  <img src="https://img.shields.io/badge/runtime_dependencies-0-000000" alt="no runtime dependencies">
</p>

Coding agents are built and tuned for frontier models. Open-weight models of 35B or smaller lose
points to the harness itself: long system prompts, tool calls in a format the model fumbles, edits
that need old text retyped exactly, and "done" taken on the model's word.

Tern's goal is to beat the best published Terminal-Bench 2.0 score for that size class, **24.6%**
(little-coder with Qwen3.6-35B-A3B, [confirmed here](docs/BASELINES.md)), and to report two numbers
no leaderboard shows: **cost per solved task** and **false-done rate**, the share of runs where the
agent says it finished but the hidden tests fail.

**Status:** version 0.1.0. All six planned parts of the harness are built: the small core, call
repair, anchored edits, the verify gate, the budget guard and the scratchpad. Each is tested end to
end offline, against a scripted model, in `npm test`. No benchmark has been run yet.

## Run it

Needs Node.js 22.16 or newer. There is no build step and no runtime dependency.

```bash
npm install
npm test                 # 72 tests, scripted model, no keys, no network
```

Against a real model, any OpenAI-compatible endpoint works. OpenRouter is the default; a paid
endpoint costs money per call.

```bash
export OPENROUTER_API_KEY=...
npm run tern -- --model <openrouter-model-slug> \
  --check "npm test" --protect test/ \
  "Fix the failing date parser in src/dates.ts"
```

For a local server, pass `--base-url http://localhost:8080/v1` and no key.

Each run writes its log to `~/.tern/runs/<time>` (or `--log-dir`) in a training-ready format:
every reply with the model's raw output next to the repaired calls, every tool result, every
"done" claim with its checks, and the conversation in OpenAI chat format. The final grade is added
afterwards with `npm run label -- <log-dir> --passed|--failed`. Details:
[docs/TRAJECTORIES.md](docs/TRAJECTORIES.md).

## How it works

<img src="docs/assets/architecture.svg" alt="The task goes to the model; its tool calls pass a repair layer, then run as read, edit or bash; a done call goes to the verify gate, which restores protected files and runs the checks; results and verdicts go back to the model until a claim is accepted" width="100%">

- **A small prompt.** The system prompt is 350 tokens (with the notes-file line the CLI adds) and
  the four tool schemas 346, so 696 before the task (counted with `o200k_base` in a test; Qwen's
  own tokenizer is not measured yet).
- **Calls are repaired in code.** JSON in markdown fences, trailing commas, calls written into the
  text as Qwen3-Coder `<function=...>` XML, `<invoke>` XML or `<tool_call>` JSON, and wrong tool
  or argument names (`cmd` for `command`, `read_file` for `read`) are fixed without asking the
  model again. Each fix is named in the log, so a run can count them. The history keeps the
  repaired form, so the model sees well-formed calls.
- **Edits name lines, not text.** `read` shows each line as `12:a3|text`, a line number and a
  2-character hash. `edit` replaces or inserts by those tags, so the model never retypes old code,
  and an edit against a stale view is rejected with the current lines. Whether this format alone
  adds points on Terminal-Bench is [not confirmed](docs/BASELINES.md#edit-formats-the-harness-problem-post);
  Tern will measure it against `str_replace`.
- **"Done" is a claim, checked.** A `done` call runs the task's checks. If one fails, the model
  gets the output and keeps working. Every claim is logged with its checks, accepted or not.
- **Tests are read-only.** Protected paths are snapshotted at the start. `edit` refuses them, and
  any `bash` command that changes them is undone right after it runs, with a note to the model.
- **A budget the model can see.** With `--time-limit` or `--token-limit`, the model gets a note at
  75% and at 90% of the limit (attached to the last tool result), and the run stops at 100% with
  its logs written. The same call giving the same result 3 times gets a "try something else" note;
  6 times stops the run as a loop. The same command with a new result counts as progress.
- **A scratchpad, not compaction.** The agent keeps its plan and findings in a notes file, with
  `edit`. Past 70% of `--context-limit`, the oldest tool outputs become one-line placeholders
  (the newest 6 stay whole) and the notes are shown again. No model rewrites the history, so
  nothing is lost silently, and the full outputs stay in the run log.

## Results

Terminal-Bench 2.0, 89 tasks × 5 trials, same model for every harness. Plan and adapter:
[`bench/`](bench/README.md).

| Harness | Resolution rate | Cost per solved task | False-done rate |
|---|---|---|---|
| Tern | not measured yet | not measured yet | not measured yet |
| Terminus 2 | not measured yet | not measured yet | not measured yet |
| OpenCode | not measured yet | not measured yet | not measured yet |
| little-coder | 24.6% ± 3.2 on its own local run ([source](docs/BASELINES.md)) | not reported | not reported |

## What is tested

`npm test` runs on Linux, macOS and Windows in CI, with no keys and no network:

- the whole loop on a toy bug fix: a premature "done" is rejected with the failing check's output,
  an edit to the test is refused, a shell command that empties the test is undone, the fix arrives
  as Qwen3-Coder XML and is repaired, and the second claim is accepted
- 15 repair-layer cases: fences, trailing commas, XML and JSON calls in the text, wrong names and types
- anchored reads and edits, stale anchors, Windows line endings
- the streaming client: fragmented tool calls, usage and cost, retries on 429 and 5xx, a stalled
  stream, an error inside the stream
- the run log on disk: the real CLI against a scripted model over local HTTP, then a final label
  that marks the run false-done
- the budget guard: notes at 75% and 90% of a time or token limit, the stop at 100%, and a loop
  stopped at its 6th repeat, both alone and inside the full loop
- the scratchpad: oldest outputs trimmed first, the newest 6 kept, and the agent's notes shown
  again after a trim while the full outputs stay in the log
- one regression test for each of the 8 bugs an independent review found (interrupts, checks
  that write into test folders, background servers, split UTF-8 output, and others)
- the prompt budget, and the CLI's refusal to start without a task, a model or a key

## Next

1. Pilot runs on 2 or 3 Terminal-Bench tasks to measure tokens per trial and estimate the full cost.
2. Full runs against Terminus 2, little-coder and OpenCode on the same model, with ablations for
   each part (repair layer, anchored edits, verify gate, budget guard, scratchpad).
3. Long-term memory across tasks through Vouch, a separate project.
4. From the run logs: a LoRA fine-tune of a small open model on verified successful trajectories,
   and a model that predicts false "done" claims before the checks run.

## Name

The npm name `tern` belongs to the [Tern JavaScript analyzer](https://www.npmjs.com/package/tern),
so this package is `tern-agent`.

## License

[MIT](LICENSE)
