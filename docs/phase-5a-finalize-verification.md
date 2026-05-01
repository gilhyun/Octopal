# Phase 5a (incl. finalize) — manual verification checklist

**Owner:** Gil — manual gates only, no code changes expected here.
**Branch:** `feature/phase-5a-cli-subscription` at HEAD = D-6
**Replaces:** `docs/phase-5a-c3-manual-verification.md` (deleted in D-6 — the 5a-finalize gates supersede the original C-3 set; this file is the union)

This file is the merge gate before opening the PR to main. Run all
five gates G1–G5 below; each has a Pass criteria checklist. Sign off at
the bottom.

---

## What's already verified programmatically (no Gil action needed)

| Layer | Test | Source |
|---|---|---|
| Binary discovery | 14 unit tests + LaunchServices smoke (`env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin ./target/debug/examples/binary_discovery_smoke`) | D-1 |
| Tauri command boundary | `detect_binary_*` tests (validation, not_found, alias) | D-2 |
| Goose env injection | `env_builder_*_with_cli_command_*`, `env_builder_path_includes_parent_dirs` | D-3 |
| Resolver routing | `resolve_goose_provider_authmode_matrix` (incl. OpenAI) | D-4 |
| Pool key auth_mode | `hash_config_auth_mode_change_drifts`, `key_for_auth_mode_segment_visible_in_string` | C-2 |
| Settings flip preserves `api_key_stored` | `scenario_save_then_flip_to_cli_preserves_api_key_stored` etc. | B-fix (cc4c1ab) |

`cargo test --lib`: 138 passed, 0 failed at D-5. The remaining
checklist below covers what unit tests can't observe — real sidecar
spawning, real Anthropic/OpenAI subscription auth, real network
silence on Test Connection.

---

## G1-finalize — Anthropic CliSubscription end-to-end

**Setup:**

1. Confirm branch + binaries are correct:
   ```
   cd ~/Codes/Octopal
   git log --oneline -1   # → 6f05aa0 D-5 (or D-6 after this commit)
   ```

2. Build a fresh production-style bundle (matters because dev mode
   inherits a richer parent PATH and could hide LaunchServices issues):
   ```
   npm run tauri build
   open src-tauri/target/release/bundle/macos/Octopal.app
   ```
   …or copy the `.app` to `/Applications` and launch from Finder. The
   point is to launch via LaunchServices, not via `npm run tauri dev`.

3. In a separate terminal, tail stderr from the running Octopal so you
   can see the `[binary_discovery]`, `[resolve]`, and `[goose_acp_pool]`
   log lines:
   ```
   log stream --predicate 'process == "octopal"' --info --debug
   ```
   (or use Console.app and filter "octopal")

**Test:**

1. Open Settings → Providers → Anthropic card.
2. **Pre-fix expectation:** card showed `neither` state ("설정 안 됨" +
   "Claude CLI 설치하기" link) even though `claude` was installed in nvm.
3. **Post-fix expectation:** card shows either `cli_only` (no API key
   stored) or `detected_both` (key + CLI both present). Detection log
   line in stderr:
   ```
   [binary_discovery] discovered claude at /Users/.../v22.15.1/bin/claude
   ```
4. Click **Activate Claude CLI subscription** (or select the radio if in `both`).
5. Click **Test Connection** → expect "Claude CLI가 응답합니다" banner.
6. Close Settings, send a message in any agent.

**Expected stderr on first message:**
```
[resolve] agent=<n> provider=anthropic auth=cli_subscription → goose_provider=claude-code
[goose_acp_pool] MISS key=<folder>::<agent>::anthropic::cli_subscription::<model>::<hash> → spawn
[binary_discovery] discovered claude at /Users/.../claude.exe
```

**Pass criteria:**

- [ ] Anthropic card detects claude on a Finder-launched build (was the
      core P0 bug surfaced 2026-05-02)
