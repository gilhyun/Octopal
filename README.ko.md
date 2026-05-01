# Octopal

<p align="center">
  <img src="assets/logo.png" alt="Octopal Logo" width="180" />
</p>

<h1 align="center">스페이스를 만들고, 에이전트와 대화하세요.</h1>

<p align="center">
  AI 에이전트들의 팀 워크스페이스 — 내 컴퓨터, 내 폴더 안에서.<br />
  무료 & 오픈소스 — macOS & Windows 지원.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Tauri_2-FFC131?style=flat-square&logo=tauri&logoColor=black" />
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" />
  <img src="https://img.shields.io/badge/React_18-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=anthropic&logoColor=white" />
</p>

<p align="center">
  <a href="https://www.producthunt.com/posts/octopal-open-source?embed=true&utm_source=badge-featured&utm_medium=badge&utm_souce=badge-octopal-open-source" target="_blank"><img src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=octopal-open-source&theme=light" alt="Octopal on Product Hunt" height="40" /></a>
</p>

<p align="center">
  🌐 <a href="https://octopal.app"><strong>octopal.app</strong></a> &nbsp;|&nbsp;
  <a href="README.md">English</a> | <strong>한국어</strong>
</p>

<p align="center">
  <img src="demo.gif" alt="Octopal Demo" width="800" />
</p>

---

## What is Octopal?

Octopal은 클로드 코드 위에서 작동하는 AI 에이전트 팀 워크스페이스입니다. 프로젝트마다 스페이스를 만들고, 에이전트를 배치하고, 바로 협업을 시작하세요 — 내 컴퓨터, 내 폴더 안에서.

여러 프로젝트를 동시에 작업하는 헤비 클로드 사용자를 위해 만들어졌습니다.

모든 에이전트 데이터는 프로젝트 폴더의 `octopal-agents/` 디렉토리에 저장됩니다. 각 에이전트가 `config.json`과 `prompt.md`를 가진 서브폴더로 관리됩니다.

## Philosophy

> **스페이스를 만들고, 에이전트와 대화하세요.**

**하나의 심플한 메타포, 제로 인프라.**

옥토팔만의 심플한 구조는 익숙한 개념들을 강력한 AI 워크스페이스로 즉시 만들어줍니다. 서버도, 계정도 필요 없어요 — 모든 것이 내 컴퓨터 안에 있습니다.

| 개념 | 역할 | 설명 |
|------|------|------|
| 📁 폴더 | **팀** | 각 폴더가 독립적인 팀이 됩니다. 고유한 에이전트와 컨텍스트를 가집니다. |
| 📁 octopal-agents/ | **에이전트** | 각 서브폴더가 에이전트를 정의합니다 — 설정, 프롬프트, 성격까지. |
| 🏢 워크스페이스 | **회사** | 폴더들을 하나의 워크스페이스로 묶으면, 나만의 AI 회사가 완성됩니다. |

복잡한 설정 없이, 클라우드 없이 — 내 컴퓨터와 AI 에이전트만 있으면 됩니다.

## 하이라이트

| | 기능 | 설명 |
|---|------|------|
| 🐙 | **Octo Agents** | `octopal-agents/` 서브폴더로 에이전트를 정의합니다. 각 폴더가 고유한 역할, 성격, 능력을 가진 독립 에이전트입니다. |
| 💬 | **그룹 채팅** | 에이전트들이 서로, 그리고 당신과 자연스럽게 대화합니다. @멘션으로 지정하거나, 오케스트레이터가 자동 라우팅합니다. |
| 🧠 | **히든 오케스트레이터** | 스마트 오케스트레이터가 컨텍스트를 읽고 적시에 적절한 에이전트를 호출합니다. 당신이 지시하면, 에이전트가 협업합니다. |
| 📁 | **폴더 = 팀** | 폴더가 팀, 워크스페이스가 회사. 파일 정리하듯 에이전트 팀을 조직하세요. |
| 🔗 | **Agent-to-Agent** | 에이전트끼리 @멘션으로 연쇄 협업을 일으킵니다. 당신이 개입하지 않아도 됩니다. |
| 🔒 | **로컬 퍼스트, 프라이버시 퍼스트** | 모든 것이 내 컴퓨터에서 실행됩니다. 클라우드 서버도, 데이터 수집도 없어요 — 내 에이전트, 내 파일, 내 통제. |

## 시작하기

1. **옥토팔 앱 실행** — 앱을 열고 워크스페이스를 만드세요. 당신의 회사가 몇 초 만에 준비됩니다.
2. **폴더 추가** — 폴더를 추가하면 `octopal-agents/` 디렉토리가 생성됩니다. 폴더가 팀, 서브폴더가 에이전트 — 바로 일할 준비 완료.
3. **에이전트 만들고 채팅** — 각 에이전트에 역할을 부여하고 채팅을 시작하세요. @멘션으로 필요한 에이전트를 부르거나, 오케스트레이터에게 맡기세요.

## Features

