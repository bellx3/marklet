/**
 * 영어 문자열 — **카탈로그의 원본이다.**
 *
 * ★ 왜 영어가 원본인가. 언어를 못 정했을 때(알 수 없는 설정 · 모르는 로케일) 떨어지는 곳이 영어라서,
 *   카탈로그의 기준도 영어로 둔다. 한국어는 이 모양을 그대로 따라가는 덮어쓰기다.
 *
 * ★★ 여기에 키를 더하면 `ko.ts` 는 **컴파일 오류가 난다.** 그게 의도다.
 *   번역이 빠진 채로 배포되면 한국어 화면에 영어가 섞여 나오고, 그건 조용히 지나간다.
 *   타입이 대신 잡아 주게 만들어 두었다(`ko: Catalog`).
 *
 * ★ 콘솔 메시지(console.warn/error)는 여기 넣지 마라. 그건 개발자용이고
 *   릴리스 빌드에서 지워진다. 사용자 눈에 닿는 글자만 카탈로그로 옮긴다.
 */

export const en = {
    common: { close: 'Close' },
    viewer: {
        toc: 'Table of contents',
        find: 'Find in document',
        edit: 'Edit',
        more: 'More',
    },

    search: {
        placeholder: 'Find in document',
        label: 'Find in document',
        previous: 'Previous match',
        next: 'Next match',
        close: 'Close search',
    },

    toc: {
        title: 'Contents',
        empty: 'This document has no headings.',
        untitled: '(untitled)',
    },

    view: { theme: 'Theme' },

    /** 떠오르는 컨트롤 · 팝업 메뉴 · 빈 화면 */
    desktop: {
        menuCopy: 'Copy',
        menuSelectAll: 'Select all',
        menuSource: 'Show source',
        menuOpen: 'Open…',
        menuPrint: 'Print…',
        menuPdf: 'Export as PDF…',
        emptyHint: 'Drop a Markdown file here\nor press Ctrl+O to open one',
    },
    diagram: {
        /*
         * ★ 확대·축소 단추는 화면에 '−' '+' 만 보인다. 그대로 두면 스크린 리더가
         *   기호를 그대로 읽어 무슨 단추인지 알 수 없다 — 이름을 따로 준다.
         */
        zoomOut: 'Zoom out',
        zoomIn: 'Zoom in',
        fit: 'Fit',
        label: 'Diagram',
        /** ★ CSS ::after 로 들어간다. setLanguage() 가 --i18n-zoom-hint 에 넣는다(styles/markdown.css). */
        zoomHint: 'Click to enlarge',
    },

    frontmatter: {
        /*
         * ★ 제목으로 쓸 **키**는 여기서 오지 않는다. frontmatter.ts 의 TITLE_KEYS 가
         *   언어와 무관하게 title·document·문서·제목 넷을 본다 —
         *   예전에는 이 라벨을 키로 써서 소문자 `document` 를 못 찾았다.
         */
        info: 'Document info',
    },

    mermaid: {
        loadFailed: 'Could not load diagram support',
        tooSlow: 'The diagram took too long to draw, so the code is shown instead',
        drawFailed: (reason: string) => `Could not draw the diagram — ${reason}`,
        unsupported: (kind: string) =>
            `'${kind}' diagrams are not supported in this version — showing the code instead`,
        syntaxError: 'The diagram has a syntax error, so the code is shown instead',
        sourceBelow: (message: string) => `${message}. The original code is below.`,
        blockLabel: 'Mermaid diagram',
    },

    content: {
        tableScrollable: 'Table (scrollable sideways)',
        image: 'Image',
        loadRemoteImage: (alt: string) => `Load image — ${alt}`,
        loadRemoteImageLabel: (alt: string) => `Load remote image: ${alt}`,
    },
    shell: { saved: 'Saved.' },
} as const;

/**
 * 카탈로그의 모양. ★ `as const` 를 벗겨 낸 넓은 타입이다 —
 * 안 그러면 `ko` 의 값이 영어 리터럴과 같아야 해서 번역을 못 넣는다.
 */
export type Catalog = {
    [S in keyof typeof en]: {
        [K in keyof (typeof en)[S]]: (typeof en)[S][K] extends (...args: infer A) => string
            ? (...args: A) => string
            : string;
    };
};
