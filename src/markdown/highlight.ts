import type MarkdownIt from 'markdown-it';

/**
 * 코드 하이라이트 — **지연 로드**.
 *
 * ★★ 예전에는 이 모듈이 hljs core + 언어 12개를 정적 import 해서
 *   **모든 실행에 gzip 22.6KB** 가 얹혔다. 시작 화면에도, 코드가 없는 문서에도,
 *   심지어 설정 화면만 열어도 받았다. 초기 번들의 16% 였다.
 *   수식(KaTeX)·다이어그램(Mermaid)과 같은 취급이 맞다 — 필요한 문서에서만 받는다.
 *
 * ★ 구조는 math.ts 와 같다. 받는 것은 한 번, **붙이는 것은 인스턴스마다**.
 *   뷰어는 문서를 열 때마다 새 markdown-it 을 만들기 때문이다(설정이 파서에 들어간다).
 */

/**
 * 우리가 실제로 그릴 수 있는 언어 이름과 별칭.
 *
 * ★★ 이 표만 **미리** 들고 있는다(수백 바이트). 문법(grammar)은 아래에서 받는다.
 *   이게 없으면 "코드 블록이 있는가"를 판정하려고 22.6KB 를 먼저 받아야 한다 —
 *   그러면 지연 로드를 하는 의미가 없다.
 *
 * ★ mermaid 는 일부러 뺐다. ```mermaid 만 있는 문서에서 하이라이터를 받으면
 *   그 22.6KB 가 통째로 헛수고다(다이어그램은 자기 청크가 따로 있다).
 */
const SUPPORTED = new Set([
    'javascript',
    'js',
    'typescript',
    'ts',
    'python',
    'py',
    'java',
    'kotlin',
    'bash',
    'sh',
    'shell',
    'zsh',
    'console',
    'json',
    'yaml',
    'yml',
    'xml',
    'html',
    'sql',
    'css',
    'markdown',
    'md',
]);

/** ```lang 표기에서 언어 이름만 뽑는다. ```ts {1,3} 같은 꼬리표도 받는다. */
function languageOf(info: string): string {
    return (
        info
            .trim()
            .toLowerCase()
            .split(/[\s,{]/)[0] ?? ''
    );
}

/**
 * 문서에 **우리가 그릴 수 있는** 코드 블록이 있는지 값싸게 판정.
 *
 * ★ 오탐이 나도 22.6KB 를 한 번 더 받을 뿐 깨지지 않는다.
 *   반대로 누락되면 코드가 회색 평문으로 나온다 — 그쪽이 더 나쁘므로 넉넉히 잡는다.
 */
export function looksLikeCode(source: string): boolean {
    const fences = source.matchAll(/^[ \t]*(?:```|~~~)[ \t]*([^\s`~]+)/gm);
    for (const m of fences) {
        if (SUPPORTED.has(languageOf(m[1] ?? ''))) return true;
    }
    return false;
}

/**
 * 내려받은 hljs. **"이미 붙였다"가 아니라 "이미 받았다"를 기억한다.**
 * ★ boolean 가드를 두지 마라 — math.ts 주석에 적힌 그 사고가 여기서도 똑같이 난다.
 */
let hljsModules: Promise<HljsBundle> | null = null;

interface HljsBundle {
    highlight(str: string, opts: { language: string; ignoreIllegals?: boolean }): { value: string };
    getLanguage(name: string): unknown;
}

/**
 * core + 언어 12개 = gzip 22.6KB(실측).
 * lib/common(37개)은 52.4KB, 전체(190개+)는 307.1KB. Shiki 는 1,641KB 로 논외.
 */
async function loadHljs(): Promise<HljsBundle> {
    const [core, ...langs] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/java'),
        import('highlight.js/lib/languages/kotlin'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/markdown'),
    ]);

    const hljs = core.default;
    const NAMES = [
        'javascript',
        'typescript',
        'python',
        'java',
        'kotlin',
        'bash',
        'json',
        'yaml',
        'xml',
        'sql',
        'css',
        'markdown',
    ];
    langs.forEach((mod, i) => hljs.registerLanguage(NAMES[i], mod.default));

    hljs.registerAliases(['js'], { languageName: 'javascript' });
    hljs.registerAliases(['ts'], { languageName: 'typescript' });
    hljs.registerAliases(['py'], { languageName: 'python' });
    hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
    hljs.registerAliases(['html'], { languageName: 'xml' });
    hljs.registerAliases(['yml'], { languageName: 'yaml' });
    hljs.registerAliases(['md'], { languageName: 'markdown' });

    return hljs as unknown as HljsBundle;
}

/**
 * 코드가 있을 때만 하이라이터를 붙인다. md 인스턴스를 그 자리에서 확장한다.
 *
 * ★ md.parse() 전에 await 해야 한다. 렌더 도중에 붙이면 앞 청크만 색이 없다.
 */
export async function ensureHighlight(md: MarkdownIt): Promise<void> {
    // 약속을 캐시한다. 동시에 두 번 불려도 내려받기는 한 번이다.
    hljsModules ??= loadHljs();
    const hljs = await hljsModules;
    md.set({ highlight: (str, lang) => highlightWith(hljs, str, lang) });
}

/**
 * markdown-it 의 highlight 옵션.
 * 빈 문자열을 반환하면 markdown-it 이 알아서 이스케이프한다 — 그게 안전한 기본 동작이다.
 * 여기서 반환한 HTML 은 markdown-it 이 그대로 넣지만 최종적으로 DOMPurify 를 통과한다.
 *
 * ★ 등록 안 된 언어는 하이라이트 없이 이스케이프된 평문으로 나온다. 깨지지 않는다.
 *   mermaid 도 여기서는 등록되지 않았으므로 평문 코드 블록이 되고,
 *   그 뒤 markMermaidBlocks() 가 표시를 남긴다(6-4절).
 */
function highlightWith(hljs: HljsBundle, str: string, lang: string): string {
    if (!lang) return '';
    const name = languageOf(lang);
    if (!hljs.getLanguage(name)) return '';
    try {
        return hljs.highlight(str, { language: name, ignoreIllegals: true }).value;
    } catch {
        return '';
    }
}

/** 내려받기 캐시를 비운다. 테스트 전용. */
export function __resetHighlightForTest(): void {
    hljsModules = null;
}
