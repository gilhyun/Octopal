# Phase 5a Commit C-3 — manual verification checklist

**Owner:** Gil (manual verification only — no code changes expected here)
**Prereq:** Commits C-1 (`8a432c3`) + C-2 (`61c65e8`) on
`feature/phase-5a-cli-subscription`
**Purpose:** Execute the two scope §8 merge gates that require a real
`goose acp` sidecar + real Anthropic subscription — the thing Claude
can't do from the CLI. Everything below runs inside the Octopal app on
Gil's machine.

---

## What C-1 + C-2 delivered (already verified programmatically)

| Scope ref | Item | Verification |
|---|---|---|
| §6.1 | `resolve_goose_provider` routing | `cargo test --lib`: `resolve_goose_provider_authmode_matrix` + `resolve_goose_provider_anthropic_cli_subscription_uses_claude_code` |
| §6.1 | `run_agent_turn` uses resolver + emits `[resolve]` log | Code review + `cargo check` |
| §6.2 | `provider_api_key_env` returns None for claude-code/claude-acp | `cargo test --lib`: `provider_api_key_env_cli_subscription_providers_return_none` |
| §6.3 | PATH propagated in `build_goose_env` | `cargo test --lib`: `env_builder_preserves_parent_path` + `env_builder_cli_subscription_shape` |
| §4.3 | `auth_mode` in pool hash + key | `cargo test --lib`: `hash_config_auth_mode_change_drifts` + `key_for_auth_mode_segment_visible_in_string` + `hash_config_same_auth_mode_same_otherwise_yields_same_hash` |
| §5.1 / §5.4 | `api_key_stored` preserved across flip | Phase 5a B-fix (`cc4c1ab`) |
| G3-5a | All Phase 3+4 tests still pass + new ones | 117 lib tests pass (was 96 at Phase 3+4 merge) |

**What's left for C-3:** G1-5a and G5-5a — both require running the
actual app against Gil's Claude Pro/Max subscription. No code changes
needed; the tests are behavioral.

---

## G1-5a — CliSubscription end-to-end turn

**Setup (do this once before starting):**

1. Confirm the branch:
   ```
   git log --oneline -3
   ```
   Top commit should be C-2: `61c65e8 feat(phase-5a): Commit C-2 — auth_mode in pool key`.

2. Build the app fresh:
   ```
   npm run tauri dev
   ```
   (Dev mode — real sidecar, same routing code, easier to watch stderr.)

3. Confirm `claude` binary is on PATH *as seen by the running app*.
   Open the app, then in a terminal launched from the same shell:
   ```
   which claude
   claude --version
   ```
   Both should succeed. If not, stop — the parent PATH won't have `claude`
   and this test will fail at the sidecar layer, not the Octopal layer.
   (Fix-forward tracked under scope §10.3, Phase 5b.)

**Test steps:**

1. In the app, open **Settings → Providers → Anthropic** card.
2. Confirm the card state:
   - If you've got a saved API key AND `claude` is detected →
     `detected_both` state (radio: API key / CLI subscription).
   - If only `claude` detected, no key → `cli_only` state (Activate button).
3. Select the **Claude CLI subscription** radio (or click Activate).
4. Click **Test Connection** → expect success banner:
   > "Claude CLI responds. You should be able to send messages now."
5. Watch the app's stderr (from `npm run tauri dev` terminal) for the
   `detect_claude` log line — no network traffic (verified in G5-5a below).
6. Close Settings. Send a message to any agent configured to use
   Anthropic (default should work).

**Expected logs on the first message (stderr):**

```
[resolve] agent=<agent-name> provider=anthropic auth=cli_subscription → goose_provider=claude-code
[goose_acp_pool] MISS key=<folder>::<agent>::anthropic::cli_subscription::<model>::<hash> → spawn
```

Grep anchors:
- `auth=cli_subscription` — proves Commit A+B's auth_mode enum resolved correctly
- `goose_provider=claude-code` — proves C-1's resolver mapped UI anthropic → goose claude-code
- `::cli_subscription::` inside the pool key — proves C-2 wired auth_mode into the key

**Expected UI behavior:**

- The message bubble streams text (same UX as API key mode).
- The response completes without an auth error.
- The Activity panel shows tool calls if the agent uses any.

**Pass criteria:**

