//! Detects whether premium Claude models (e.g. Opus 4.6) are available on the
//! user's machine.
//!
//! The `claude` CLI routes requests through whatever auth the user has
//! configured (subscription or API key), and different accounts have access to
//! different models. Rather than assume `opus` maps to the newest opus, we
//! actively probe for the latest model strings so users with access to newer
//! tiers automatically benefit — and users without access silently fall back
//! to the generic `opus` alias.
//!
//! Probe trick: invoke `claude --print --model <name> --max-budget-usd 0.01
//! --no-session-persistence` with an empty prompt. The CLI validates the model
//! BEFORE hitting the API, so:
//!   • valid model → "Exceeded USD budget" (no tokens spent)
//!   • invalid/no-access → "There's an issue with the selected model"
//!
//! Results are cached on the `ManagedState` for the lifetime of the process.

use crate::commands::claude_cli::claude_command;
use crate::state::ManagedState;
use std::io::Write;
use std::process::Stdio;
use std::time::Duration;
use tauri::State;

/// Model names to probe, in priority order. First available one wins when the
/// user's effective model tier is `opus`.
pub const OPUS_CANDIDATES: &[&str] = &["claude-opus-4-6"];

/// Synchronously probe a specific model name. Returns `Ok(true)` if the CLI
/// recognizes the model and the account has access, `Ok(false)` otherwise.
/// Returns `Err` only on infrastructure failures (CLI missing, spawn failed).
pub fn probe_model(model: &str) -> Result<bool, String> {
    let mut cmd = claude_command();
    cmd.args([
        "--print",
        "--model",
        model,
        "--max-budget-usd",
        "0.01",
        "--no-session-persistence",
    ]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;

    // Send a minimal prompt then close stdin.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"hi\n");
    }

    // Wait with a reasonable timeout — the budget check is fast because it
    // happens before any network call.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err("probe timed out".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("wait failed: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("output capture failed: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{stdout}\n{stderr}");

    // Budget error means the model was valid — we're intentionally blocking
    // the actual API call with a micro-budget.
    if combined.contains("Exceeded USD budget") {
        return Ok(true);
    }
    // CLI's standard response for an unknown / inaccessible model.
    if combined.contains("issue with the selected model")
        || combined.contains("may not exist")
        || combined.contains("you may not have access")
    {
        return Ok(false);
    }

    // If we somehow got a successful response (budget wasn't triggered), the
    // model works too.
    if output.status.success() && !stdout.trim().is_empty() {
        return Ok(true);
    }

    // Unrecognized output — treat as unavailable to be safe.
    Ok(false)
}

/// Probe all opus candidates and return the first available one.
pub fn detect_best_opus() -> Option<String> {
    for candidate in OPUS_CANDIDATES {
        match probe_model(candidate) {
            Ok(true) => return Some((*candidate).to_string()),
            _ => continue,
        }
    }
    None
}

/// Kicks off a one-shot background probe on app start. Results are cached on
/// `ManagedState::best_opus_model` so subsequent agent spawns are instant.
///
/// Kept available for callers that already hold a full `Arc<ManagedState>`;
/// `lib.rs` uses the cheaper `best_opus_model.clone()` approach directly
/// because `ManagedState` is moved into Tauri's `.manage()` before we have
/// an Arc to it.
#[allow(dead_code)]
pub fn spawn_startup_probe(state: std::sync::Arc<ManagedState>) {
    std::thread::spawn(move || {
        let best = detect_best_opus();
        if let Ok(mut guard) = state.best_opus_model.lock() {
            *guard = Some(best);
        }
    });
}

/// Tauri command: return the currently cached best opus model name, or `null`
/// if the probe hasn't completed or no premium model is available.
#[tauri::command]
pub fn get_best_opus_model(state: State<'_, ManagedState>) -> Result<Option<String>, String> {
    let guard = state.best_opus_model.lock().map_err(|e| e.to_string())?;
    // Outer Option = "probe finished yet?", inner = "did we find one?".
    // The frontend only cares about the inner value; flatten for simplicity.
    Ok(guard.clone().flatten())
}

/// Tauri command: force a re-probe (useful if the user just updated their
/// Claude CLI and wants to pick up a newer model without restarting).
#[tauri::command]
pub async fn reprobe_best_opus_model(
    state: State<'_, ManagedState>,
) -> Result<Option<String>, String> {
    // Run on a blocking thread so we don't stall the async runtime while the
    // CLI spins up.
    let best = tokio::task::spawn_blocking(detect_best_opus)
        .await
        .map_err(|e| e.to_string())?;

    let mut guard = state.best_opus_model.lock().map_err(|e| e.to_string())?;
    *guard = Some(best.clone());
    Ok(best)
}

/// Resolve the model alias the user picked (e.g. "opus") to the concrete
/// model name we should pass to `--model`. When the alias is `opus` and a
/// newer explicit model (like `claude-opus-4-6`) has been detected, we
/// substitute it. Otherwise we pass the alias through unchanged.
pub fn resolve_model_for_cli(alias: &str, state: &ManagedState) -> String {
    if alias == "opus" {
        if let Ok(guard) = state.best_opus_model.lock() {
            if let Some(Some(ref explicit)) = *guard {
                return explicit.clone();
            }
        }
    }
    alias.to_string()
}
