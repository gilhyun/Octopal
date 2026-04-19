#!/usr/bin/env node
/**
 * ACP SIGTERM timing probe (Phase 2 Q-C resolution).
 *
 * Measures how fast Goose v1.31.0 actually stops after a process-level
 * SIGTERM mid-turn. This data sets the grace timeout before SIGKILL in
 * `AcpClient::shutdown()` (ADR §6.7). `session/cancel` does NOT exist
 * (method probe confirmed -32601), so SIGTERM is the only cancel lever
 * we have.
 *
 * Three scenarios:
 *   S1 — SIGTERM during text streaming (easy case, no tool)
 *   S2 — SIGTERM during tool_use (hardest — shell subprocess attached)
 *   S3 — SIGTERM before first chunk (race — cancel arrives before
 *        Anthropic returns the first token)
 *
 * Metrics per scenario:
 *   sigterm_to_stdout_close_ms — time from kill() to stdout EOF
 *   sigterm_to_exit_ms         — time from kill() to full process exit
 *   post_sigterm_stdout_bytes  — bytes Goose emitted AFTER SIGTERM
 *   post_sigterm_updates       — session/update count AFTER SIGTERM
 *   stop_reason                — best-effort description of exit path
 *
 * Budget: ~$0.005 per run (3 short prompts, each cut short).
 *
 * USAGE:
 *   node scripts/acp-cancel-probe.mjs
 *   (reads ANTHROPIC_API_KEY from env or ./.env)
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BIN = path.resolve("src-tauri/binaries/goose-aarch64-apple-darwin");
const MODEL = "claude-sonnet-4-6"; // dash form — dot-alias 404s (ADR §6.8)

// Resolve API key — env first, then .env parsed ourselves (Node's
// --env-file has quirks with `##` comments and silent line skipping).
let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  try {
    const envText = readFileSync(".env", "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (k === "ANTHROPIC_API_KEY") {
        API_KEY = v;
        break;
      }
    }
  } catch {
    /* .env missing — handled below */
  }
}
if (!API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY not set.\n" +
      "  Either: export ANTHROPIC_API_KEY=sk-ant-...\n" +
      "  Or: put ANTHROPIC_API_KEY=... in ./.env (repo root).",
  );
  process.exit(1);
}

const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  new RegExp(API_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
];
const redact = (s) => {
  let out = String(s);
  for (const re of KEY_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
};

const sandbox = mkdtempSync(path.join(tmpdir(), "octopal-sigterm-probe-"));
const CONFIG_HOME = path.join(sandbox, "config");
const DATA_HOME = path.join(sandbox, "data");
const STATE_HOME = path.join(sandbox, "state");
[CONFIG_HOME, DATA_HOME, STATE_HOME].forEach((d) =>
  mkdirSync(d, { recursive: true }),
);
mkdirSync(path.join(CONFIG_HOME, "goose"), { recursive: true });
writeFileSync(
  path.join(CONFIG_HOME, "goose", "config.yaml"),
  `GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: ${MODEL}\n`,
);

class AcpClient {
  constructor(bin, env) {
    this.proc = spawn(bin, ["acp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = [];
    this.buf = "";
    this.stdoutBytes = 0;
    this.stdoutBytesAtKill = null;
    this.killedAt = null;
    this.stdoutEndedAt = null;
    this.exitedAt = null;
    this.exitCode = null;
    this.exitSignal = null;

    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => {
      this.stdoutBytes += Buffer.byteLength(chunk);
      this.buf += chunk;
      let nl;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, nl).trim();
        this.buf = this.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          this.notifications.push({ __raw: line, __t: performance.now() });
          continue;
        }
        const stamped = { ...msg, __t: performance.now() };
        const isResponse = msg.id != null && msg.method == null;
        if (isResponse && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(stamped);
          this.pending.delete(msg.id);
        }
        this.notifications.push(stamped);
      }
    });
    this.proc.stdout.on("end", () => {
      this.stdoutEndedAt = performance.now();
    });
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (c) => this.stderr.push(redact(c)));
    this.proc.on("exit", (code, signal) => {
      this.exitedAt = performance.now();
      this.exitCode = code;
      this.exitSignal = signal;
    });
  }

  request(method, params, timeoutMs = 30000) {
    const id = this.nextId++;
    const msg = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  sigterm() {
    this.killedAt = performance.now();
    this.stdoutBytesAtKill = this.stdoutBytes;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
  }

  sigkill() {
    try {
      this.proc.kill("SIGKILL");
    } catch {}
  }

  sessionUpdates() {
    return this.notifications.filter((n) => n.method === "session/update");
  }

  async waitForExit(graceMs) {
    const start = performance.now();
    while (this.exitedAt == null && performance.now() - start < graceMs) {
      await new Promise((r) => setTimeout(r, 25));
    }
    return this.exitedAt != null;
  }
}