### 채팅
- 멀티 에이전트 그룹 채팅 — 대화를 중재하는 히든 에이전트가 당신의 질문에 답변할 수 있는 분야별 전문가 에이전트를 자동 호출합니다.
- `@멘션` 라우팅, `@all` 전체 호출
- 실시간 스트리밍 응답 + Markdown 렌더링 (GFM, 코드 하이라이팅)
- 이미지/텍스트 파일 첨부 (드래그 앤 드롭, 붙여넣기)
- 연속 메시지 디바운싱 (1.2초 버퍼링 후 에이전트 호출)
- 메시지 페이지네이션 (스크롤 올리면 50건씩 로드)

### 에이전트 관리
- 에이전트 생성/편집/삭제 (이름, 역할, 이모지 아이콘, 색상)
- 세분화된 권한 관리 (파일 쓰기, 셸 실행, 네트워크 접근)
- 경로 기반 접근 제어 (allowPaths / denyPaths)
- 에이전트 핸드오프 & 권한 요청 UI
- 자동 디스패처 라우팅

### 위키
- 워크스페이스별 공유 지식 베이스 — 메모, 의사결정, 컨텍스트를 모든 에이전트와 세션에서 접근 가능
- 마크다운 페이지 CRUD (생성, 조회, 수정, 삭제)
- 실시간 편집 및 라이브 미리보기
- 같은 워크스페이스의 모든 에이전트가 위키 페이지를 읽고 쓸 수 있음
- 세션 간 영속성 — 앱을 재시작해도 위키 페이지 유지

### 워크스페이스
- 워크스페이스 생성/이름변경/삭제
- 멀티 폴더 관리 (폴더 추가/제거)
- `octopal-agents/` 변경 감지 (파일 시스템 워치)

<p align="center">
  <img src="screenshot2.png" alt="Octopal Features" width="800" />
</p>

## 사전 준비

소스에서 Octopal을 빌드하려면 두 가지가 필요합니다.

### 1. Rust 툴체인 (Tauri 백엔드 빌드용)

Octopal은 Tauri 앱이므로 `cargo`가 `PATH`에 등록되어 있어야 합니다.

```bash
# macOS / Linux
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"
```