- [ ] `[resolve]` line contains `auth=cli_subscription goose_provider=claude-code`
- [ ] `[goose_acp_pool] MISS` key contains `::cli_subscription::`
- [ ] First message completes (streaming text visible in the chat bubble)
- [ ] No error banner

**Fail signals & what they mean:**

| Error seen | Likely cause | Action |
|---|---|---|
| "No authentication configured" | `set_auth_mode_cmd` didn't write | Check settings.json — should have `"anthropic": "cli_subscription"` |
| "could not resolve command 'claude'" | PATH missing claude | Check `which claude` in the shell that launched Octopal |
| "goose_provider=anthropic" (wrong!) | Resolver bug or stale sidecar | Retry after restart. If persists: `git diff` and look at `resolve_goose_provider` |
| `401 authentication_error` from Anthropic | `claude` token expired | Run `claude` in a terminal to re-authenticate |

---

## G1-5a follow-up — the flip-back test

Verifies C-2's hash drift forces a respawn when auth mode changes.

1. With the sidecar from G1-5a still pooled (send another message first
   to confirm a HIT: log should show `[goose_acp_pool] HIT`).
2. Back to Settings → Providers → Anthropic → select **API key** radio.
   (This requires a stored key from earlier; if you don't have one, save
   a throwaway key first — Test Connection can use the free `/v1/models`
   endpoint.)
3. Send another message.

**Expected logs:**

```
[cli_subscription] set_auth_mode(anthropic, ApiKey) → 1 sidecars evicted
[resolve] agent=<n> provider=anthropic auth=api_key → goose_provider=anthropic
[goose_acp_pool] MISS key=<folder>::<agent>::anthropic::api_key::<model>::<hash> → spawn
```

**Pass criteria:**

- [ ] Eviction log shows `1 sidecars evicted` (C-1's belt: explicit invalidation)
- [ ] Pool key in the next MISS contains `::api_key::` (C-2's suspenders: segment in key)
- [ ] New message completes using the API key path

---

## G5-5a — Test Connection never hits the network

**Goal:** Verify the cli_subscription Test Connection button runs
`claude --version` locally and does NOT send any request to
`api.anthropic.com`.

**Setup:**

Option A (macOS, simpler): use Activity Monitor's Network tab with
Octopal selected. Filter to see only traffic to `*.anthropic.com`.

Option B (more rigorous): run `tcpdump` or `Wireshark` filtered to
Octopal's PID:
```
sudo tcpdump -i any -n 'host api.anthropic.com' -vv
```

**Test steps:**

1. Open Settings → Providers → Anthropic card.
2. Select Claude CLI subscription.
3. Start the network monitor.
4. Click **Test Connection**.
5. Observe the monitor for 10 seconds.

**Pass criteria:**

- [ ] Zero outbound connections to `api.anthropic.com` during the 10s window
- [ ] Test Connection succeeds with the "Claude CLI responds" banner
- [ ] stderr shows a `detect_claude` / `claude --version` log line

**If you see any anthropic.com traffic:** stop and report. That's a
scope §5.3 violation (Test Connection must not burn tokens).

---

## Post-verification

If G1-5a (both halves) and G5-5a pass:

1. Comment in this file under each checklist marking the box.
2. Open a PR from `feature/phase-5a-cli-subscription` → main.
3. PR title: `Phase 5a — Claude CLI subscription auth path`
4. PR body should link to:
   - `docs/phase-5a-scope.md` (the spec)
   - This file (manual verification record)
   - Commits A (`80df538`) / B (`de0cc73`) / B-fix (`cc4c1ab`) / C-1
     (`8a432c3`) / C-2 (`61c65e8`)

If any gate fails:

- **G1-5a first half fails** → start at the "Fail signals" table above.
  The most likely failure is the PATH issue (§10.3). If that's it, C-3
  doesn't change — Phase 5b handles it.
- **G1-5a flip-back fails** → probably a C-2 regression. Run
  `cargo test --lib commands::goose_acp_pool` and see which of the
  3 new tests fails. That localizes it.
- **G5-5a fails** → Commit B regression. The `detect_claude` command
  should be `which claude` + `claude --version` only. Check
  `src-tauri/src/commands/cli_subscription.rs::detect_claude` for any
  accidental network call.

---

## Sign-off

Verified by: _______________
Date: _______________
Notes: _______________
