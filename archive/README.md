# Archive — Android / 모바일

Marklet 은 처음에 Capacitor 8 기반 **Android 앱**으로 만들었다. 지금의 개발·배포 대상은 Windows 데스크톱
(`desktop/`, `src/desktop/`)이고, 모바일 쪽은 **보류**하면서 이곳에 그대로 보관한다. 지운 것은 없다 —
`git mv` 로 옮겼으므로 `git log --follow <파일>` 로 이력이 이어진다.

## 무엇이 들어 있나

| 경로 | 내용 |
|---|---|
| `android/` | Capacitor Android 네이티브 프로젝트(`com.marklet.md`). 자체 파일 플러그인(`MdFilePlugin.java`), SAF · 인텐트 처리, Gradle 설정 |
| `capacitor.config.json` | Capacitor 앱 설정 |
| `web/` | 모바일 웹 번들의 진입점: `index.html` · `licenses.html` · `vite.config.ts`(→ `www/`) · `public/webview-check.js`(낡은 WebView 가드) |
| `src/` | 모바일 전용 화면 · 서비스와 그 시험. 시작 화면 · 설정 · 편집 · 후원(`app/`), 최근 문서 · 폴더 · 초안 · 저장(`services/`), 네이티브 플러그인 래퍼(`plugins/`), 앱 진입점(`main.ts`) |
| `scripts/` | Play Console 자동화 · AAB 빌드/서명 · 기기 실측(번들 예산, 접근성 감사, 성능 측정, 아이콘 생성 등) |

## 데스크톱과 같이 쓰는 것

모바일과 데스크톱은 **렌더링 코어를 공유**했고 지금도 그렇다. 아래는 `src/` 에 남아 있으며 두 쪽이 같이 쓴다.

- `src/markdown/` — 파싱 · 살균 · 수식 · 코드 · 다이어그램 · 표 맞춤
- `src/app/{overlay,router,icons}.ts`, `src/app/screens/{viewer,search-bar,toc-sheet,diagram-viewer}.ts`
- `src/services/{settings,doc-search}.ts`, `src/i18n/`, `src/styles/`

그래서 **데스크톱에서 고친 공유 코드는 모바일 쪽 동작에도 영향을 준다.** 되살릴 때 이 점을 먼저 확인할 것.

## 되살리려면

1. 필요한 파일을 제자리로 `git mv` 한다 (`archive/src/…` → `src/…`, `archive/web/…` → 루트, `archive/android` → `android`).
2. 빠진 의존성을 되돌린다: `@capacitor/android` `@capacitor/filesystem` `@capacitor/haptics` `@capacitor/share`
   `@capacitor/splash-screen` `cordova-plugin-purchase` (현재 `package.json` 에는 데스크톱이 쓰는 Capacitor 패키지만 있다).
3. 모바일 빌드는 `archive/web/vite.config.ts` 로 한다. **출력(`www/`)을 데스크톱의 `dist-desktop/` 과 섞지 마라** —
   `www/` 는 `cap sync` 가 통째로 APK 에 넣는다.
4. Android 를 다시 낼 때는 먼저 Play 정책의 `targetSdk` 상향 기한을 확인한다. 이 폴더의 설계 문서는 저장소에 없다
   (내부 문서라 추적하지 않는다).