> Windows는 [`rustup-init.exe`](https://rustup.rs)를 다운로드해 실행하세요.
> 플랫폼별 추가 의존성은 [Tauri 사전 요구사항 가이드](https://tauri.app/start/prerequisites/)를
> 참고하세요 (macOS: Xcode Command Line Tools, Windows: WebView2 + MSVC,
> Linux: `webkit2gtk`).

### 2. Claude CLI (AI 에이전트 통신용)

Octopal을 사용하려면 **Claude CLI**가 설치되어 있고 로그인되어 있어야 합니다.

```bash
# 1. Claude CLI 설치
npm install -g @anthropic-ai/claude-code

# 2. 로그인
claude login
```

> Claude CLI가 없으면 Octopal은 에이전트와 통신할 수 없습니다. Claude CLI가 감지되지 않거나 로그인되지 않은 경우 앱 시작 시 안내 팝업이 표시됩니다.

## Download

👉 **[최신 버전 다운로드](https://github.com/gilhyun/Octopal/releases)** (macOS / Windows)

> **⚠️ Windows 사용자 안내**
>
> 앱을 처음 실행할 때 보안 경고가 나타날 수 있습니다.
>
> - **Windows**: _Windows가 PC를 보호했습니다_ (SmartScreen) → **"추가 정보"** 클릭 → **"실행"**을 클릭하세요.

## Getting Started

이 프로젝트는 **pnpm**을 씁니다 (`package.json`의 `packageManager` 필드로
명시). 없다면 `corepack enable && corepack prepare pnpm@latest --activate`.

```bash
# 의존성 설치
pnpm install

# 개발 모드 (Hot Reload)
pnpm dev

# 프로덕션 빌드
pnpm build
```

### 스크립트

| 명령어 | 설명 |
|--------|------|
| `pnpm dev` | Tauri 개발 모드 (Vite + Rust 백엔드, 핫 리로드) |
| `pnpm build` | 프로덕션 빌드 — Rust 백엔드 + Vite 프론트엔드 컴파일, `.app` / `.dmg`(플랫폼별) 산출. **서명 키 불필요.** |
| `pnpm build:signed` | 업데이터 아티팩트 포함 릴리스 빌드. **메인테이너 전용** — `TAURI_SIGNING_PRIVATE_KEY` 환경변수 필요 (GitHub releases 자동 업데이트 채널용; CI에서 자동 설정). |

> **왜 `pnpm tauri build`가 아니라 `pnpm build`인가요?** 전자는
> `scripts/tauri-build.mjs`를 거쳐서 서명 키가 있을 때만 업데이터
> 아티팩트를 활성화합니다. 후자(`pnpm tauri build`)도 일반 `.app`/`.dmg`
> 빌드는 정상 동작합니다 — 기본 `tauri.conf.json`이
> `createUpdaterArtifacts: false`로 출시되므로 기여자는 "private key
> not set" 에러를 만나지 않습니다.

## Tech Stack

| Layer | Tech |
|-------|------|
| Desktop | Tauri 2 (Rust 백엔드) |
| Frontend | React 18 + TypeScript 5.6 |
| Build | Vite 5 + Cargo |
| AI Engine | Claude CLI |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| Icons | Lucide React |
| i18n | i18next + react-i18next |
| Styling | CSS (Dark Theme + Custom Fonts) |

> **왜 Rust?** Octopal은 Electron 대신 [Tauri 2](https://tauri.app)를 사용합니다. Rust 기반 백엔드는 훨씬 작은 바이너리 크기(~10MB vs ~200MB), 낮은 메모리 사용량, 네이티브 OS 통합을 제공하면서도 동일한 React + TypeScript 프론트엔드를 유지합니다.

## Project Structure

```
Octopal/
├── src-tauri/                    # Tauri / Rust 백엔드
│   ├── src/
│   │   ├── main.rs               # 앱 엔트리포인트
│   │   ├── lib.rs                # 플러그인 등록, 커맨드 라우팅
│   │   ├── state.rs              # 공유 앱 상태
│   │   └── commands/             # Tauri IPC 커맨드 핸들러
│   │       ├── agent.rs          # 에이전트 라이프사이클
│   │       ├── claude_cli.rs     # Claude CLI 스폰 & 스트리밍
│   │       ├── dispatcher.rs     # 메시지 라우팅 / 오케스트레이션
│   │       ├── files.rs          # 파일 시스템 작업
│   │       ├── folder.rs         # 폴더 관리
│   │       ├── workspace.rs      # 워크스페이스 CRUD
│   │       ├── wiki.rs           # 위키 페이지 CRUD
│   │       ├── settings.rs       # 앱 설정
│   │       ├── octo.rs           # 에이전트 설정 읽기/쓰기 (octopal-agents/)
│   │       ├── backup.rs         # 상태 백업
│   │       └── file_lock.rs      # 파일 잠금
│   ├── Cargo.toml                # Rust 의존성
│   └── tauri.conf.json           # Tauri 앱 설정
│
├── renderer/src/                 # React 프론트엔드
│   ├── App.tsx                   # 루트 컴포넌트 (상태 관리, 에이전트 오케스트레이션)
│   ├── main.tsx                  # React 엔트리포인트
│   ├── globals.css               # 전체 스타일 (다크 테마, 폰트, 애니메이션)
│   ├── types.ts                  # 런타임 타입 정의
│   ├── utils.ts                  # 유틸리티 (색상, 경로)
│   ├── global.d.ts               # TypeScript 글로벌 인터페이스
│   │
│   ├── components/               # UI 컴포넌트
│   │   ├── ChatPanel.tsx         # 채팅 UI (메시지, 작성, 멘션, 첨부)
│   │   ├── LeftSidebar.tsx       # 워크스페이스/폴더/탭 네비게이션
│   │   ├── RightSidebar.tsx      # 에이전트 목록 & 활동 상태
│   │   ├── ActivityPanel.tsx     # 에이전트 활동 로그
│   │   ├── WikiPanel.tsx         # 위키 페이지 관리
│   │   ├── SettingsPanel.tsx     # 설정 (일반/에이전트/외관/단축키/정보)
│   │   ├── AgentAvatar.tsx       # 에이전트 아바타
│   │   ├── MarkdownRenderer.tsx  # 마크다운 렌더러
│   │   ├── EmojiPicker.tsx       # 이모지 선택기
│   │   ├── MentionPopup.tsx      # @멘션 자동완성
│   │   └── modals/               # 모달 다이얼로그
│   │
│   └── i18n/                     # 다국어
│       ├── index.ts              # i18next 설정
│       └── locales/
│           ├── en.json           # English
│           └── ko.json           # 한국어
│
└── assets/                       # 로고, 아이콘
```

## Architecture

```
┌──────────────────────────────────────────────┐
│                  Tauri 2                      │
│  ┌─────────────┐         ┌────────────────┐  │
│  │  Rust Core   │  IPC    │   WebView      │  │
│  │  (commands/) │◄───────►│   (React)      │  │
│  │  lib.rs      │ invoke  │   App.tsx      │  │
│  └──────┬──────┘         └───────┬────────┘  │
│         │                        │            │
│    ┌────▼────┐           ┌──────▼──────┐     │
│    │ File    │           │ Components  │     │
│    │ System  │           │ ChatPanel   │     │
│    │ Agents  │           │ Sidebars    │     │
│    │ Wiki    │           │ Modals      │     │
│    │ State   │           │ Settings    │     │
│    └────┬────┘           └─────────────┘     │
│         │                                     │
│    ┌────▼────┐                               │
│    │ Claude  │                               │
│    │ CLI     │                               │
│    │ (spawn) │                               │
│    └─────────┘                               │
└──────────────────────────────────────────────┘
```

## Data Storage

| 항목 | 경로 |
|------|------|
| 상태 (Dev) | `~/.octopal-dev/state.json` |
| 상태 (Prod) | `~/.octopal/state.json` |
| 대화 이력 | `~/.octopal/room-log.json` |
| 첨부 파일 | `~/.octopal/uploads/` |
| 위키 | `~/.octopal/wiki/{workspaceId}/` |
| 설정 | `~/.octopal/settings.json` |

## License

[MIT License](LICENSE) © gilhyun
