// npm run eval -- [--reply=<id>] [--extract=<id>] [--derive=<id>] [--effort=low|medium|high] [--no-memory] [--retrieval=cosine|hybrid] [--filter=<regex>]
// Plain Node (type stripping): flags → EVAL_* env → vitest, exit code passed through.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const FLAGS: Record<string, string> = { reply: "EVAL_REPLY", extract: "EVAL_EXTRACT", derive: "EVAL_DERIVE", effort: "EVAL_EFFORT", retrieval: "EVAL_RETRIEVAL", filter: "EVAL_FILTER" };

for (const arg of process.argv.slice(2)) {
  const m = /^--([a-z]+)=(.+)$/.exec(arg);
  if (arg === "--no-memory") process.env.EVAL_MEMORY = "0";
  else if (m && FLAGS[m[1]]) process.env[FLAGS[m[1]]] = m[2];
  else {
    console.error(`unknown flag ${arg}; use --reply= --extract= --derive= --effort= --no-memory --retrieval= --filter=`);
    process.exit(2);
  }
}
if (existsSync(".dev.vars")) process.loadEnvFile(".dev.vars"); // never overrides variables already set

const child = spawn("npx", ["vitest", "run", "evals", "--reporter=verbose", "--testTimeout=1200000"], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 1));
