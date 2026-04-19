//! Keyring smoke test — proves the Phase 4 stack (scope §6 G1 / G4).
//!
//! Two modes, auto-selected from env:
//!
//! **Mode A: Keyring path** (normal operation)
//! ```bash
//! cargo run --example keyring_smoke
//! # On macOS first run, triggers a Keychain prompt for cargo/binary.
//! # Click "Always Allow" → subsequent runs silent.
//!
//! # Prove env vars don't matter:
//! env -i HOME=$HOME PATH=$PATH TERM=xterm \
//!     ./target/debug/examples/keyring_smoke
//! ```
//!
//! **Mode B: Env-fallback path**
//! ```bash
//! env -i HOME=$HOME PATH=$PATH \
//!     OCTOPAL_API_KEY_FALLBACK=env \
//!     OCTOPAL_KEY__SMOKETEST=fallback-value \
//!     ./target/debug/examples/keyring_smoke
//! # Asserts save/delete refuse (per scope §10.3) and load reads env var.
//! ```
//!
//! Both modes write/read under account `_smoketest`. Any leftover entry
//! is visible in Keychain Access → "com.octopal.api_keys" service.

use octopal_lib::keyring_smoke_api as api_keys;

const TEST_PROVIDER: &str = "_smoketest";
const TEST_KEY: &str = "smoke-test-value-not-a-real-key";

fn banner(msg: &str) {
    println!("\n──── {msg} ────");
}

fn fail(msg: impl std::fmt::Display) -> ! {
    eprintln!("\n✗ FAIL: {msg}");
    std::process::exit(1);
}

fn fallback_active() -> bool {
    std::env::var("OCTOPAL_API_KEY_FALLBACK").as_deref() == Ok("env")
}

fn env_snapshot() {
    banner("env snapshot");
    println!("HOME={:?}", std::env::var("HOME").ok());
    println!(
        "ANTHROPIC_API_KEY set? {}",
        std::env::var("ANTHROPIC_API_KEY").is_ok()
    );
    println!(
        "OCTOPAL_USE_GOOSE   set? {}",
        std::env::var("OCTOPAL_USE_GOOSE").is_ok()
    );
    println!(
        "OCTOPAL_API_KEY_FALLBACK={:?}",
        std::env::var("OCTOPAL_API_KEY_FALLBACK").ok()
    );
}

/// Mode A — real keyring backend. Writes, reads, deletes, confirms idempotent.
fn run_keyring_mode() {
    println!("Mode A: keyring backend (macOS Keychain / Win Credential Manager / Linux Secret Service)");

    banner("cleanup before");
    match api_keys::delete_api_key(TEST_PROVIDER) {
        Ok(()) => println!("✓ pre-cleanup ok"),
        Err(e) => println!("! pre-cleanup error (may be harmless): {e}"),
    }

    banner("save_api_key");
    match api_keys::save_api_key(TEST_PROVIDER, TEST_KEY) {
        Ok(()) => println!("✓ saved"),
        Err(e) => fail(format!("save failed: {e}")),
    }

    // Hold-for-inspection: when OCTOPAL_KEYRING_SMOKE_HOLD_MS is set, sleep
    // between save and delete so an external `security find-generic-password`
    // can observe the entry in Keychain. Cross-verification for the smoke
    // test transcript.
    if let Ok(ms) = std::env::var("OCTOPAL_KEYRING_SMOKE_HOLD_MS") {
        if let Ok(ms) = ms.parse::<u64>() {
            println!("  (holding {ms}ms for external inspection)");
            std::thread::sleep(std::time::Duration::from_millis(ms));
        }
    }

    banner("load_api_key");
    match api_keys::load_api_key(TEST_PROVIDER) {
        Ok(Some(v)) => {
            let v: String = v;
            if v == TEST_KEY {
                println!("✓ roundtrip ok ({} bytes)", v.len());
            } else {
                fail(format!("mismatch: got {} bytes, expected {}", v.len(), TEST_KEY.len()));
            }
        }
        Ok(None) => fail("load returned None after save — keyring not persisting"),
        Err(e) => fail(format!("load failed: {e}")),
    }

    banner("delete_api_key");
    match api_keys::delete_api_key(TEST_PROVIDER) {
        Ok(()) => println!("✓ deleted"),
        Err(e) => fail(format!("delete failed: {e}")),
    }

    banner("load after delete");
    match api_keys::load_api_key(TEST_PROVIDER) {
        Ok(None) => println!("✓ entry absent"),
        Ok(Some(_)) => fail("delete did not purge the entry"),
        Err(e) => fail(format!("post-delete load failed: {e}")),
    }

    banner("delete idempotency");
    match api_keys::delete_api_key(TEST_PROVIDER) {
        Ok(()) => println!("✓ double-delete is ok"),
        Err(e) => fail(format!("idempotent delete failed: {e}")),
    }
}

/// Mode B — env fallback. Save/delete must refuse (scope §10.3), load
/// must read from OCTOPAL_KEY_<PROVIDER>.
fn run_fallback_mode() {
    println!("Mode B: env fallback (OCTOPAL_API_KEY_FALLBACK=env)");

    banner("save_api_key — must refuse");
    match api_keys::save_api_key(TEST_PROVIDER, TEST_KEY) {
        Ok(()) => fail("save should have refused in fallback mode"),
        Err(e) => {
            if e.contains("OCTOPAL_API_KEY_FALLBACK") && e.contains("OCTOPAL_KEY__SMOKETEST") {
                println!("✓ refused with clear message: {e}");
            } else {
                fail(format!("unexpected refusal text: {e}"));
            }
        }
    }

    banner("delete_api_key — must refuse");
    match api_keys::delete_api_key(TEST_PROVIDER) {
        Ok(()) => fail("delete should have refused in fallback mode"),
        Err(e) => {
            if e.contains("OCTOPAL_API_KEY_FALLBACK") && e.contains("OCTOPAL_KEY__SMOKETEST") {
                println!("✓ refused with clear message: {e}");
            } else {
                fail(format!("unexpected refusal text: {e}"));
            }
        }
    }

    banner("load_api_key — reads OCTOPAL_KEY__SMOKETEST");
    let expected = std::env::var("OCTOPAL_KEY__SMOKETEST").ok();
    match api_keys::load_api_key(TEST_PROVIDER) {
        Ok(got) => {
            if got == expected {
                println!("✓ load returned env var value: {got:?}");
            } else {
                fail(format!(
                    "load mismatch: got {got:?}, expected {expected:?} (from env)"
                ));
            }
        }
        Err(e) => fail(format!("load failed: {e}")),
    }
}

fn main() {
    println!("Octopal keyring smoke test");
    println!("service=com.octopal.api_keys  account={TEST_PROVIDER}");
    env_snapshot();

    if fallback_active() {
        run_fallback_mode();
    } else {
        run_keyring_mode();
    }

    println!("\n✓ PASS");
}
