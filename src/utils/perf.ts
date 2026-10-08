/**
 * 계측 링버퍼 (12-3절).
 *
 * ★ 릴리스 빌드에서는 console 이 지워진다(esbuild.drop). 콘솔만 쓰면
 *   정작 재야 하는 빌드에서 아무것도 안 보인다. 링버퍼에 남기고 getSamples() 로 읽는다(시험 · 개발자 도구).
 */

export interface Sample {
    name: string;
    ms: number;
    at: number;
}

const samples: Sample[] = [];
const MAX_SAMPLES = 100;

/** 이미 잰 값을 그대로 남긴다. 청크별 최대값처럼 직접 누적하는 항목용. */
export function record(name: string, ms: number): void {
    push(name, ms);
}

function push(name: string, ms: number): void {
    samples.push({ name, ms, at: Date.now() });
    if (samples.length > MAX_SAMPLES) samples.shift();
    /*
     * 디버그 빌드에서는 logcat 으로도 보인다.
     * ★ 릴리스에서는 vite.config 의 esbuild `pure` 목록이 이 호출을 지운다
     *   (2026-08-06 확인: 릴리스 번들에 '⏱ ' 형식 문자열이 없다).
     *   릴리스에서 재야 하면 콘솔이 아니라 getSamples() 를 본다 — 그러라고 링버퍼가 있다.
     */
    console.info(`⏱ ${name}: ${ms.toFixed(1)}ms`);
}

/** 링버퍼를 읽는다. 릴리스 빌드에서도 동작한다. */
export function getSamples(): readonly Sample[] {
    return samples;
}

export function clearSamples(): void {
    samples.length = 0;
}
