#!/usr/bin/env node
/**
 * ACP live-API probe — resolves Phase 0 questions Q-A / Q-B / Q-D.
 *
 *   Q-A: Does Goose stream via `session/update` notifications, and does
 *        it include `agent_thought_chunk` variants when the model thinks?
 *   Q-B: Is the `session/prompt` final response shape Claude-like (has
 *        `modelUsage` / `total_cost_usd` / `usage.{input,output,cache}`)?
 *   Q-D: Does `session/new` accept/respect a `maxTurns` parameter? If not,
 *        we'll need client-side turn counting + forced cancel.
 *
 * Strategy (cost-aware — user has ~$5 budget):
 *   - ONE prompt. Short system context, terse user message ("pick between A
 *     and B with a one-sentence reason"). Sonnet 4.5. Expected < $0.01.
 *   - Also tests session/new with `maxTurns:1` + observes whether the
 *     returned session object echoes it (cheap — no prompt).
 *   - Dumps EVERY notification + the final prompt response verbatim so we
 *     can reason about the shape offline.
 *
 * Redaction: identical rules to acp-cancel-probe.mjs. API key never
 * prints, never gets written to the report JSON.
 *
 * USAGE:
 *   ANTHROPIC_API_KEY=sk-ant-xxx node scripts/acp-live-probe.mjs
 *   # or with .env:
 *   node --env-file=.env scripts/acp-live-probe.mjs
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BIN = path.resolve("src-tauri/binaries/goose-aarch64-apple-darwin");

// Resolve API key from env OR parse .env manually. Node's built-in
// --env-file has quirks (silent skip on malformed lines, comment
// handling), so for a key as critical as this we parse ourselves.
let API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  try {
    const envText = (await import("node:fs")).readFileSync(".env", "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
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
      "  Or: put ANTHROPIC_API_KEY=... in ./.env (repo root)."
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

const sandbox = mkdtempSync(path.join(tmpdir(), "octopal-live-probe-"));
const CONFIG_HOME = path.join(sandbox, "config");
const DATA_HOME = path.join(sandbox, "data");
const STATE_HOME = path.join(sandbox, "state");
[CONFIG_HOME, DATA_HOME, STATE_HOME].forEach((d) =>
  mkdirSync(d, { recursive: true })
);
mkdirSync(path.join(CONFIG_HOME, "goose"), { recursive: true });
writeFileSync(
  path.join(CONFIG_HOME, "goose", "config.yaml"),
  `GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-6\n`
);

const proc = spawn(BIN, ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    ANTHROPIC_API_KEY: API_KEY,
    GOOSE_PROVIDER: "anthropic",
    GOOSE_MODEL: "claude-sonnet-4-6",
    XDG_CONFIG_HOME: CONFIG_HOME,
    XDG_DATA_HOME: DATA_HOME,
    XDG_STATE_HOME: STATE_HOME,
  },
});

let nextId = 1;
const pending = new Map();
const allMessages = []; // everything, in order, with relative timestamps
const stderrLines = [];
let buf = "";

const t0 = performance.now();
const stamp = () => Math.round(performance.now() - t0);

proc.stdout.setEncoding("utf8");
proc.stdout.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      allMessages.push({ t: stamp(), __raw: line });
      continue;
    }
    allMessages.push({ t: stamp(), ...msg });
    const isResponse = msg.id != null && msg.method == null;
    if (isResponse && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => stderrLines.push(redact(c)));

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timeout ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });
}

async function main() {
  const report = { scenarios: [] };

  // ── Q-D: does session/new accept maxTurns? ─────────────────────
  // Fire once with maxTurns, check response echoes it.
  console.log("── Q-D: session/new with maxTurns ──");
  await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const maxTurnsResp = await request("session/new", {
    cwd: sandbox,
    mcpServers: [],
    maxTurns: 1, // <-- the test
  });
  console.log("session/new w/ maxTurns result keys:",
    Object.keys(maxTurnsResp.result || {})
  );
  console.log("  full result:", JSON.stringify(maxTurnsResp.result, null, 2));
  report.q_d = {
    request_included_maxTurns: true,
    response: maxTurnsResp,
    result_mentions_maxTurns: JSON.stringify(maxTurnsResp.result || {}).includes("maxTurns"),
  };

  const sidA = maxTurnsResp.result?.sessionId;
  console.log(`  sessionId: ${sidA?.slice(0, 8)}...\n`);

  // ── Q-A + Q-B: single prompt, capture full stream + response ──
  console.log("── Q-A + Q-B: fire prompt, capture stream + final response ──");
  const promptStart = performance.now();
  const updatesBefore = allMessages.filter((m) => m.method === "session/update").length;

  const promptResp = await request(
    "session/prompt",
    {
      sessionId: sidA,
      prompt: [
        {
          type: "text",
          text:
            "Pick between cats and dogs. Give one sentence. Do not use any tools.",
        },
      ],
    },
    60000
  );
  const promptMs = Math.round(performance.now() - promptStart);
  const updatesAfter = allMessages.filter((m) => m.method === "session/update").length;
  console.log(`  prompt resolved in ${promptMs}ms`);
  console.log(`  session/update notifications during prompt: ${updatesAfter - updatesBefore}`);
  console.log(`  final response keys:`, Object.keys(promptResp.result || {}));
  console.log(`  full response:`, JSON.stringify(promptResp.result, null, 2));

  // Classify session/update variants we saw during this prompt.
  const promptUpdates = allMessages
    .filter(
      (m) =>
        m.method === "session/update" &&
        m.params?.sessionId === sidA
    )
    .slice(updatesBefore); // everything since prompt start

  const variantCounts = {};
  const sampleByVariant = {};
  for (const u of promptUpdates) {
    const inner = u.params?.update || u.params;
    const v = inner?.sessionUpdate || "<no-discriminator>";
    variantCounts[v] = (variantCounts[v] || 0) + 1;
    if (!sampleByVariant[v]) sampleByVariant[v] = inner;
  }

  report.q_a_b = {
    prompt_duration_ms: promptMs,
    update_count: promptUpdates.length,
    variant_counts: variantCounts,
    variant_samples: sampleByVariant,
    prompt_response: promptResp,
  };

  console.log("  variant counts:", variantCounts);
  console.log("\n═══════════════ SUMMARY ═══════════════\n");
  console.log(JSON.stringify(report, null, 2));

  const outPath = path.join(sandbox, "live-probe-report.json");
  writeFileSync(
    outPath,
    redact(
      JSON.stringify({ report, all_messages: allMessages, stderr_tail: stderrLines.slice(-20) }, null, 2)
    )
  );
  console.log(`\nFull redacted report: ${outPath}`);

  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
}

main().catch((e) => {
  console.error(redact(e.message || String(e)));
  proc.kill();
  process.exit(1);
});
