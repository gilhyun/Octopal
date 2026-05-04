# Changelog

All notable changes to Octopal will be documented in this file.

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
