// npm run eval -- [--braintrust] [--reply=<id>] [--extract=<id>] [--derive=<id>] [--effort=low|medium|high] [--no-memory] [--retrieval=cosine|hybrid] [--filter=<regex>]
// Plain Node (type stripping): flags → EVAL_* env → vitest (or the Braintrust CLI), exit code passed through.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const FLAGS: Record<string, string> = { reply: "EVAL_REPLY", extract: "EVAL_EXTRACT", derive: "EVAL_DERIVE", effort: "EVAL_EFFORT", retrieval: "EVAL_RETRIEVAL", filter: "EVAL_FILTER" };
let braintrust = false;

for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.+)$/.exec(arg);
  if (arg === "--no-memory") process.env.EVAL_MEMORY = "0";
  else if (arg === "--braintrust") braintrust = true;
  else if (m && FLAGS[m[1]]) process.env[FLAGS[m[1]]] = m[2];
  else {
    console.error(`unknown flag ${arg}; use --braintrust --reply= --extract= --derive= --effort= --no-memory --retrieval= --filter=`);
    process.exit(2);
  }
}
if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars"); // never overrides variables already set

let args = ["vitest", "run", "evals", "--reporter=verbose", "--testTimeout=1200000"];
if (braintrust) {
  // The Braintrust CLI bundles the TypeScript itself. Without a key the run still happens and prints its summary; it just uploads nothing.
  if (existsSync(".env.braintrust")) process.loadEnvFile(".env.braintrust");
  const keyed = !!process.env.BRAINTRUST_API_KEY?.trim();
  if (!keyed) console.error("no BRAINTRUST_API_KEY in the environment or .env.braintrust: running locally, nothing is uploaded (see SETUP.md section 8)");
  // --terminate-on-failure: a module-load or bundling error is otherwise downgraded to a warning and exit 0.
  args = ["braintrust", "eval", "evals/braintrust.eval.ts", "--terminate-on-failure", ...(keyed ? [] : ["--no-send-logs"])];
}
const child = spawn("npx", args, { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
