# Octopal

<p align="center">
  <img src="assets/logo.png" alt="Octopal Logo" width="180" />
</p>

<h1 align="center">스페이스를 만들고, 에이전트와 대화하세요.</h1>

<p align="center">
  AI 에이전트들의 팀 워크스페이스.<br />
  무료 & 오픈소스 — macOS & Windows 지원.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Early_Beta-v0.1.43-orange?style=flat-square" />
  <img src="https://img.shields.io/badge/Tauri_2-FFC131?style=flat-square&logo=tauri&logoColor=black" />
  <img src="https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white" />
  <img src="https://img.shields.io/badge/React_18-61DAFB?style=flat-square&logo=react&logoColor=black" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=flat-square&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Goose_ACP-000000?style=flat-square&logo=goose&logoColor=white" />
  <img src="https://img.shields.io/badge/Claude-D97757?style=flat-square&logo=anthropic&logoColor=white" />
  <img src="https://img.shields.io/badge/GPT-412991?style=flat-square&logo=openai&logoColor=white" />
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

## Octopal이란?

Octopal은 여러 AI 프로바이더(Claude, GPT, Ollama 등)를 지원하는 AI 에이전트 팀 워크스페이스입니다. 서로 다른 모델의 에이전트를 배치하고, 바로 협업을 시작하세요.

