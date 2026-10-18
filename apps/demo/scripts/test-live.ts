import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { authenticate } from "../lib/server/auth";
import { getConfig } from "../lib/server/config";
import { runAcceptance } from "../lib/server/acceptance";
import { DemoError, reportError } from "../lib/server/errors";

try {
  const args = process.argv.slice(2);
  if (!(args.length === 1 && args[0] === "--stdin")
    && !(args.length === 2 && args[0] === "--token-file")) {
    throw new DemoError("request", "invalid_arguments", "Use --stdin or --token-file <owner-only-file>. Do not put tokens on the command line.", 400);
  }
  if (args[0] === "--stdin" && process.stdin.isTTY) {
    throw new DemoError("request", "invalid_arguments", "Pipe the assertion through stdin; interactive token entry is not supported.", 400);
  }
  if (existsSync(".env.local")) process.loadEnvFile(resolve(".env.local"));
  if (args[0] === "--token-file" && (statSync(args[1]).mode & 0o077)) {
    throw new DemoError("request", "unsafe_assertion_file", "The assertion file must have owner-only permissions (chmod 600).", 400);
  }
  const assertion = readFileSync(args[0] === "--stdin" ? 0 : args[1], "utf8").trim();
  const config = getConfig();
  const user = await authenticate(`Bearer ${assertion}`, config);
  const checks = await runAcceptance({ user, config, signal: AbortSignal.timeout(300_000) });
  console.log(JSON.stringify({ checks }, null, 2));
} catch (error) {
  const { body } = reportError(error, randomUUID());
  console.error(JSON.stringify(body));
  process.exitCode = 1;
}
