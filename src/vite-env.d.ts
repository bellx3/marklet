/// <reference types="vite/client" />

/**
 * tsconfig 의 "types": ["vitest/globals"] 가 기본 전역 타입 집합을 좁히므로
 * vite/client 타입(?raw 임포트, import.meta.env 등)은 이 파일로만 들어온다.
 *
 * ★ @ts-expect-error 로 때우지 마라. 타입이 없는 자리를 에러 억제로 덮으면 잘못된 호출이 조용히 지나간다.
 */

// 공식 타입 패키지가 없는 markdown-it 플러그인들
declare module 'markdown-it-footnote';
declare module 'markdown-it-task-lists';

/** vite.config.ts 의 define 이 package.json 의 version 을 넣는다. */
declare const __APP_VERSION__: string;
