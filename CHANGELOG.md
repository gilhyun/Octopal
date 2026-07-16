# Changelog

All notable changes to Octopal will be documented in this file.

## [0.1.56] - 2026-07-16

### Security

- Restricted renderer file access to registered workspaces, validated uploads, and one-shot native drag-and-drop grants; removed broad home and temporary-directory asset scopes.
- Added portable path validation, canonical containment, symlink defenses, atomic file replacement, and serialized read-modify-write updates across agents, history, wiki, backups, and settings.
- Made Goose tool permissions fail closed, constrained file tools to workspace/wiki roots, rejected unknown tools and invalid deny globs, and added bounded process/event/response buffers.
- Added native confirmation for MCP package installation and workspace-defined MCP commands, removed secret-bearing command logs and URLs, and cleaned up all child processes on errors and app exit.

### Improvements

- Updated the OpenAI API catalog with GPT-5.6 Sol, Terra, and Luna, preferring Sol for new OpenAI API agents.
- Updated the bundled Goose ACP sidecar to verified stable v1.41.0 and upgraded Tauri, Vite, Vitest, i18next, and related dependencies.
- Hardened the release workflow with dependency audits, full Rust/frontend tests, pinned actions and verifier downloads, release-secret checks, artifact/signature validation, and a corrected Windows updater manifest.
- Added regression coverage for chat submission, attachments, Markdown sanitization, settings/wiki freshness, task-board validation, MCP validation, permissions, filesystem boundaries, process pools, and concurrent persistence.

### Fixes

- Fixed stale async UI results, listener cleanup races, double chat submission, partial attachment failures, agent edit races, permission merging, activity rendering limits, and false-positive MCP validation.
- Fixed process-pool reuse after agent context changes, stale credential reinsertion, duplicate run IDs, unbounded idle sidecars, orphaned children, and file-conflict aliases.

## [0.1.55] - 2026-07-11

### Fixes

- Fixed Ollama/local-provider chat routing so the saved workspace model is used instead of being replaced by the Claude default model.
- Passed the saved Ollama host URL into Goose agent sessions.

## [0.1.43] - 2026-05-04

### Major Changes

- **Goose ACP Migration** — Switched AI engine from direct Claude CLI to [Goose](https://github.com/block/goose) (by Block). All agent communication now goes through the Agent Control Protocol (ACP), enabling true multi-provider orchestration.
- **Multi-Provider Support** — Agents can now use Claude (Anthropic) and GPT (OpenAI) in the same workspace. Cross-model collaboration out of the box.
- **Per-Agent Model Selection** — Each agent can be assigned a specific model (e.g., GPT-4o for coding, Claude for writing). Configurable via agent settings UI.
- **Local Model Support (Ollama)** — Connect Ollama or any OpenAI-compatible local server. Run agents fully offline with no API keys needed.
- **Provider CLI Auth** — Claude Pro/Max subscribers can use the `claude` CLI + `claude-agent-acp` adapter. ChatGPT Plus/Pro subscribers can use the `codex` CLI. API key path also available.
- **Goose Sidecar Bundling** — Goose binary is automatically downloaded and bundled during build. CI builds for macOS (universal) and Windows.

### Improvements

- Agent card now shows model badge (provider + model name)
- Provider/model dropdown cascade in agent settings UI
- README bilingual update (EN/KO) with Goose attribution
- Dispatcher routing updated for multi-provider agent pools
- ACP session pool invalidation on agent config update

### Fixes

- CI build failures on Windows (goose sidecar path resolution) and macOS (universal-apple-darwin target)
- Anthropic API model ID mapping for claude-acp catalog
- OpenAI provider pivot to chatgpt_codex (OAuth)
- Expanded OpenAI model list for chatgpt_codex provider

## [0.1.42] and earlier

- Initial release with Claude-only agent support
- Group chat with multi-agent orchestration
- Wiki shared knowledge base
- Workspace and folder management
- Agent permission system (file write, shell, network)
- Agent handoff protocol
- i18n support (English, Korean)
