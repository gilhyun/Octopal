# Phase 6 — manual verification checklist

**Owner:** Gil — manual gates only.
**Branch:** `feature/phase-6-per-agent-model` at HEAD = E-6.
**Prereqs:** Phase 5a + finalize verified (Anthropic + OpenAI both
detect their CLI binaries, both can `Activate` from the OpenAI/Anthropic
provider cards in Settings → Providers).

This file is the final merge gate before opening the Phase 6 PR.
Run G1-6 → G5-6 below; sign off at the bottom.

---

## What's already verified programmatically

| Layer | Test | Source |
|---|---|---|
| Schema (binding deserialization) | `agent_config::tests` × 5 | E-1 |
| Resolution helper | `agent_config::tests::resolve_*` × 6 | E-1 |
| Read graceful degradation | `agent_config::tests::read_or_default_*` × 4 | E-1 |
| Forward-compat (extra JSON fields) | `read_or_default_handles_extra_unknown_fields` | E-1 |
| Legacy claude path uses binding | code review (no automated test — function tightly coupled to claude CLI spawn) | E-2 |
| Goose path uses binding | code review (same constraint as legacy) | E-3 |
| Pool key includes provider+auth_mode+model | 5a-finalize C-2 tests cover this | (pre-Phase 6) |
| UI Model tab compile + types | `npx tsc --noEmit` clean for new files | E-4 |
| Agent card badge | `npx tsc --noEmit` clean | E-5 |

`cargo test --lib`: 154 passed at E-1, unchanged through E-2/E-3
(those are routing wires, not new test surface). UI commits don't
add Rust tests.

The remaining gates are end-to-end behaviors that require running the
actual app + sidecars + real provider auth.

---

## G1-6 — Per-agent provider override (Claude → GPT in same workspace)

The marquee test. Two agents in one workspace using different
providers.

**Setup:**

1. Build Phase 6 (`pnpm build`) and install to `/Applications` so
   LaunchServices PATH is exercised (5a-finalize §1 invariant).
2. Open a workspace with Anthropic + OpenAI both configured for
   CLI subscription (the 5a-finalize verification flow established
   this — both cards in Settings → Providers should show
   `cli_only` or `detected_both`).
3. Create two agents (or pick existing ones):
   - Agent A: leave Model tab on "Use workspace default" (assume
     workspace default = anthropic / claude-sonnet-4-6)
   - Agent B: open Model tab, uncheck "Use workspace default" for
     both fields, pick provider=OpenAI, model=gpt-5, save.
4. Sidebar should now show:
   - Agent A row: no badge (default everywhere)
   - Agent B row: `gpt-5` badge under the role text
   Hover Agent B's badge → tooltip
   `Pinned to provider=openai, model=gpt-5`

**Test:**

1. Open a terminal tailing Octopal stderr:
   ```
   log stream --predicate 'process == "octopal"' --info --debug
   ```
2. Send a message to Agent A. Expected stderr:
   ```
   [resolve] agent=A provider=anthropic auth=cli_subscription → goose_provider=claude-code
   [goose_acp_pool] MISS key=…::anthropic::cli_subscription::claude-sonnet-4-6::… → spawn
   ```
3. Send a message to Agent B. Expected stderr:
   ```
   [resolve] agent=B provider=openai auth=cli_subscription → goose_provider=chatgpt-codex
   [goose_acp_pool] MISS key=…::openai::cli_subscription::gpt-5::… → spawn
   ```

**Pass criteria:**

- [ ] Two distinct `[resolve]` lines, one per provider
- [ ] Two distinct pool keys (different provider segment)
- [ ] Both agents complete their messages — A from Claude, B from GPT
- [ ] No leakage: Agent A doesn't accidentally route via chatgpt-codex
      and vice versa

**Fail signals:**

| Symptom | Likely cause |
|---|---|
| Both agents resolve to anthropic | E-3 didn't land (provider hardcoded again) |
| Agent B "Could not find `codex`..." | binary_discovery candidate dirs missing nvm — should already be fixed by 5a-finalize D-1, so check `cargo run --example binary_discovery_smoke` |
| Card-saved provider doesn't persist | E-1 update_octo 3-state semantics broken — inspect config.json on disk |

---

## G2-6 — Workspace default cascade (legacy agents unchanged)

