// Adds the final grade to a finished run: npm run label -- <log-dir> --passed|--failed [--reward <n>] [--source <name>]
import { parseArgs } from "node:util";
import { labelRun } from "./runlog.ts";

const { values: v, positionals } = parseArgs({
  allowPositionals: true,
  options: { passed: { type: "boolean" }, failed: { type: "boolean" }, reward: { type: "string" }, source: { type: "string" } },
});
if (positionals.length !== 1 || v.passed === v.failed) {
  process.stderr.write("Usage: npm run label -- <log-dir> --passed|--failed [--reward <n>] [--source <name>]\n");
  process.exit(2);
}
const label = labelRun(positionals[0], {
  passed: Boolean(v.passed),
  ...(v.reward !== undefined ? { reward: Number(v.reward) } : {}),
  source: v.source ?? "manual",
});
process.stdout.write(`${JSON.stringify(label)}\n`);
