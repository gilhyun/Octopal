#!/usr/bin/env node
/**
 * ACP method existence probe — no API credits required.
 *
 * Goose v1.31.0's `session/cancel` returns -32601 (Method not found), even
 * though the ACP spec lists it. We need to find what Goose actually uses
 * for cancellation/termination so Phase 2's Stop-button + dispatcher
 * timeout plumbing can target a real method.
 *
 * This probe:
 *   1. Runs initialize + session/new (establishes a valid sessionId)
 *   2. Fires each candidate method in isolation, captures the error/result
 *   3. Tags each method as either:
 *        - "exists (ok)"       → returned a non-error result
 *        - "exists (param err)" → returned -32602 Invalid params (method exists, we called it wrong)
 *        - "missing"            → returned -32601 Method not found
 *        - other                → raw error code surfaced
 *
 * Baseline control: one deliberately fake method ("session/__nope__") to
 * confirm -32601 is indeed what "missing" looks like in this agent.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const BIN = path.resolve(
  "src-tauri/binaries/goose-aarch64-apple-darwin"
);

// Sandbox XDG dirs so we don't touch any global goose config.
const sandbox = mkdtempSync(path.join(tmpdir(), "octopal-method-probe-"));
const CONFIG_HOME = path.join(sandbox, "config");
const DATA_HOME = path.join(sandbox, "data");
const STATE_HOME = path.join(sandbox, "state");
[CONFIG_HOME, DATA_HOME, STATE_HOME].forEach((d) =>
  mkdirSync(d, { recursive: true })
);
mkdirSync(path.join(CONFIG_HOME, "goose"), { recursive: true });
// Minimal config so goose acp doesn't prompt interactively. Provider is
// irrelevant — we never send a session/prompt.
writeFileSync(
  path.join(CONFIG_HOME, "goose", "config.yaml"),
  `GOOSE_PROVIDER: anthropic\nGOOSE_MODEL: claude-sonnet-4-5\n`
);

const proc = spawn(BIN, ["acp"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    XDG_CONFIG_HOME: CONFIG_HOME,
    XDG_DATA_HOME: DATA_HOME,
    XDG_STATE_HOME: STATE_HOME,
    // Dummy key — won't be used since we never prompt.
    ANTHROPIC_API_KEY: "sk-ant-probe-dummy",
  },
});

let nextId = 1;
const pending = new Map();
const notifications = [];
let buf = "";

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
      continue;
    }
    const isResponse = msg.id != null && msg.method == null;
    if (isResponse && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else {
      notifications.push(msg);
    }
  }
});
const stderrLines = [];
proc.stderr.setEncoding("utf8");
proc.stderr.on("data", (c) => stderrLines.push(c));

function request(method, params, timeoutMs = 5000) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ __timeout: true, method });
    }, timeoutMs);
    pending.set(id, (resp) => {
      clearTimeout(timer);
      resolve(resp);
    });
    proc.stdin.write(JSON.stringify(msg) + "\n");
  });
}

function classify(resp, method) {
  if (resp.__timeout) return { status: "timeout", method };
  if (resp.error) {
    const code = resp.error.code;
    if (code === -32601) return { status: "missing", method, code, message: resp.error.message };
    if (code === -32602) return { status: "exists (param err)", method, code, message: resp.error.message, data: resp.error.data };
    return { status: `error(${code})`, method, message: resp.error.message, data: resp.error.data };
  }
  if (resp.result !== undefined) return { status: "exists (ok)", method, result: resp.result };
  return { status: "unknown", method, raw: resp };
}

async function main() {
  const results = [];

  // Setup: initialize + session/new. Required before session/* probes.
  const init = await request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
  });
  if (init.error) {
    console.error("initialize failed:", init.error);
    proc.kill();
    process.exit(1);
  }

  const sess = await request("session/new", {
    cwd: sandbox,
    mcpServers: [],
  });
  if (sess.error) {
    console.error("session/new failed:", sess.error);
    proc.kill();
    process.exit(1);
  }
  const sid = sess.result.sessionId;
  console.log(`sessionId: ${sid}`);
  console.log();

  // Candidate methods to probe. Order matters — we try destructive ones
  // (close/end/terminate) near the END so earlier probes still have a live
  // session to test against.
  const candidates = [
    // Baseline control — must report "missing"
    { method: "session/__nope__", params: { sessionId: sid } },

    // Cancel-family
    { method: "session/cancel", params: { sessionId: sid } },
    { method: "session/stop", params: { sessionId: sid } },
    { method: "session/abort", params: { sessionId: sid } },
    { method: "session/interrupt", params: { sessionId: sid } },
    { method: "session/cancelPrompt", params: { sessionId: sid } },

    // List (advertised in sessionCapabilities.list:{})
    { method: "session/list", params: {} },

    // Mode setter (discovered via modes field in session/new response)
    { method: "session/setMode", params: { sessionId: sid, modeId: "chat" } },
    { method: "session/set_mode", params: { sessionId: sid, modeId: "chat" } },

    // Load (agentCapabilities.loadSession:true)
    { method: "session/load", params: { sessionId: sid, cwd: sandbox, mcpServers: [] } },

    // Close family — destructive, run last
    { method: "session/close", params: { sessionId: sid } },
    { method: "session/end", params: { sessionId: sid } },
    { method: "session/terminate", params: { sessionId: sid } },
  ];

  for (const c of candidates) {
    const t0 = performance.now();
    const resp = await request(c.method, c.params, 3000);
    const dt = Math.round(performance.now() - t0);
    const cls = classify(resp, c.method);
    results.push({ ...cls, latency_ms: dt });
    console.log(
      `  ${c.method.padEnd(24)} → ${cls.status}${
        cls.code ? ` [${cls.code}]` : ""
      }${cls.message ? ` — ${cls.message}` : ""}`
    );
  }

  console.log();
  console.log("═══ SUMMARY (methods Goose ACP actually implements) ═══");
  const exists = results.filter(
    (r) => r.status === "exists (ok)" || r.status === "exists (param err)"
  );
  const missing = results.filter((r) => r.status === "missing");
  console.log(`  EXISTS:  ${exists.map((r) => r.method).join(", ") || "(none)"}`);
  console.log(`  MISSING: ${missing.map((r) => r.method).join(", ") || "(none)"}`);
  console.log();

  // Full JSON dump for ADR
  console.log(JSON.stringify({ results, notifications_during_probe: notifications }, null, 2));

  proc.kill();
  await new Promise((r) => setTimeout(r, 200));
}

main().catch((e) => {
  console.error(e);
  proc.kill();
  process.exit(1);
});
