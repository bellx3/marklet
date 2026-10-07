# Archive (Android & Legacy Mobile Scripts)

이 디렉터리는 Marklet이 초기 Capacitor 8 기반 안드로이드 모바일 앱으로 개발되었을 당시의 네이티브 프로젝트 및 Google Play 배포 스크립트를 격리 보관하는 아카이브입니다.

## 보관 항목

- `android/`: Capacitor 기반 Android 네이티브 프로젝트 소스 (`com.marklet.md`)
  - 자체 네이티브 파일 I/O 플러그인 (`MdFilePlugin.java`)
  - 인텐트 처리 및 SAF 연동 코드
  - Gradle 빌드 설정 및 리소스
- `capacitor.config.json`: Capacitor 앱 설정
- `scripts/`: Play Console 자동화 및 AAB 빌드/서명 스크립트
  - `build-aab.cjs`, `publish.cjs`, `promote.cjs`, `play-*.cjs` 등

현재 프로젝트의 메인 개발 및 배포 대상은 Windows 데스크톱(`desktop/`, `src/desktop/`)입니다.
