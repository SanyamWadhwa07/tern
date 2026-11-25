# Baselines

Checked on 26 November 2026 against the live leaderboard and the little-coder repository. Every
number here is copied from a source linked next to it. Numbers Tern has not measured yet are marked
"not measured yet".

## The number to beat: 24.6%

Leaderboard row ([tbench.ai, Terminal-Bench 2.0 view](https://www.tbench.ai/leaderboard/terminal-bench/2.0),
which now redirects to `tbench.ai/?version=2.0`):

| Rank | Model | Agent | Resolution rate | Date on board |
|---|---|---|---|---|
| 112 | Qwen3.6-35B-A3B | little-coder | 24.6% ± 3.2 (95% CI) | Apr 16, 2026 |

It is the best row on the 2.0 board for a model of 35B or smaller (see the next table).

How little-coder got it, from its own repo
([README](https://github.com/itayinbarr/little-coder#benchmarks),
[CHANGELOG, PR #158 entry and v0.1.17](https://github.com/itayinbarr/little-coder/blob/main/CHANGELOG.md),
[Harbor adapter](https://github.com/itayinbarr/little-coder/tree/main/benchmarks/harbor_adapter)):

| Setting | Value | Source |
|---|---|---|
| Model file | Qwen3.6-35B-A3B, `UD-Q4_K_M` GGUF from unsloth, about 22 GB | CHANGELOG, README |
| Serving | llama.cpp `llama-server` on one RTX 5070 Laptop GPU with 8 GB VRAM, experts kept in CPU RAM (`--n-cpu-moe 999`), no cloud inference | CHANGELOG |
| Context window | not stated for the run; the README's example server uses `-c 16384` | README |
| Trials | 89 tasks × 5 trials = 445 | CHANGELOG |
| Raw result submitted | 106 / 445 = 23.82% | CHANGELOG (PR #158) |
| Board result | 24.6% ± 3.2, after the board recomputed across the five trials | CHANGELOG v0.1.17 |
| Time limits | `timeout_multiplier=1.0`, no overrides, so each task's own limits | CHANGELOG |
| Errored trials | 15 / 445: Docker image-pull timeouts, `AgentTimeoutError` at 1200 or 1800 s, `VerifierTimeoutError` at 900 s, all counted as failed | CHANGELOG |
| Harness version in the trials | `agent_info.version = "0.1.13"` | CHANGELOG |
| Sampling | temperature 0.2, thinking budget 3000, max 40 turns, max 4096 output tokens per call | [`.pi/settings.json`](https://github.com/itayinbarr/little-coder/blob/main/.pi/settings.json) on `main` today, not checked at the 0.1.13 tag |
| Where the agent runs | outside the container: a Harbor `BaseAgent` proxies one shell tool through `env.exec`; no file tools in benchmark mode | Harbor adapter |
| Concurrency | `--n-concurrent 1` | `benchmarks/harbor_pilot.sh` |
| Submission | [HF dataset `harborframework/terminal-bench-2-leaderboard`, discussion #158](https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/discussions/158) | CHANGELOG |

Two small mismatches to know about:

- little-coder's README says rank 120. The board shows rank 112 today. Ranks move as rows are
  added, so cite the score, not the rank.
- The README calls it 24.6%; the raw count is 23.82%. Tern should report both its raw count and the
  board's interval form.

## Other rows of 35B or smaller on the 2.0 board

All 137 ranks were read. These are the rows whose model is open-weight and 35B or smaller by name:

| Rank | Model | Agent | Resolution rate |
|---|---|---|---|
| 112 | Qwen3.6-35B-A3B | little-coder | 24.6% ± 3.2 |
| 120 | TermiGen-32B | Bash Agent | 19.3% ± 2.0 |
| 123 | AfterQuery-GPT-OSS-20B | Terminus 2 | 17.0% ± 2.5 |
| 133 | Qwen3.5-9B | little-coder | 9.2% ± 2.4 |
| 136 | GPT-OSS-20B | Mini-SWE-Agent | 3.4% ± 1.4 |
| 137 | GPT-OSS-20B | Terminus 2 | 3.1% ± 1.5 |

There is no Terminus 2 or OpenCode row for Qwen3.6-35B-A3B. Tern's comparison runs on the same model
have to produce those numbers themselves: not measured yet.

## Same model, different harness

These rows are the evidence that the harness alone moves the score (all from the 2.0 board):

| Model | Harness | Rank | Resolution rate |
|---|---|---|---|
| Claude Opus 4.6 | Meta-Harness | 10 | 76.4% ± 2.4 |
| Claude Opus 4.6 | Terminus-KIRA | 16 | 74.7% ± 2.6 |
| Claude Opus 4.6 | Terminus 2 | 34 | 62.9% ± 2.7 |
| Claude Opus 4.6 | Claude Code | 47 | 58.0% ± 2.9 |
| Claude Opus 4.5 | Terminus 2 | 48 | 57.8% ± 2.5 |
| Claude Opus 4.5 | Claude Code | 58 | 52.1% ± 2.5 |
| Qwen 3 Coder 480B | Dakou Agent | 105 | 27.2% ± 2.6 |
| Qwen 3 Coder 480B | OpenHands | 110 | 25.4% ± 2.6 |
| Qwen 3 Coder 480B | Terminus 2 | 115 | 23.9% ± 2.8 |

Meta-Harness vs Claude Code on Opus 4.6 is 18.4 points, confirmed.

## The board has moved on

- `tbench.ai/leaderboard` now opens on **Terminal-Bench 4.1**, not 2.0. The 2.0 table is still
  served at `?version=2.0`.
- The 4.1 table has **TOKENS and COST columns** (for example $2.0k for the top row). So "first to
  report cost" is no longer true at the board level. What no board reports is **cost per solved
  task** and the **false-done rate**. Tern should claim those two, not cost in general.
- Neither page says whether 2.0 still accepts submissions. little-coder's 2.0 rows went in through
  pull requests on the Hugging Face dataset above, checked by a bot and merged by a maintainer.
- Before the evaluation phase, decide whether Tern targets 2.0 (where the 24.6 baseline and its
  trajectories exist) or 4.1 (current, but no little-coder row). This file assumes 2.0.

## Edit formats: the "harness problem" post

[blog.can.ac/2026/02/12/the-harness-problem](https://blog.can.ac/2026/02/12/the-harness-problem/)
redirects to [stencil.so/blog/the-harness-problem](https://stencil.so/blog/the-harness-problem).
Can Bölük, 12 February 2026. Code and per-run reports:
[can1357/omp, `packages/react-edit-benchmark`](https://github.com/can1357/omp/tree/main/packages/react-edit-benchmark).

What it measured:

- **Benchmark:** its own, not Terminal-Bench. Take a random file from the React codebase, plant a
  mechanical bug (operator swap, boolean flip, off-by-one, removed guard), describe it in English,
  and check whether the agent restores the file.
- **Size:** 180 tasks × 3 runs per model and format, fresh session each time, with read, edit and
  write tools.
- **Formats:** `apply_patch` (Codex style), `str_replace` (Claude Code style), and "hashline": every
  line comes back from `read` tagged with a 2 to 3 character hash, and edits name those tags.
- **Models:** 16, mostly hosted (Grok, MiniMax, GLM, Claude, Gemini, GPT, Kimi, DeepSeek, Qwen
  Turbo, Devstral Medium).

What it found:

- Against `apply_patch`, hashline gains a lot: +15 points averaged over 16 models, and Grok Code Fast
  1 goes from 6.7% to 68.3%. Most of that is patch failures (Grok 4 failed 50.7% of patches, GLM-4.7
  46.2%).
- Against `str_replace`, the gain is small. From the post's own per-model table, the change over
  replace ranges from −8.3 (DeepSeek V3.2) to +11.3 (Claude Haiku 4.5, Gemini 3 Flash): mean +3.4,
  median +3.6, better for 11 of 16 models, worse for 4.
- The "5 to 14 points" line in the post is about the vendors' own models, not an average.
- The two open-weight rows nearest Tern's size class barely move against replace: GLM-4.5 Air +0.4,
  Qwen Turbo −1.7.

What this means for Tern:

- The "5 to 14 points from the edit format alone" claim is **not confirmed for Terminal-Bench** and
  **not confirmed for open-weight models of 35B or smaller**. The large gains are over patch
  formats, which Tern would not use anyway.
- Tern still uses line anchors, for two reasons the post does support: the model never has to
  reproduce old text exactly, and an edit on a stale view is rejected before it corrupts a file.
- It has to be measured: an ablation of anchored edits against `str_replace` on the same model and
  the same TB2.0 tasks. Result: not measured yet.