- [ ] `[binary_discovery] discovered claude at /...nvm/...` line appears
- [ ] `[resolve]` line: `auth=cli_subscription goose_provider=claude-code`
- [ ] `[goose_acp_pool] MISS` key includes `::cli_subscription::`
- [ ] First message streams + completes (no auth error)

**If it fails:**

| Symptom | Likely cause |
|---|---|
| Card still shows "설정 안 됨" | `binary_discovery::candidate_search_paths()` missing your nvm/asdf install dir. Run `cargo run --example binary_discovery_smoke` to confirm + extend `candidate_search_paths`. |
| `[resolve]` shows `goose_provider=anthropic` (wrong) | settings.json has `"anthropic": "api_key"` not `"cli_subscription"`. UI flip didn't persist — check `set_auth_mode_cmd` log + cli_subscription module. |
| Goose stream errors with "could not resolve command 'claude'" | Augmented PATH not reaching child env. Check `build_goose_env` log; `env_builder_path_includes_parent_dirs` should have caught this. |
| `401 authentication_error` from Anthropic API | `claude` token expired. Run `claude` in a terminal to re-authenticate. (Goose surfaces this; not our bug.) |

---

## G2-finalize — OpenAI Codex CliSubscription end-to-end

Same flow as G1-finalize but for OpenAI's card.

**Test:**