async function scenario(name, promptText, triggerAfterMs, killBudgetMs) {
  console.log(`\n══════ ${name} ══════`);
  const client = new AcpClient(BIN, {
    ANTHROPIC_API_KEY: API_KEY,
    GOOSE_PROVIDER: "anthropic",
    GOOSE_MODEL: MODEL,
    XDG_CONFIG_HOME: CONFIG_HOME,
    XDG_DATA_HOME: DATA_HOME,
    XDG_STATE_HOME: STATE_HOME,
  });

  const result = { scenario: name };
  try {
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const sess = await client.request("session/new", {
      cwd: sandbox,
      mcpServers: [],
    });
    const sid = sess.result?.sessionId;
    if (!sid) throw new Error("no sessionId");
    console.log(`  session ready: ${sid.slice(0, 8)}...`);

    // Fire prompt but don't await.
    const promptFired = performance.now();
    const promptPromise = client
      .request(
        "session/prompt",
        {
          sessionId: sid,
          prompt: [{ type: "text", text: promptText }],
        },
        60000,
      )
      .catch((e) => ({ __promptError: e.message }));

    if (triggerAfterMs > 0) {
      await new Promise((r) => setTimeout(r, triggerAfterMs));
    }

    const updatesAtKill = client.sessionUpdates().length;
    console.log(
      `  SIGTERM at +${Math.round(performance.now() - promptFired)}ms, ${updatesAtKill} updates seen`,
    );
    client.sigterm();

    const exited = await client.waitForExit(killBudgetMs);
    if (!exited) {
      console.log(`  did NOT exit after ${killBudgetMs}ms — sending SIGKILL`);
      client.sigkill();
      await client.waitForExit(2000);
    }

    const updatesAfter = client.sessionUpdates().length - updatesAtKill;
    result.sigterm_to_stdout_close_ms =
      client.stdoutEndedAt != null
        ? Math.round(client.stdoutEndedAt - client.killedAt)
        : null;
    result.sigterm_to_exit_ms =
      client.exitedAt != null
        ? Math.round(client.exitedAt - client.killedAt)
        : null;
    result.post_sigterm_stdout_bytes =
      client.stdoutBytes - client.stdoutBytesAtKill;
    result.post_sigterm_updates = updatesAfter;
    result.exit_code = client.exitCode;
    result.exit_signal = client.exitSignal;
    result.stop_reason = !exited
      ? "sigkill_fallback"
      : client.exitSignal === "SIGTERM"
        ? "sigterm_clean"
        : `exit_code=${client.exitCode}`;

    // Race: did the prompt resolve before process died?
    const promptOutcome = await Promise.race([
      promptPromise,
      new Promise((r) => setTimeout(() => r({ __still_pending: true }), 100)),
    ]);
    result.prompt_outcome = promptOutcome.__still_pending
      ? "pending_at_death"
      : promptOutcome.__promptError
        ? `error:${promptOutcome.__promptError}`
        : promptOutcome.result
          ? "result_ok"
          : "unknown";

    console.log(
      `  exit=${result.stop_reason}, stdout_close=+${result.sigterm_to_stdout_close_ms}ms, post-bytes=${result.post_sigterm_stdout_bytes}, post-updates=${result.post_sigterm_updates}`,
    );
  } catch (e) {
    result.error = redact(e.message);
    console.log(`  error: ${result.error}`);
  } finally {
    // Belt-and-suspenders; if still alive, SIGKILL.
    client.sigkill();
    await new Promise((r) => setTimeout(r, 200));
  }
  return result;
}

const report = [];

// S1: text streaming (no tool, model generates for a while)
report.push(
  await scenario(
    "S1_text_streaming",
    "Count from 1 to 60 with one number per line, slowly with a word of commentary on each. Do NOT use any tools.",
    2500, // trigger after ~2.5s of streaming
    10000, // allow up to 10s for process to die
  ),
);

// S2: tool_use (shell subprocess attached)
report.push(
  await scenario(
    "S2_tool_use",
    "Use the developer shell tool to run `ls -la /tmp | head -50`, then describe each line in detail.",
    3000,
    10000,
  ),
);

// S3: race (SIGTERM before first chunk)
report.push(
  await scenario(
    "S3_before_first_chunk",
    "Say hello.",
    0, // no delay — immediate
    10000,
  ),
);

const summary = {
  binary: BIN,
  model: MODEL,
  sandbox_root: sandbox,
  scenarios: report,
};

console.log("\n\n═══════════════ SUMMARY ═══════════════");
console.log(JSON.stringify(summary, null, 2));

const outPath = path.join(sandbox, "sigterm-probe-report.json");
writeFileSync(outPath, redact(JSON.stringify(summary, null, 2)));
console.log(`\nFull redacted report: ${outPath}`);

process.exit(0);
