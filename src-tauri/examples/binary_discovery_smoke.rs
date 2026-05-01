//! Binary-discovery smoke test — proves Phase 5a-finalize §3.1.
//!
//! Validates that [`octopal::commands::binary_discovery::discover_binary`]
//! finds `claude` / `codex` / `node` on the dev machine when invoked
//! WITHOUT a shell-loaded PATH. This simulates the macOS Finder/Dock
//! launch where Octopal inherits the LaunchServices PATH only.
//!
//! ```bash
//! # Normal (shell PATH): should always succeed.
//! cargo run --example binary_discovery_smoke
//!
//! # LaunchServices simulation: PATH stripped to defaults.
//! env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin \
//!     cargo run --example binary_discovery_smoke
//! # The augmented-PATH code should still find claude / codex via the
//! # nvm/asdf/homebrew heuristic.
//! ```
//!
//! Exit code is 0 if at least one binary was found, 1 otherwise.
//! (Lenient — `node` may legitimately be absent on minimal setups.)

use octopal_lib::binary_discovery_smoke_api::{augmented_path_value, discover_binary};

fn main() {
    println!("=== binary_discovery smoke ===");
    println!("PATH inherited: {:?}", std::env::var("PATH").ok());

    let names: &[&str] = &["claude", "codex", "node", "definitely-not-installed"];
    let mut any_found = false;
    for &name in names {
        match discover_binary(name) {
            Some(p) => {
                let path_str = p.display().to_string();
                println!("  ✓ {name:>30}: {path_str}");
                any_found = true;
            }
            None => println!("  ✗ {name:>30}: not found"),
        }
    }

    println!();
    println!("=== augmented PATH ===");
    let aug = augmented_path_value();
    for entry in aug.split(':') {
        println!("  {entry}");
    }

    if any_found {
        std::process::exit(0);
    } else {
        eprintln!("\nNo expected binaries found. If `claude`/`codex`/`node` are");
        eprintln!("installed on this machine but discovery missed them, the");
        eprintln!("candidate-dir heuristic needs an entry for your install method.");
        std::process::exit(1);
    }
}
