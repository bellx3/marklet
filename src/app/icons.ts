/**
 * 아이콘 — 인라인 SVG.
 *
 * ★ 이모지를 쓰지 마라. 2026-08-04 실기기에서 확인한 것:
 *   삼성 기기는 📂·📖·🔍 를 **컬러 이모지 폰트**로 그린다. 회색조 UI 한가운데
 *   노랑·빨강 그림이 박혀서 정돈되지 않아 보이고, 기기·OS 버전마다 모양이 다르다.
 *   같은 이유로 폰트 아이콘(Material Icons 등)도 안 쓴다 — 웹폰트 한 벌이 번들에 얹힌다.
 *
 * ★ 전부 stroke 기반 24 그리드다. `currentColor` 를 쓰므로 다크 모드가 자동으로 따라온다.
 *   굵기는 1.75 — 1.5 는 작은 화면에서 흐리고 2 는 무겁다.
 *
 * ★ 경로 문자열은 innerHTML 로 들어간다. **여기에 바깥 입력을 절대 섞지 마라.**
 *   이 파일의 상수만 쓴다.
 */

const PATHS = {
    /** ← 뒤로 */
    back: '<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>',
    /** ☰ 목차 */
    list: '<path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/>',
    /** 검색 */
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
    /** 편집 */
    pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    /** ⋮ 더 보기 */
    more: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
    /** 설정 */
    settings:
        '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 8.9 19a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 5 8.9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9.5a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    /** 달 — 데스크톱의 테마 전환 */
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    /** ✕ 닫기 · 목록에서 빼기 */
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    /** 검색 이전 */
    up: '<path d="m18 15-6-6-6 6"/>',
    /** 검색 다음 */
    down: '<path d="m6 9 6 6 6-6"/>',
    /** › 다음 화면으로 */
    right: '<path d="m9 18 6-6-6-6"/>',
    /** 파일 열기 */
    fileOpen:
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/>',
    /** 폴더 추가 */
    folderPlus:
        '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/><path d="M12 10v6"/><path d="M9 13h6"/>',
    /** 예제 문서 */
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>',
    /** 폴더 */
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
} as const;
// ★ '언젠가 쓸' 아이콘을 미리 넣어 두지 마라. 쓰는 곳이 없는 경로는 번들에 실린 죽은 문자열이다.

export type IconName = keyof typeof PATHS;

/**
 * 아이콘 하나를 만든다.
 * @param size 화면에 그려질 크기(px). 터치 타깃은 버튼이 따로 48px 를 지킨다(10-1절).
 */
export function icon(name: IconName, size = 20): SVGSVGElement {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.75');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    // 장식용이다. 의미는 버튼의 aria-label 이 갖는다(10-3절).
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.innerHTML = PATHS[name];
    return svg;
}

/**
 * 아이콘만 있는 버튼. ★ aria-label 은 선택이 아니다 —
 * 안에 글자가 없으므로 이걸 빼면 TalkBack 이 "버튼"이라고만 읽는다(10-3절).
 */
export function iconButton(name: IconName, aria: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.appendChild(icon(name));
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
}