[**Goose**](https://github.com/block/goose)(by Block) 기반 — 오픈소스 멀티 에이전트 프레임워크로, Agent Control Protocol(ACP)을 통해 AI 프로바이더를 오케스트레이션합니다. Goose가 프로바이더 라우팅, 도구 실행, 세션 관리를 담당하여 각 에이전트가 역할에 맞는 최적의 모델을 활용할 수 있습니다.

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
| 🤖 | **멀티 모델** | Claude와 GPT 에이전트를 같은 방에서 운영하세요. 에이전트마다 다른 프로바이더 — 크로스모델 협업이 기본입니다. |
| 🎯 | **에이전트별 모델 지정** | 에이전트마다 원하는 모델을 지정하세요 — 코딩은 GPT-4o, 글쓰기는 Claude, 로컬은 Ollama. 자유롭게 조합 가능. |
| 🏠 | **로컬 모델 (Ollama)** | Ollama나 OpenAI 호환 로컬 서버를 연결하세요. API 키 없이 내 하드웨어로 완전 오프라인 에이전트 운영 가능. |
| 🔗 | **Agent-to-Agent** | 에이전트끼리 @멘션으로 연쇄 협업을 일으킵니다. 당신이 개입하지 않아도 됩니다. |
| 🔒 | **로컬 퍼스트, 프라이버시 퍼스트** | 모든 것이 내 컴퓨터에서 실행됩니다. 클라우드 서버도, 데이터 수집도 없어요 — 내 에이전트, 내 파일, 내 통제. |

## 시작하기

1. **옥토팔 앱 실행** — 앱을 열고 워크스페이스를 만드세요. 당신의 회사가 몇 초 만에 준비됩니다.
2. **폴더 추가** — 폴더를 추가하면 `octopal-agents/` 디렉토리가 생성됩니다. 폴더가 팀, 서브폴더가 에이전트 — 바로 일할 준비 완료.
3. **에이전트 만들고 채팅** — 각 에이전트에 역할을 부여하고 채팅을 시작하세요. @멘션으로 필요한 에이전트를 부르거나, 오케스트레이터에게 맡기세요.

## 주요 기능

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

### 2. 프로바이더 CLI (에이전트 통신용)

Octopal은 각 에이전트를 Goose ACP를 통해 프로바이더로 라우팅합니다. 사용하실
프로바이더의 CLI를 설치하세요 — 최소 하나는 필요합니다:

```bash
# Anthropic (Claude) — Pro/Max 구독을 claude-acp 어댑터로
npm install -g @anthropic-ai/claude-code           # claude CLI
npm install -g @zed-industries/claude-agent-acp    # ACP 어댑터
claude login                                       # OAuth 한 번

# OpenAI (GPT) — ChatGPT Plus/Pro 구독을 chatgpt_codex로
npm install -g @openai/codex                       # codex CLI
codex login                                        # OAuth 한 번
# ChatGPT 측 OAuth는 Octopal이 첫 메시지에서 Goose 통해 자동 처리
```

> Claude는 왜 npm 패키지가 두 개인가요? Goose v1.31.0의 `claude-acp`
> 프로바이더가 `claude-agent-acp` 어댑터를 spawn하고, 그 어댑터가 다시
> `claude` CLI를 spawn하는 구조입니다. 둘 다 `PATH`에 있어야 합니다.
> Octopal의 PATH 보강 로직이 nvm/asdf/homebrew 설치 위치를 자동 탐색
> 합니다.

> API 키 경로 (Settings → Providers → API Key)를 쓰시면 위 CLI들이
> 필요 없습니다. Claude Pro/Max 또는 ChatGPT 구독이 없으면 API 키를
> 붙여넣으세요.

## 다운로드

👉 **[최신 버전 다운로드](https://github.com/gilhyun/Octopal/releases)** (macOS / Windows)

> **⚠️ Windows 사용자 안내**
>
> 앱을 처음 실행할 때 보안 경고가 나타날 수 있습니다.
>
> - **Windows**: _Windows가 PC를 보호했습니다_ (SmartScreen) → **"추가 정보"** 클릭 → **"실행"**을 클릭하세요.

## 개발 환경 세팅

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

## 빌드 & CI

### GitHub Actions (자동 릴리즈)

Octopal은 버전 태그를 푸시하면 GitHub Actions가 자동으로 빌드 & 릴리즈합니다:

```bash
# 태그 찍고 푸시 — macOS + Windows 자동 빌드
git tag v0.1.43
git push origin v0.1.43
```

워크플로우 (`.github/workflows/release.yml`) 동작:
1. **빌드** — macOS (유니버설: Intel + Apple Silicon) + Windows (MSI + NSIS) 동시 빌드
2. **Goose 번들** — 플랫폼별 Goose sidecar 바이너리 자동 다운로드
3. **서명 & 공증** — 코드 서명 + Apple 공증 (메인테이너 secrets 필요)
4. **릴리즈** — DMG, MSI, EXE + 자동 업데이트 아티팩트로 GitHub Release 생성

### 포크해서 직접 빌드하기

Octopal을 포크하면 CI가 포크에서도 동작합니다. 알아둘 점:

| 항목 | 설명 |
|------|------|
| **Secrets** | 포크에는 원본 레포의 secrets가 없습니다. 서명/공증은 스킵되고, 서명 안 된 빌드가 만들어집니다. |
| **GITHUB_TOKEN** | GitHub가 포크 레포에 자동 제공합니다. 릴리즈는 포크의 Releases 페이지에 생성됩니다. |
| **Goose sidecar** | Block의 공개 GitHub Releases에서 다운로드 — secrets 없이 동작합니다. |
| **자동 업데이트** | `TAURI_SIGNING_PRIVATE_KEY` 없으면 동작하지 않습니다. 수동 다운로드 필요. |

포크에서 서명을 설정하려면 레포 secrets에 추가:
- `TAURI_SIGNING_PRIVATE_KEY` — 업데이터 아티팩트 서명용
- `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` — macOS 코드 서명용
- `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` — Apple 공증용

> Secrets 없어도 괜찮습니다. `pnpm build`로 로컬에서 서명 없는 앱을 바로 빌드할 수 있습니다.

## 기술 스택

| Layer | Tech |
|-------|------|
| Desktop | Tauri 2 (Rust 백엔드) |
| Frontend | React 18 + TypeScript 5.6 |
| Build | Vite 5 + Cargo |
| AI Engine | Goose ACP (Claude + OpenAI 멀티 프로바이더) |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| Icons | Lucide React |
| i18n | i18next + react-i18next |
| Styling | CSS (Dark Theme + Custom Fonts) |

> **왜 Rust?** Octopal은 Electron 대신 [Tauri 2](https://tauri.app)를 사용합니다. Rust 기반 백엔드는 훨씬 작은 바이너리 크기(~10MB vs ~200MB), 낮은 메모리 사용량, 네이티브 OS 통합을 제공하면서도 동일한 React + TypeScript 프론트엔드를 유지합니다.

## 프로젝트 구조

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

## 아키텍처

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
│    │ Goose   │                               │
│    │ ACP     │                               │
│    │ (spawn) │                               │
│    └────┬────┘                               │
│         │                                     │
│    ┌────▼────────────────────┐               │
│    │ Claude CLI │ OpenAI Codex│               │
│    │ (Anthropic)│ (OpenAI)   │               │
│    └─────────────────────────┘               │
└──────────────────────────────────────────────┘
```

## 데이터 저장

| 항목 | 경로 |
|------|------|
| 상태 (Dev) | `~/.octopal-dev/state.json` |
| 상태 (Prod) | `~/.octopal/state.json` |
| 대화 이력 | `~/.octopal/room-log.json` |
| 첨부 파일 | `~/.octopal/uploads/` |
| 위키 | `~/.octopal/wiki/{workspaceId}/` |
| 설정 | `~/.octopal/settings.json` |

## 변경 이력

릴리즈 노트와 업데이트 내역은 [CHANGELOG.md](CHANGELOG.md)를 참고하세요.

## 라이선스

[MIT License](LICENSE) © gilhyun
