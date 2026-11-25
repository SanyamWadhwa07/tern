"""Harbor adapter for Tern (Terminal-Bench 2.0). STUB: written, never run.

Not run: Terminal-Bench needs Docker and is too heavy for the development laptop, and every model
call through OpenRouter costs money, so no run happens without an approved cost estimate.

Written against harbor-framework/harbor main at fc76b3a (25 Nov 2026), following its installed
agents (aider.py): install() puts Node in the container, configure() uploads Tern's source, run()
starts the CLI. Tern runs inside the task container, so read, edit and bash act on it directly.
little-coder does the opposite: it runs outside and proxies one shell tool through env.exec.

Launch from the repo root, after the checks in bench/README.md:

    harbor run --dataset terminal-bench@2.0 \
      --agent-import-path bench.tern_agent:TernAgent \
      --model openrouter/<model-slug> \
      --jobs-dir bench/runs --n-concurrent 1
"""
from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

REPO = Path(__file__).resolve().parents[1]
NODE_VERSION = os.environ.get("TERN_NODE_VERSION", "")  # pin an exact 24.x release before the first run
LOG_DIR = "/logs/agent/tern"


class TernAgent(BaseInstalledAgent):
    @staticmethod
    def name() -> str:
        return "tern"

    def version(self) -> str:
        return json.loads((REPO / "package.json").read_text()).get("version", "unknown")

    def get_version_command(self) -> str | None:
        return "node --version"

    async def install(self, environment: BaseEnvironment) -> None:
        if not NODE_VERSION:
            raise ValueError("set TERN_NODE_VERSION to an exact Node 24 release, e.g. the one CI uses")
        await self.ensure_system_dependencies(environment, ("curl", "xz-utils"))
        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail; "
                'arch=$(uname -m); case "$arch" in x86_64) arch=x64;; aarch64) arch=arm64;; esac; '
                f"curl -fsSL https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-$arch.tar.xz | tar -xJ -C /opt; "
                f"ln -sf /opt/node-v{NODE_VERSION}-linux-$arch/bin/node /usr/local/bin/node; node --version"
            ),
        )

    async def configure(self, environment: BaseEnvironment) -> None:
        # Tern has no runtime dependencies: src/ and package.json are the whole install.
        await self.exec_as_root(environment, command="mkdir -p /opt/tern && chmod 755 /opt/tern")
        await environment.upload_dir(REPO / "src", "/opt/tern/src")
        await environment.upload_file(REPO / "package.json", "/opt/tern/package.json")

    @with_prompt_template
    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        if not self.model_name:
            raise ValueError("pass --model openrouter/<model-slug>")
        model = self.model_name.removeprefix("openrouter/")  # OpenRouter's own slug
        await self.exec_as_agent(
            environment,
            command=(
                "node --experimental-strip-types --disable-warning=ExperimentalWarning /opt/tern/src/cli.ts "
                f"--model {shlex.quote(model)} --max-turns 50 --log-dir {LOG_DIR} "
                f"{shlex.quote(instruction)} 2>&1 | tee /logs/agent/tern.txt"
            ),
            env={"OPENROUTER_API_KEY": os.environ.get("OPENROUTER_API_KEY", "")},
        )

    def populate_context_post_run(self, context: AgentContext) -> None:
        # result.json has turns, tokens, cost, repairs and every done claim. Joined later with the
        # verifier's reward to count false-done: an accepted claim on a trial whose tests failed.
        result = self.logs_dir / "tern" / "result.json"
        if not result.exists():
            return
        data = json.loads(result.read_text())
        context.metadata = {
            "tern_version": self.version(),
            "status": data.get("status"),
            "turns": data.get("turns"),
            "usage": data.get("usage"),
            "repairs": data.get("repairs"),
            "bad_calls": data.get("badCalls"),
            "claims": data.get("claims", []),
        }
