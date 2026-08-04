# Marklet

안드로이드 마크다운 뷰어. AI 가 만들어 준 `.md` 를 **받은 그대로** 열어 읽는 것이 목표다.

- 표 · Mermaid 다이어그램 · 수식(KaTeX) · 각주 · 체크박스
- 폴더를 한 번 등록해 두면 그 안의 `.md` 가 계속 목록에 뜬다 (SAF 영속 권한)
- 파일 이름 검색(초성 지원)과 문서 안 검색
- 원본 파일에 바로 저장 — **쓰기 전에 백업을 먼저 받는다**
- 한국어 · 영어, 라이트 · 다크
- 광고 없음, 계정 없음, **문서는 기기를 벗어나지 않는다**

## 스택

Capacitor 8 + Vite 7 + TypeScript. **프레임워크를 쓰지 않는다** — 화면 대부분이
`innerHTML` 로 만든 문서라 가상 DOM 이 벌어 주는 게 거의 없고, 초기 JS 예산이
마크다운 스택(104KB)만으로 이미 절반을 넘는다. 근거는 `.docs/설계문서/02_기술_설계서.md` 0-3절.

파일 접근은 자체 네이티브 플러그인(`MdFilePlugin.java`)이 맡는다. 이유는 5-1절.

## 개발

```bash
npm install
npm run dev            # 브라우저
npm run dev:device     # 실기기 라이브 리로드
```

```bash
npm test               # vitest
npm run lint
npm run build          # 번들 예산 검사 포함
npm run build:aab      # 서명된 릴리스 번들
```

## 문서

`.docs/설계문서/` 에 설계·조사·출시 절차가 들어 있다. **코드를 고치기 전에 읽어라** —
특히 `02_기술_설계서.md` 15장 "절대 하지 말 것"은 전부 실제로 한 번씩 겪은 것들이다.

| 문서 | 내용 |
|---|---|
| `00_시작하기.md` | 여기부터 |
| `01_제품_결정서.md` | 무엇을 만들고 무엇을 안 만드는가 |
| `02_기술_설계서.md` | 구현 전부. 함정 목록 포함 |
| `03_출시_절차서.md` | Play Console 절차 |
| `04~07_조사_*.md` | 경쟁앱 · 렌더링 스택 · 파일 처리 · 선행 프로젝트 자산 |

## 자격증명

**저장소에 들어가지 않는다.** 아래는 `.gitignore` 로 막혀 있고, 없으면 해당 기능만 꺼진다.

| 파일 | 없으면 |
|---|---|
| `android/keystore.properties` · `android/app/*.keystore` | 릴리스 서명 불가 (디버그 빌드는 됨) |
| `android/play-service-account.json` | Play 자동 업로드 태스크 비활성 |
| `android/local.properties` | SDK 경로를 못 찾음 |

**키스토어 비밀번호를 어떤 문서에도 적지 마라.** 예시 파일은 `android/keystore.properties.example` 이다.
