import DOMPurify from 'dompurify';

/**
 * 링크 허용 목록.
 * 차단 목록이 아니라 허용 목록으로 간다 — capacitor://, intent://, content:// 같은
 * 안드로이드/Capacitor 고유 스킴을 일일이 나열할 수 없기 때문이다.
 * ★ markdown-it 기본 validateLink 는 capacitor:// 를 통과시킨다(실측 확인).
 *   반드시 이걸로 덮어쓴다.
 */
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\.{0,2}\/)/i;

/**
 * 스킴이 없는 상대 주소(`img/a.png`, `other.md`).
 *
 * ★ 스킴이 없다 = 첫 `/` `?` `#` 앞에 `:` 가 없다. `javascript:` · `data:` · `C:\` 는
 *   전부 그 앞에 `:` 가 있어서 걸린다. `java	script:` 처럼 사이에 공백을 끼운 것도
 *   `[^:/?#]*` 가 공백까지 먹고 `:` 에서 멈추므로 통과하지 못한다.
 * ★ `//host` (프로토콜 상대)는 뺀다. 출처를 바꾸는 주소다.
 */
const RELATIVE_URL = /^(?!\/\/)[^:/?#]*(?:[/?#]|$)/;

/**
 * 상대 주소를 허용할지. **기본은 끈다 — 모바일은 이 값을 켜지 않는다.**
 *
 * 모바일에는 문서 옆에 파일이 없다(SAF 로 연 문서 하나뿐). 상대 링크·그림은 가리킬 곳이
 * 없으므로 막아 둔 것이 지금까지 맞았다. 데스크톱은 같은 폴더의 그림·다른 .md 가 흔해서 켠다
 * (src/desktop/main.ts). 켜더라도 http(s) 밖의 스킴은 여전히 허용 목록 밖이다.
 */
let relativeUrls = false;
export function allowRelativeUrls(on: boolean): void {
    relativeUrls = on;
}

export function isSafeUrl(url: string): boolean {
    const u = url.trim();
    return SAFE_URL.test(u) || (relativeUrls && RELATIVE_URL.test(u));
}

/**
 * DOMPurify 설정. markdown-it html:false 가 이미 원시 HTML 을 막으므로 2차 방어선이다.
 * 파서 자체 취약점(과거 markdown-it/linkify-it 에 CPU 고갈 CVE 가 있었다)이나
 * highlight.js·KaTeX 가 뱉는 HTML 을 걸러내는 역할.
 */
// ★ as const 를 붙이지 마라. 배열이 readonly 가 되어 DOMPurify 의 Config 타입이 거부한다
//   (TS2769: readonly [...] is not assignable to string[]). 2026-08-03 실측.
export const PURIFY_CONFIG: import('dompurify').Config = {
    // KaTeX 가 MathML(<math>, <semantics>, <annotation>)을 뱉으므로 mathMl 프로필이 필요하다.
    USE_PROFILES: { html: true, mathMl: true, svg: true },
    ADD_TAGS: ['annotation', 'semantics'],
    // KaTeX 는 인라인 style 로 글자 위치를 잡는다. style 을 지우면 수식이 깨진다.
    // ★ FORBID_TAGS 의 'style'(태그)과 여기 'style'(속성)은 다른 것이다. 헷갈리지 마라.
    ADD_ATTR: [
        'align',
        'style',
        'tabindex',
        'aria-hidden',
        'encoding',
        'display',
        'checked',
        'disabled',
        'start',
        'colspan',
        'rowspan',
    ],
    FORBID_TAGS: [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'form',
        'input',
        'base',
        'link',
        'meta',
        'template',
        'noscript',
        'audio',
        'video',
        'source',
    ],
    FORBID_ATTR: ['srcset', 'formaction', 'ping', 'target', 'autofocus', 'loading'],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: SAFE_URL,

    /*
     * ★★ 이 목록이 없으면 표의 병합 셀이 조용히 풀린다 (2026-08-03 실측으로 발견).
     *
     *   DOMPurify 는 ALLOWED_URI_REGEXP 를 **URL 속성에만** 쓰지 않는다.
     *   URI_SAFE_ATTRIBUTES 에 없는 **모든 속성의 값**을 이 정규식에 통과시키고,
     *   맞지 않으면 값이 비어 있지 않은 한 그 속성을 통째로 지운다
     *   (purify.cjs.js 의 _isValidAttribute — `else if (regExpTest(IS_ALLOWED_URI, value))`).
     *
     *   우리 SAFE_URL 은 https:·mailto:·#·./ 로 시작하는 것만 통과시키므로
     *   colspan="2", start="5", display="block" 같은 **평범한 값이 전부 탈락한다.**
     *   기본 URI_SAFE_ATTRIBUTES 에 들어 있는 id·class·style 만 살아남아서,
     *   "표는 그려지는데 병합만 안 되는" 형태로 나타난다 — 눈치채기 어렵다.
     *
     *   ★ 여기에 href·src·action·poster·background·cite·data·usemap 을 넣지 마라.
     *     그 속성들은 진짜 URL 을 담으므로 반드시 SAFE_URL 검사를 받아야 한다.
     *     이 목록은 '링크가 될 수 없는 값'만 담는다.
     */
    ADD_URI_SAFE_ATTR: [
        // 표
        'colspan',
        'rowspan',
        'span',
        'scope',
        'headers',
        'align',
        'valign',
        // 목록
        'start',
        'reversed',
        'type',
        // 치수 (숫자거나 '100%')
        'width',
        'height',
        // KaTeX / MathML
        'encoding',
        'display',
        'mathvariant',
        'stretchy',
        'accent',
        'viewBox',
        'preserveAspectRatio',
        'transform',
        'd',
        // 접근성·기타
        'tabindex',
        'aria-hidden',
        'lang',
        'dir',
        'datetime',
        'checked',
        'disabled',
        'open',
    ],
};

/** 상대 주소를 허용하는 판. 허용 목록 하나만 넓히고 나머지는 PURIFY_CONFIG 그대로다. */
const PURIFY_CONFIG_RELATIVE: import('dompurify').Config = {
    ...PURIFY_CONFIG,
    ALLOWED_URI_REGEXP: new RegExp(`${SAFE_URL.source}|${RELATIVE_URL.source}`, 'i'),
};

export function sanitize(html: string): string {
    const cfg = relativeUrls ? PURIFY_CONFIG_RELATIVE : PURIFY_CONFIG;
    return DOMPurify.sanitize(html, cfg) as unknown as string;
}

/**
 * Mermaid 가 만든 SVG 전용 살균기. 본문용 sanitize() 를 그대로 쓰면 다이어그램이 안 보인다.
 *
 * ★ 2026-08-03 실기기·브라우저 실측으로 확인한 것 (그전에는 "그려진다"고만 알았다):
 *   - 본문 설정은 FORBID_TAGS 에 'style' 이 있어 **Mermaid 의 <style> 을 통째로 지운다.**
 *     색·선·글꼴이 전부 사라져 검정 도형이 되고 다크 테마에서 안 보인다.
 *   - Mermaid 는 라벨을 <text> 가 아니라 **<foreignObject> 안의 HTML** 로 그린다.
 *     기본 svg 프로필이 이를 지워서 글자가 하나도 안 남는다(실측 textNodes=0).
 *   - width/height 를 잃으면 SVG 가 기본 300x150 으로 붕괴한다.
 *
 * 위협 모델이 본문과 다르다 — 입력이 '남이 쓴 HTML' 이 아니라 **Mermaid 가
 * securityLevel:'strict' 로 만들어 낸 출력**이다. 그래서 <style> 하나만 더 허용한다.
 * ★ 그래도 script / iframe / 이벤트 핸들러는 그대로 막힌다. 거기를 열지 마라.
 *
 * ★ HTML 프로필도 foreignObject 도 허용하지 않는다. mermaid 를 `htmlLabels: false` 로
 *   설정해 라벨을 SVG <text> 로 그리게 했기 때문에(6-12절) **SVG 안에 HTML 이 아예 없다.**
 *   → 만약 어떤 다이어그램 종류가 "도형은 있는데 글자가 없는" 상태로 나오면,
 *     원인은 그 종류가 foreignObject 를 쓰기 때문이다. **살균기를 열지 말고
 *     그 종류의 htmlLabels 를 false 로 꺼라.** DOMPurify 는 SVG 문자열을 HTML 파서로 읽어
 *     SVG→XHTML 네임스페이스 전환을 깨뜨리므로, 열어도 내용은 어차피 비워진다(실측).
 */
const MERMAID_SVG_CONFIG: import('dompurify').Config = {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    ADD_ATTR: ['style', 'class', 'width', 'height', 'viewBox', 'preserveAspectRatio', 'transform'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'base', 'link', 'meta'],
    FORBID_ATTR: ['formaction', 'ping', 'target'],
    ALLOW_DATA_ATTR: false,
};

export function sanitizeMermaidSvg(svg: string): string {
    return DOMPurify.sanitize(svg, MERMAID_SVG_CONFIG) as unknown as string;
}