1. Open Settings → Providers → OpenAI card.
2. **New behavior** (didn't exist before D-5): the OpenAI card now has
   the 4-state UI. Detect codex in nvm → `cli_only` or `detected_both`.
3. Click "Activate ChatGPT subscription" (label may differ; check
   manifest's `cliMethodLabel`).
4. **Test Connection** → "codex CLI가 응답합니다".
5. Send a message via an agent that uses OpenAI. (You may need to
   create one or change defaults — Settings → Providers → "기본 프로바이더"
   to OpenAI.)

**Expected stderr:**
```
[binary_discovery] discovered codex at /Users/.../v22.15.1/bin/codex
[resolve] agent=<n> provider=openai auth=cli_subscription → goose_provider=chatgpt-codex
[goose_acp_pool] MISS key=<folder>::<agent>::openai::cli_subscription::<model>::<hash> → spawn
```

**Pass criteria:**

- [ ] OpenAI card shows the 4-state UI (radio if both present)
- [ ] codex detected from nvm install
- [ ] `[resolve]` line: `goose_provider=chatgpt-codex`
- [ ] First message streams. **Note:** codex.js shebang `#!/usr/bin/env
      node` requires node on the child PATH — augmented PATH covers it.
      If this fails specifically with "env: node: No such file or
      directory", D-3's PATH augmentation regressed.

**If it fails:**

| Symptom | Likely cause |
|---|---|
| OpenAI card still shows simple ProviderCard | ProvidersTab dispatch logic — check that providers.json carries `cli_subscription` authMethod with `detectBinary` for openai |
| `[resolve]` shows `goose_provider=openai` not `chatgpt-codex` | `resolve_goose_provider` `("openai", CliSubscription)` arm — did D-4 land cleanly? |
| `env: node: No such file or directory` from codex | augmented PATH is missing nvm node bin. Run `cargo run --example binary_discovery_smoke` and confirm node is in candidate dirs. |
| codex prints OAuth login URL in stderr | first-time codex auth — open the URL in browser, authenticate, retry. (Not our bug; codex's own first-run flow.) |

---

## G3-finalize — flip-back drift respawn (mode toggle hygiene)

Verifies C-2's `auth_mode` in pool key forces a fresh sidecar spawn
when the user flips ApiKey ↔ CliSubscription. Belt-and-suspenders with
explicit `invalidate_pool_for_provider`.

**Test:**

1. With G1-finalize complete (sidecar pooled under cli_subscription).
2. Send a second message → confirm `[goose_acp_pool] HIT` (sidecar
   reused, fast).
3. Switch radio to API key (you'll need a saved key — paste anything to
   smoke-test even if it's invalid; the routing is what we're checking,
   not auth).
4. Send a third message.

**Expected stderr:**
```
[cli_subscription] set_auth_mode(anthropic, ApiKey) → 1 sidecars evicted
[resolve] agent=<n> provider=anthropic auth=api_key → goose_provider=anthropic
[goose_acp_pool] MISS key=<...>::anthropic::api_key::<model>::<hash> → spawn
```

**Pass criteria:**

- [ ] eviction log shows `1 sidecars evicted` (explicit invalidation, C-1's belt)
- [ ] new MISS key contains `::api_key::` (auth_mode in key, C-2's suspenders)
- [ ] message routes through API key path (Goose's `anthropic` provider, not `claude-code`)

---

## G4-finalize — negative path (binary missing → card flips back)

Verifies detection re-runs on every card mount.

**Test:**

1. With G1 / G2 complete (binaries detected).
2. In a terminal, temporarily move the claude binary aside:
   ```
   mv ~/.nvm/versions/node/v22.15.1/bin/claude{,.bak}
   ```
3. In Octopal, close + reopen Settings → Providers.
4. Anthropic card should flip from `cli_only` / `detected_both` to
   `neither` (assuming no API key stored) or `api_only`.
5. Restore:
   ```
   mv ~/.nvm/versions/node/v22.15.1/bin/claude{.bak,}
   ```
6. Close + reopen Settings → card flips back.

**Pass criteria:**

- [ ] Card state reflects current filesystem on every Settings open
- [ ] No stale detection from a previous mount

(Same test for codex → OpenAI card if you want to be exhaustive.)

---

## G5-finalize — zero-token Test Connection (network silence)

**Goal:** confirm Test Connection in CliSubscription mode runs only
`<bin> --version` locally, with no traffic to api.anthropic.com or
api.openai.com.

**Setup:**

```
sudo tcpdump -i any -n 'host api.anthropic.com or host api.openai.com' -vv
```

(Filter both hosts simultaneously so one capture covers both gates.)

**Test:**

1. Open Settings → Providers → Anthropic.
2. Select Claude CLI subscription radio.
3. Click **Test Connection**.
4. Repeat for OpenAI / codex.
5. Watch tcpdump for 30 seconds total.

**Pass criteria:**

- [ ] **Zero packets** to `api.anthropic.com` during the 15s after
      Anthropic's Test Connection click
- [ ] **Zero packets** to `api.openai.com` during the 15s after
      OpenAI's Test Connection click
- [ ] Both Test Connection succeed locally (banner shows "응답합니다")

**If you see traffic:** the `detect_binary` command was misimplemented
to query a model. Review `commands::cli_subscription::detect_binary`
and `probe_version` — both should only invoke `<bin> --version`.

---

## Post-verification

If G1 through G5 all pass:

1. Comment in this file under each gate, marking the box.
2. Open a PR from `feature/phase-5a-cli-subscription` → main:
   ```
   gh pr create --title "Phase 5a — Claude/Codex CLI subscription auth path"
   ```
3. PR body should link to:
   - `docs/phase-5a-scope.md` (5a base spec)
   - `docs/phase-5a-finalize-scope.md` (finalize spec)
   - This file (manual verification record)
   - The 11 commits on the branch:
     - A: `80df538` AuthMode enum + migration
     - B: `de0cc73` detect_claude + 4-state card
     - B-fix: `cc4c1ab` api_key_stored separation
     - C-1: `8a432c3` goose_acp routing
     - C-2: `61c65e8` auth_mode in pool key
     - D-1: `2906ee9` augmented binary discovery
     - D-2: `dbab94f` detect_binary generic
     - D-3: `1fc7917` *_COMMAND env + augmented child PATH
     - D-4: `508e27e` OpenAI Codex routing
     - D-5: `6f05aa0` ProviderCardWithCli
     - D-6: this commit (verification doc)

---

## Sign-off

Verified by: _______________
Date: _______________
Notes: _______________
