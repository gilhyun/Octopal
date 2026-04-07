# Octopal

<p align="center">
  <img src="assets/logo.png" alt="Octopal Logo" width="180" />
</p>

<p align="center">
  <strong>Group Chat with your Claude Code Agents</strong><br />
  Collaborate with your Claude Code agents more efficiently.<br />
  A group chat interface where multiple agents work together in real time.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-47848F?style=flat-square&logo=electron&logoColor=white" />
  <img src="https://img.shields.io/badge/React_18-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=anthropic&logoColor=white" />
</p>

<p align="center">
  <strong>English</strong> | <a href="README.ko.md">한국어</a>
</p>

---

## What is Octopal?

Octopal is a multi-agent chat app that runs on top of Claude Code. It's built for power users who work on multiple projects simultaneously.

Create a new workspace, import your project folders, easily add agents, and enjoy group chatting with your agent team.

All agent data is stored as `.octo` files in your project folder — everything lives inside the file. As long as you have the `.octo` file, you can pick up the conversation from anywhere.

## Features

### Chat
- Multi-agent group chat — A hidden mediator agent automatically summons domain-expert agents that can answer your questions.
- `@mention` routing, `@all` broadcast
- Real-time streaming responses + Markdown rendering (GFM, syntax highlighting)
- Image/text file attachments (drag & drop, paste)
- Consecutive message debouncing (1.2s buffer before agent invocation)
- Message pagination (loads 50 messages on scroll-up)

### Agent Management
- Create/edit/delete agents (name, role, emoji icon, color)
- Granular permission control (file write, shell execution, network access)
- Path-based access control (allowPaths / denyPaths)
- Agent handoff & permission request UI
- Automatic dispatcher routing

### Wiki
- Shared knowledge base per workspace — notes, decisions, and context accessible to all agents and sessions
- Markdown page CRUD (create, read, update, delete)
- Real-time editing with live preview
- All agents in the same workspace can read and write wiki pages
- Persistent across sessions — wiki pages survive app restarts

### Workspace
- Create/rename/delete workspaces
- Multi-folder management (add/remove folders)
- `.octo` file change detection (file system watch)

## Prerequisites

Octopal requires **Claude CLI** to be installed and logged in on your machine.

```bash
# 1. Install Claude CLI
npm install -g @anthropic-ai/claude-code

# 2. Log in
claude login
```

> Without Claude CLI, Octopal cannot communicate with agents. The app will show a login prompt on startup if Claude CLI is not detected or not logged in.

## Download

| Platform | Link |
|----------|------|
| macOS (Universal) | [Octopal-0.1.0-universal.dmg](https://github.com/gilhyun/Octopal/releases/latest/download/Octopal-0.1.0-universal.dmg) |
| Windows (x64 + ARM64) | [Octopal Setup 0.1.0.exe](https://github.com/gilhyun/Octopal/releases/latest/download/Octopal.Setup.0.1.0.exe) |

> **⚠️ Note on code signing**
>
> Octopal is not yet code-signed. You may see a security warning when launching the app for the first time.
>
> - **macOS**: _"Octopal" can't be opened because Apple cannot check it for malicious software._ → Go to **System Settings → Privacy & Security**, scroll down, and click **"Open Anyway"**.
> - **Windows**: _Windows protected your PC_ (SmartScreen) → Click **"More info"** → **"Run anyway"**.
>
> We plan to add code signing in a future release.

## Getting Started

```bash
# Install dependencies
npm install

# Development mode (Hot Reload)
npm run dev

# Production build & run
npm run prod
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run Vite + Electron simultaneously (dev mode) |
| `npm run dev:renderer` | Run frontend only |
| `npm run dev:main` | Run Electron main process only |
| `npm run build` | TypeScript + Vite production build |
| `npm run start` | Run the built app |
| `npm run prod` | Build + run (one step) |

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Electron 33 |
| Frontend | React 18 + TypeScript 5.6 |
| Build | Vite 5 |
| AI Engine | Claude CLI |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| Icons | Lucide React |
| i18n | i18next + react-i18next |
| Styling | CSS (Dark Theme + Custom Fonts) |

## Project Structure

```
Octopal/
├── src/                          # Electron main process
│   ├── main.ts                   # Window management, IPC handlers, file watch
│   └── preload.ts                # Context-isolated IPC bridge
│
├── renderer/src/                 # React frontend
│   ├── App.tsx                   # Root component (state management, agent orchestration)
│   ├── main.tsx                  # React entry point
│   ├── globals.css               # Global styles (dark theme, fonts, animations)
│   ├── types.ts                  # Runtime type definitions
│   ├── utils.ts                  # Utilities (color, path)
│   ├── global.d.ts               # TypeScript global interfaces
│   │
│   ├── components/               # UI components
│   │   ├── ChatPanel.tsx         # Chat UI (messages, composer, mentions, attachments)
│   │   ├── LeftSidebar.tsx       # Workspace/folder/tab navigation
│   │   ├── RightSidebar.tsx      # Agent list & activity status
│   │   ├── ActivityPanel.tsx     # Agent activity log
│   │   ├── WikiPanel.tsx         # Wiki page management
│   │   ├── SettingsPanel.tsx     # Settings (general/agent/appearance/shortcuts/about)
│   │   ├── AgentAvatar.tsx       # Agent avatar
│   │   ├── MarkdownRenderer.tsx  # Markdown renderer
│   │   ├── EmojiPicker.tsx       # Emoji picker
│   │   ├── MentionPopup.tsx      # @mention autocomplete
│   │   └── modals/               # Modal dialogs
│   │       ├── CreateAgentModal.tsx
│   │       ├── EditAgentModal.tsx
│   │       ├── CreateWorkspaceModal.tsx
│   │       ├── WelcomeModal.tsx
│   │       └── OpenFolderModal.tsx
│   │
│   └── i18n/                     # Internationalization
│       ├── index.ts              # i18next configuration
│       └── locales/
│           ├── en.json           # English
│           └── ko.json           # Korean
│
├── scripts/
│   └── patch-electron-name.js    # macOS app name patch (postinstall)
│
└── assets/                       # Logo, icons
```

## Architecture

```
┌─────────────────────────────────────────────┐
│                 Electron                     │
│  ┌────────────┐         ┌────────────────┐  │
│  │  Main       │  IPC    │   Renderer     │  │
│  │  Process    │◄───────►│   (React)      │  │
│  │  (main.ts)  │preload  │   (App.tsx)    │  │
│  └──────┬─────┘         └───────┬────────┘  │
│         │                       │            │
│    ┌────▼────┐           ┌──────▼──────┐    │
│    │ File    │           │ Components  │    │
│    │ System  │           │ ChatPanel   │    │
│    │ .octo   │           │ Sidebars    │    │
│    │ Wiki    │           │ Modals      │    │
│    │ State   │           │ Settings    │    │
│    └────┬────┘           └─────────────┘    │
│         │                                    │
│    ┌────▼────┐                              │
│    │ Claude  │                              │
│    │ CLI     │                              │
│    │ (spawn) │                              │
│    └─────────┘                              │
└─────────────────────────────────────────────┘
```

## Data Storage

| Item | Path |
|------|------|
| State (Dev) | `~/.octopal-dev/state.json` |
| State (Prod) | `~/.octopal/state.json` |
| Chat history | `~/.octopal/room-log.json` |
| Attachments | `~/.octopal/uploads/` |
| Wiki | `~/.octopal/wiki/{workspaceId}/` |
| Settings | `~/.octopal/settings.json` |

## License

[MIT License](LICENSE) © gilhyun
