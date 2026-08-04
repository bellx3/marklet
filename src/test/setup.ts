import { vi, beforeEach } from 'vitest';

// jsdom 에 없는 것들을 최소한으로 채운다.
// ★ 여기에 앱 코드의 대역을 넣지 마라. 목이 구현과 어긋난 채 테스트가 통과한다(11장).
if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
        setTimeout(
            () => cb(performance.now()),
            0,
        ) as unknown as number) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = ((id: number) =>
        clearTimeout(id)) as typeof cancelAnimationFrame;
}

// scrollIntoView — jsdom 이 구현하지 않는다(레이아웃 엔진이 없어서).
// 실제 WebView 에는 있으므로 호출이 터지지 않게만 채운다.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// matchMedia — jsdom 에 없다. 실제 브라우저에는 항상 있으므로 환경 메우기다.
// 기본값은 '전부 거짓'(모션 줄이기 꺼짐 · 라이트 테마)이고,
// 필요한 테스트는 각자 vi.spyOn(window,'matchMedia') 으로 덮어쓴다.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
}

// CSS.escape — jsdom 에 없다. 안드로이드 WebView(Chrome 46+)에는 있으므로
// 이건 '환경 메우기'지 앱 코드의 대역이 아니다. 사양대로 최소 구현한다.
if (typeof globalThis.CSS === 'undefined') {
    (globalThis as { CSS?: unknown }).CSS = {};
}
if (typeof globalThis.CSS.escape !== 'function') {
    globalThis.CSS.escape = (value: string): string =>
        String(value).replace(/[^\w-]/g, (ch) => `\\${ch}`);
}

beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    vi.restoreAllMocks();
});
