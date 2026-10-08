// Tauri 판 진입점. 순서가 전부다: window.marklet 을 먼저 채우고, 그 다음에 렌더러가 뜬다.
// (main.ts 는 모듈이 평가되는 순간 window.marklet 을 읽는다.)
import './tauri-bridge';
import './main';
