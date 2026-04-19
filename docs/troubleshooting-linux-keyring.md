# Linux — API key storage without a Secret Service daemon

**Audience:** Linux users on minimal WMs, headless/docker environments, or
CI runners where `gnome-keyring` / `kwallet` isn't installed.

**TL;DR:** Octopal stores API keys in your OS keyring (macOS Keychain,
Windows Credential Manager, Linux Secret Service). If Linux has no
daemon, the keyring save fails and Settings shows an "OS keyring
unavailable" card. Either install a daemon or opt into the documented
env-var fallback.

---

## Option 1 — Install a Secret Service daemon (recommended)

This is the supported path. Pick whichever matches your desktop.

**GNOME / Ubuntu / Debian / most desktops:**
```bash
sudo apt install gnome-keyring libsecret-1-0
```

**KDE:**
```bash
sudo apt install kwalletmanager kde-cli-tools
# ensure the kwallet daemon is running at session start
```

**Arch:**
```bash
sudo pacman -S gnome-keyring   # or kwallet-pam for KDE
```

Restart Octopal after install. Settings → Providers should show the
normal per-provider cards. First save triggers the usual "unlock
keyring" prompt; subsequent saves are silent.

---

## Option 2 — Env-var fallback (unsafe, documented)

For CI / docker / intentionally headless setups, opt into reading keys
from env vars instead of the keyring. **This bypasses OS-level
encryption** — use only when the machine isn't shared.

### Enable

Set **at process launch** (must be in the env that launches Octopal):

```bash
export OCTOPAL_API_KEY_FALLBACK=env
```

Then set one env var per provider you use, uppercase:

```bash
export OCTOPAL_KEY_ANTHROPIC=sk-ant-...
export OCTOPAL_KEY_OPENAI=sk-...
export OCTOPAL_KEY_GOOGLE=...
```

Launch Octopal from that shell.

### What changes in the UI

- Providers tab shows a persistent yellow banner:
  > Running in environment-variable fallback mode. Keys are read from
  > `OCTOPAL_KEY_<PROVIDER>` env vars, bypassing OS keyring.
- The per-provider **Save** and **Remove** buttons return an error
  telling you to manage env vars externally instead.
- `has_api_key` (the "configured" indicator) reports based on env-var
  presence, not the `configured_providers` settings flag.

### Security implications

- **Env vars are inherited by child processes.** Any process Octopal
  spawns (the Goose sidecar does, by design — that's how the key reaches
  the API) and any subsequent fork or exec will see them. Don't run
  untrusted code in the same shell session.
- **`ps -E` leaks env on some platforms.** On Linux a regular user can
  see their own process env via `/proc/<pid>/environ`; root can see
  everyone's. Containers generally isolate this per-container.
- **Shell history leaks.** `export OCTOPAL_KEY_ANTHROPIC=sk-ant-xxx` in
  your bash history is a credential leak. Either use a keyring-backed
  secret manager that injects env at launch (1Password CLI, `pass`,
  HashiCorp Vault, etc.) or put the exports in a `chmod 600` file that
  your shell sources.
- **No rotation help.** OS keyring rotation triggers pool invalidation
  via the settings flag flip. Env fallback has no equivalent — changing
  an env var mid-session is invisible to Octopal (settings load is
  cached). **Restart the app after rotating a key.**

### When to use (and not)

Fine:
- Dedicated dev workstation with full disk encryption
- CI runner with secrets injected from a vault
- Container image where you control the entrypoint env

Not fine:
- Shared workstation (student lab, coworking space)
- Multi-user Linux server
- Any environment where `ps -E` output could be collected

---

## Why not a plaintext-file fallback?

We intentionally don't offer an "encrypted file" fallback. Two reasons:

1. **Encryption without OS-level binding is theater.** A file protected
   by a user-entered password can't do better than the OS keyring would
   — and adds a new passphrase to remember, break, and leak.
2. **The env-var fallback is already the right abstraction for the
   real use cases** (CI, docker). Adding a third storage backend would
   split testing and create an illusion of safety.

If your deployment needs something stronger than the env-var path,
integrate a vault like HashiCorp Vault or AWS Secrets Manager at the
*launch* layer — inject env at process start and let Octopal consume
via `OCTOPAL_KEY_<PROVIDER>`.

---

## Verifying your setup

Run Octopal once, open **Settings → Providers**, check the status
banner at the top:

- "OS keyring" → keyring backend is live; normal operation.
- "Environment-variable fallback" → you're in Option 2; banner shows
  which env vars are being read.
- "OS keyring unavailable" → neither — install a daemon (Option 1) or
  set `OCTOPAL_API_KEY_FALLBACK=env` (Option 2).

Under the hood, `keyring_status_cmd` returns one of those three states.

---

## Related

- Scope document: [docs/phase-3-4-scope.md](./phase-3-4-scope.md) §10.3
- ADR §D5 (keyring rationale): [docs/goose-integration-notes.md](./goose-integration-notes.md)