Verifies that agents without provider/model fields in their config.json
continue to use settings defaults — no surprises for legacy agents.

**Test:**

1. Find an existing agent with no Model tab edits ever (the
   default-assistant in any workspace works).
2. `cat <workspace>/octopal-agents/<agent-name>/config.json` →
   confirm no `provider` / `model` fields present.
3. Send a message → stderr `[resolve]` should show whatever the
   workspace default is (Settings → Providers → 기본 프로바이더 +
   기본 모델).

**Pass criteria:**

- [ ] Legacy config.json (no provider/model) loads cleanly
- [ ] Resolution falls back to settings — visible in `[resolve]` log
- [ ] No on-disk rewrite of the config.json just from loading the
      agent (Phase 6 doesn't migrate; absence stays absence)

---

## G3-6 — Cascading invalidation on provider switch

Verifies the UI's "switch provider clears model" cascade and that
the resulting save path produces a coherent config.json.

**Test:**

1. Open an agent's Model tab.
2. Uncheck "Use workspace default" on provider → set to OpenAI.
3. Set model to `gpt-5`.
4. Save. `config.json` now has `"provider": "openai", "model": "gpt-5"`.
5. Re-open the same agent's Model tab.
6. Switch provider to Anthropic.
7. Observe: model dropdown should now show Anthropic's catalog
   (`opus`/`sonnet`/`haiku` aliases + concrete IDs), and the model
   field is reset (no longer `gpt-5` which would be invalid for
   Anthropic).
8. Pick `opus`, save.

**Pass criteria:**

- [ ] Provider switch clears the model state in the UI
- [ ] Anthropic + `gpt-5` never co-occurs after a save
- [ ] Final config.json has `"provider": "anthropic", "model": "opus"`

---

## G4-6 — "Use workspace default" round-trip

Verifies that explicitly clearing an override removes the field from
config.json.

**Test:**

1. Set agent to provider=OpenAI, model=gpt-5 (G1-6 setup).
2. `cat config.json` → both fields present.
3. Re-open Model tab.
4. Check "Use workspace default" on provider → both provider AND
   model dropdowns disable, both state values clear.
5. Save.
6. `cat config.json` → neither provider nor model field present.

**Pass criteria:**

- [ ] Checking the provider checkbox cascades to clearing model too
      (cascading invalidation also applies in the inheriting direction)
- [ ] Both fields removed from config.json after save (not just set
      to empty string — physically absent)
- [ ] Subsequent message routes via workspace defaults

---

## G5-6 — Pool isolation on per-agent overrides

Verifies that per-agent (provider, model) tuples produce distinct
pool entries (no sidecar reuse across providers).

**Test (extends G1-6 setup):**

1. With Agent A (anthropic default) and Agent B (openai/gpt-5) both
   sending messages successfully:
2. Send 5 more messages to Agent A. stderr should show 1 MISS + 4
   HITs (sidecar pooled).
3. Send 5 more messages to Agent B. Same: 1 MISS + 4 HITs.
4. Send a message to Agent A again — should be HIT (entry still
   pooled).

**Pass criteria:**

- [ ] Two distinct pool entries simultaneously alive
- [ ] HIT log shows the right key (anthropic for A, openai for B)
- [ ] Switching between agents doesn't cause unrelated evictions

`hdiutil`-style check: `ps aux | grep goose` should show 2 sidecars
during this test (one per agent).

---

## Sign-off

If G1-6 through G5-6 all pass:

1. Mark each gate's checkboxes above.
2. PR is ready to merge:
   ```bash
   git push origin feature/phase-6-per-agent-model
   gh pr create --title "Phase 6 — per-agent provider + model selection"
   ```
3. PR body should link to:
   - `docs/phase-6-per-agent-model-scope.md` (the spec)
   - This file (verification record)
   - The 7 commits on the branch:
     - scope: `06e1225`
     - E-1: `72af299`
     - E-2: `8f5353b`
     - E-3: `a8803d2`
     - E-4: `c39d3e4`
     - E-5: `4b3a399`
     - E-6: this commit

If any gate fails: open a `docs/phase-6-blocker.md` with the
specific symptom + which gate failed + relevant stderr log lines.
Don't rebase or amend — fix-forward in a new commit.

---

Verified by: _______________
Date: _______________
Notes: _______________
