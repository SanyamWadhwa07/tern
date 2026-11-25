# Security policy

## What the agent can do

Tern gives a language model a shell. Treat a run like running untrusted code:

- `bash` runs any command the model writes, as your user, in the working directory. There is no
  command filter. Run Tern inside a container or a throwaway VM, as Terminal-Bench does, not on a
  machine with data you care about.
- `read` and `edit` accept any path the process can reach, not only the working directory.
- Protected paths stop the agent from changing tests by accident or on purpose: `edit` refuses
  them, and changes made through `bash` are undone after each command. This is a guard for honest
  scoring, not a sandbox. A determined command can still reach outside it, for example by running a
  background process that writes after the check.

## What it sends where

- Your task, the files the agent reads and the command output go to the model endpoint you
  configure (OpenRouter by default). Do not point it at code you may not share with that provider.
- The API key comes from `TERN_API_KEY` or `OPENROUTER_API_KEY` and is sent only to that endpoint.
- Run logs (`trajectory.jsonl`, `claims.jsonl`, `result.json`) are written to `~/.tern/runs/` or
  `--log-dir` and contain everything the model saw, including file contents.

## Supported versions

The latest release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/SanyamWadhwa07/tern/security/advisories/new).
You will get an acknowledgement within three days.
