# Stage 6a — Activity Panel 회귀 (Goose ACP 경로)

**상태:** OPEN (Stage 6c 범위 밖, 별도 픽스)
**감지 시점:** 2026-04-19, Stage 6c Checkpoint 3 post-merge 회귀 중 Case 2 (file read)
**영향 범위:** `use_legacy_claude_cli=false` 경로 전용. Legacy Claude CLI 경로는 영향 없음.

---

## 증상

Goose ACP 경로에서 에이전트가 tool(예: `Read`)을 실제로 실행해 결과를 답변에 반영하는데도, **Octopal 앱 우측 Activity 패널에 해당 tool_use 블록이 표시되지 않음.**

채팅 메시지 스트리밍·응답 품질·pool 재사용 경로는 모두 정상. 누락된 것은 **Activity 시각화** 하나뿐.

---

## 재현 (Case 2 그대로)

1. `use_legacy_claude_cli=false` 상태로 `npm run tauri dev` 기동
2. 에이전트 하나 (예: `assistant`)에 아래 프롬프트 전송:

   ```
   Read the file /Users/gilhyun/Codes/Octopal/src-tauri/Cargo.toml and
   tell me the current version number.
   ```

3. 에이전트가 정확한 버전 문자열을 답변에 포함 → 실제로 파일을 읽었음을 증명 (학습 컷오프로는 현재 버전을 알 수 없음)
4. 앱 우측 Activity 패널 확인 → **tool_use 블록 0건** (Read / text_editor / 등 어떤 라벨도 안 뜸)

### 관찰된 로그

Pool·gate·메시지 스트리밍은 정상:

```
[agent:gate] agent=assistant legacy=false dev_override=false → run_agent_turn
[goose_acp_pool] HIT key=.../dd81b5281bb52c07
[goose_acp_pool] put key=.../dd81b5281bb52c07 pid=66247
```

하지만 같은 로그에서 ACP 쪽 tool-related 이벤트 흔적 전무:

```bash
$ grep -cE "tool_call|toolCall|tool_use|text_editor|developer__|sessionUpdate|session/update" /tmp/octopal-dev.log
0
```

---

## 분기 가설

`session/update` JSON-RPC 메시지가 들어오는 3가지 관문 중 어디서 끊기는지 아직 판단 불가:

### (A) ACP client가 tool_call 이벤트를 아예 수신 못 함

Goose 쪽이 `session/update` notification의 `sessionUpdate.updateType` 필드에 `toolCall` / `toolCallUpdate` 값을 실은 메시지를 보내지 않거나, 보내는 스키마가 Octopal 측 deserialize 패턴과 안 맞음.

**확인 방법:** `goose_acp.rs`의 JSON-RPC 읽기 루프에 raw stdin chunk / parsed Method name 로깅 임시 추가 후 재현.

### (B) ACP client는 수신하지만 `goose_acp_mapper.rs`가 매핑 안 함

mapper가 `assistantMessageChunk` / `toolCall` / `toolCallUpdate` 중 일부만 `Octopal activity event`로 번역하고 tool-관련 update는 no-op으로 떨어뜨림.

**확인 방법:** `goose_acp_mapper.rs`에 들어오는 모든 update 타입을 한 줄 eprintln으로 찍게 수정 후 재현.

### (C) Mapper는 `activity:log` Tauri 이벤트를 emit하는데 프론트엔드가 못 받음

Tauri 이벤트 이름 drift (예: legacy path는 `activity:log` 쓰는데 goose path가 다른 이름 emit), 또는 프론트엔드 `ActivityPanel.tsx`의 리스너 필터 조건이 goose path 이벤트를 거부.

**확인 방법:** Chrome DevTools → `window.__TAURI__` 이벤트 수신 로그 or `ActivityPanel.tsx`에서 `onActivity` 핸들러 진입 여부 로깅.

---

## 수정 위치 후보

| 파일 | 변경 내용 (가설별) |
|------|-------------------|
| `src-tauri/src/commands/goose_acp.rs` | (A) raw JSON-RPC chunk / method name 로깅 추가로 분기 판정. 확정 후 이 eprintln은 제거 |
| `src-tauri/src/commands/goose_acp_mapper.rs` | (B) `sessionUpdate.updateType=toolCall` / `toolCallUpdate` 케이스 핸들링 추가. tool name 정규화 맵 (`developer__shell` → `Bash` 등) 적용 |
| `renderer/src/components/ActivityPanel.tsx` 및 관련 Tauri 이벤트 구독부 | (C) 이벤트 이름 / 페이로드 스키마 일관화 |

---

## Stage 6c와의 관계

- **Stage 6c(pool 재사용)와 독립 이슈.** Pool은 sidecar 프로세스 생명주기만 관리하고 ACP 메시지 번역은 건드리지 않음. Case 2의 HIT 로그는 정상, PID도 4턴 연속 동일.
- **Stage 6a(ACP event mapper) 범위.** Legacy→Goose 마이그레이션 매트릭스에서 `#2 Tool-use 라벨링`에 해당. 매트릭스 위험도는 🟡(중간)으로 잡혀있었음.
- **베타(v0.2.0-beta) 출시 전 반드시 수정.** Activity 패널은 "에이전트가 뭘 건드리고 있는지" 유일한 UI 피드백이라, 누락되면 신뢰도 타격 큼.

---

## 제안 후속 작업

1. (A) 확인 먼저 — 가장 싼 비용으로 문제 영역 좁히기. `goose_acp.rs`에 임시 `eprintln!("[acp:recv] method={} params={}", …)` 한 줄 추가 후 재현.
2. (A) OK → (B) 확인 — `goose_acp_mapper.rs`에 역시 임시 로깅 추가
3. (B) OK → (C) 확인 — 프론트엔드 이벤트 리스너 점검
4. 확정된 층에서 수정, 각 층의 임시 eprintln은 제거, 회귀 테스트 Case 2 재실행해 Activity 패널에 라벨 뜨는지 visual 확인
