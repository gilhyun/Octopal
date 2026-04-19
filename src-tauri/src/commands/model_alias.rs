//! Provider-agnostic model alias resolver (Phase 3, scope §2.3).
//!
//! Aliases (`opus`, `sonnet`, `haiku`) map to concrete model IDs per the
//! table anchored in ADR §6.8 (dated 2026-04-19 catalog):
//!
//! | Alias    | Provider    | Resolved ID                       |
//! |----------|-------------|-----------------------------------|
//! | opus     | anthropic   | `claude-opus-4-7`                 |
//! | sonnet   | anthropic   | `claude-sonnet-4-6`               |
//! | haiku    | anthropic   | `claude-haiku-4-5-20251001`       |
//!
//! Why hardcoded, not `providers.json`-driven: aliases are a semantic
//! commitment ("latest Opus") bound to the Octopal release cycle. Driving
//! them from a JSON overlay would let a bad `~/.octopal/providers.json`
//! silently misroute `"opus"` to a weaker model — a footgun that outweighs
//! the flexibility. ADR §6.8 pins these in code; this module is canonical.
//!
//! Resolution happens **once** in `run_agent_turn`, before pool-key
//! construction. Non-alias input is returned verbatim (custom model IDs
//! pass through — ADR §6.8a "no up-front validation"). Non-anthropic
//! providers receiving `opus`/`sonnet`/`haiku` also pass through so the
//! 404 surfaces in the activity stream, matching the same principle.

/// Resolves an alias or model ID for the given provider.
///
/// - `(alias, anthropic)` → concrete ID per the table above.
/// - anything else → input unchanged.
///
/// Stage 6b-ii dispatcher will reuse this on the Haiku/planner path.
pub fn resolve(alias_or_id: &str, provider: &str) -> String {
    match (alias_or_id, provider) {
        ("opus", "anthropic") => "claude-opus-4-7".to_string(),
        ("sonnet", "anthropic") => "claude-sonnet-4-6".to_string(),
        ("haiku", "anthropic") => "claude-haiku-4-5-20251001".to_string(),
        _ => alias_or_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_aliases_resolve() {
        assert_eq!(resolve("opus", "anthropic"), "claude-opus-4-7");
        assert_eq!(resolve("sonnet", "anthropic"), "claude-sonnet-4-6");
        assert_eq!(resolve("haiku", "anthropic"), "claude-haiku-4-5-20251001");
    }

    #[test]
    fn concrete_anthropic_ids_passthrough() {
        for id in [
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-sonnet-4-5-20250929",
            "claude-haiku-4-5",
        ] {
            assert_eq!(resolve(id, "anthropic"), id);
        }
    }

    #[test]
    fn non_anthropic_alias_passthrough() {
        // ADR §6.8a: don't remap semantics the provider doesn't own.
        // The 404 surfaces in activity stream, same path as any typo.
        assert_eq!(resolve("opus", "openai"), "opus");
        assert_eq!(resolve("sonnet", "google"), "sonnet");
    }

    #[test]
    fn custom_ids_passthrough() {
        // User-supplied "Custom model ID" escape hatch (ADR §6.8a).
        assert_eq!(resolve("gpt-5", "openai"), "gpt-5");
        assert_eq!(resolve("gemini-2.5-pro", "google"), "gemini-2.5-pro");
        assert_eq!(resolve("llama3:70b", "ollama"), "llama3:70b");
        // Hypothetical future Anthropic model Octopal hasn't curated yet.
        assert_eq!(
            resolve("claude-opus-4-8", "anthropic"),
            "claude-opus-4-8"
        );
    }

    #[test]
    fn empty_input_passthrough() {
        // Caller's responsibility — resolve doesn't validate emptiness,
        // it just won't match an alias arm. run_agent_turn's empty-model
        // default fallback handles the empty case upstream.
        assert_eq!(resolve("", "anthropic"), "");
    }
}
