import { describe, it, expect, afterEach } from 'vitest';
import { sanitize, sanitizeMermaidSvg, isSafeUrl, allowRelativeUrls } from './sanitize';

/**
 * 11-2절 #1 · #2.
 *
 * ★ 문자열 매칭이 아니라 **결과 DOM** 을 검사한다. `&lt;script&gt;` 처럼
 *   무해하게 이스케이프된 텍스트를 잡아 헛된 실패를 만들면 테스트가 무시당한다.
 */

function parse(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = sanitize(html);
    return host;
}

const XSS_VECTORS = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<svg onload=alert(1)></svg>',
    '<body onload=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="JaVaScRiPt:alert(1)">x</a>',
    '<a href="java\tscript:alert(1)">x</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>',
    '<a href="vbscript:msgbox(1)">x</a>',
    '<form action="javascript:alert(1)"><button>x</button></form>',
    '<input type="text" onfocus=alert(1) autofocus>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<base href="javascript:alert(1)//">',
    '<link rel=stylesheet href="javascript:alert(1)">',
    '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    '<style>@import "javascript:alert(1)";</style>',
    '<div style="background:url(javascript:alert(1))">x</div>',
    '<video><source onerror=alert(1)></video>',
    '<math><mtext><script>alert(1)</script></mtext></math>',
    '<template><script>alert(1)</script></template>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<a href="capacitor://localhost/x">x</a>',
];

describe('sanitize — XSS 방어 (2차 방어선)', () => {
    it.each(XSS_VECTORS)('결과 DOM 에 실행 가능한 것이 남지 않는다: %s', (vector) => {
        const host = parse(vector);

        expect(host.querySelector('script')).toBeNull();
        expect(host.querySelector('iframe')).toBeNull();
        expect(host.querySelector('object')).toBeNull();
        expect(host.querySelector('embed')).toBeNull();
        expect(host.querySelector('form')).toBeNull();
        expect(host.querySelector('input')).toBeNull();
        expect(host.querySelector('base')).toBeNull();
        expect(host.querySelector('link')).toBeNull();
        expect(host.querySelector('meta')).toBeNull();
        expect(host.querySelector('style')).toBeNull();

        for (const el of Array.from(host.querySelectorAll('*'))) {
            for (const attr of Array.from(el.attributes)) {
                expect(attr.name.toLowerCase().startsWith('on')).toBe(false);
                if (attr.name === 'href' || attr.name === 'src' || attr.name === 'action') {
                    expect(isSafeUrl(attr.value)).toBe(true);
                }
            }
        }
    });

    it('멀쩡한 마크다운 산출물은 살아남는다', () => {
        const host = parse(
            '<h2 id="a">제목</h2><p><a href="https://example.com">링크</a>' +
                '<code>x</code></p><table><tr><td colspan="2">칸</td></tr></table>',
        );
        expect(host.querySelector('h2')?.id).toBe('a');
        expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
        expect(host.querySelector('td')?.getAttribute('colspan')).toBe('2');
    });

    /*
     * 회귀: PURIFY_CONFIG 에서 ADD_URI_SAFE_ATTR 를 지우면 이 테스트가 실패하는 것을 확인함.
     *
     * DOMPurify 는 ALLOWED_URI_REGEXP 를 URL 속성뿐 아니라 **모든 속성 값**에 적용한다.
     * 우리 SAFE_URL 이 엄격해서 colspan="2" 같은 평범한 값까지 탈락시켰다(2026-08-03 실측).
     */
    it('★ 링크가 아닌 속성이 URL 검사에 걸려 지워지지 않는다', () => {
        const table = parse(
            '<table><tbody><tr><td colspan="2" rowspan="3" align="center">칸</td></tr></tbody></table>',
        );
        const td = table.querySelector('td')!;
        expect(td.getAttribute('colspan')).toBe('2');
        expect(td.getAttribute('rowspan')).toBe('3');
        expect(td.getAttribute('align')).toBe('center');

        const ol = parse('<ol start="5"><li>다섯</li></ol>');
        expect(ol.querySelector('ol')?.getAttribute('start')).toBe('5');
    });

    it('★ 그래도 href 는 여전히 SAFE_URL 검사를 받는다 (위 목록이 구멍이 아니다)', () => {
        const host = parse('<a href="javascript:alert(1)" colspan="2">x</a>');
        expect(host.querySelector('a')?.hasAttribute('href')).toBe(false);
    });

    it('KaTeX 가 뱉는 MathML 과 인라인 style 은 살린다', () => {
        const host = parse(
            '<span class="katex"><math><semantics><mrow><mi>x</mi></mrow>' +
                '<annotation encoding="application/x-tex">x</annotation></semantics></math>' +
                '<span style="height:0.8em">x</span></span>',
        );
        expect(host.querySelector('annotation')).not.toBeNull();
        expect(host.querySelector('span[style]')).not.toBeNull();
    });
});

describe('isSafeUrl — 허용 목록', () => {
    // ★ markdown-it 기본 validateLink 는 capacitor:// 를 통과시킨다(실측).
    //   이 오버라이드가 사라지는 걸 막는 테스트다.
    it.each([
        'capacitor://localhost/x',
        'intent://scan/#Intent;scheme=zxing;end',
        'javascript:alert(1)',
        'JAVASCRIPT:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'file:///sdcard/x.md',
        'content://com.example/doc/1',
        'vbscript:msgbox(1)',
        // ★ 프로토콜 상대 — 출처를 바꾼다. 모바일에서는 '원격 이미지 기본 차단'을 우회했다.
        '//evil.example/track.png',
        '/\\evil.example/track.png',
        './/evil.example/track.png',
    ])('거부: %s', (url) => {
        expect(isSafeUrl(url)).toBe(false);
    });

    it.each([
        'https://example.com',
        'http://example.com',
        'mailto:a@b.com',
        'tel:+821012345678',
        '#anchor',
        './relative.md',
        '../up.md',
        '/root.md',
    ])('허용: %s', (url) => {
        expect(isSafeUrl(url)).toBe(true);
    });

    it('앞뒤 공백이 있어도 판정이 같다', () => {
        expect(isSafeUrl('  javascript:alert(1)  ')).toBe(false);
        expect(isSafeUrl('  https://example.com  ')).toBe(true);
    });
});

describe('★★ 실제 공격 벡터 — 남이 만든 문서를 여는 앱이다', () => {
    /** 결과에 실행 가능한 것이 남았는지. 대소문자·공백을 무시하고 본다. */
    function dangerous(html: string): string[] {
        const found: string[] = [];
        const flat = html.replace(/\s+/g, ' ');
        /*
         * ★ style 속성 **안의** url(javascript:…) 는 세지 않는다.
         *   크롬·안드로이드 웹뷰는 CSS 에서 javascript: 를 실행하지 않는다(옛 IE 이야기다).
         *   진짜 위험이 아닌 것으로 빨간불이 켜지면 테스트가 무시당한다.
         *   href·src 등 **실행되는 자리**의 javascript: 는 아래에서 그대로 잡힌다.
         */
        const outsideStyle = flat.replace(/style\s*=\s*"[^"]*"/gi, 'style=""');
        if (/<script/i.test(flat)) found.push('<script>');
        if (/\son\w+\s*=/i.test(flat)) found.push('on* 핸들러');
        if (/javascript\s*:/i.test(outsideStyle)) found.push('javascript:');
        if (/vbscript\s*:/i.test(flat)) found.push('vbscript:');
        if (/data\s*:\s*text\/html/i.test(flat)) found.push('data:text/html');
        if (/<iframe|<object|<embed|<base|<form/i.test(flat)) found.push('삽입 태그');
        return found;
    }

    const VECTORS: Array<[string, string]> = [
        ['평범한 javascript:', '<a href="javascript:alert(1)">x</a>'],
        ['대소문자 섞기', '<a href="jAvAsCrIpT:alert(1)">x</a>'],
        ['탭 끼워넣기', '<a href="java&#09;script:alert(1)">x</a>'],
        ['개행 끼워넣기', '<a href="java\nscript:alert(1)">x</a>'],
        ['앞 공백', '<a href="  javascript:alert(1)">x</a>'],
        ['vbscript', '<a href="vbscript:msgbox(1)">x</a>'],
        ['data:text/html', '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
        ['img onerror', '<img src=x onerror="alert(1)">'],
        ['onclick', '<a href="#" onclick="alert(1)">x</a>'],
        ['svg script', '<svg><script>alert(1)</script></svg>'],
        [
            'svg animate href',
            '<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>',
        ],
        [
            'svg use 외부참조',
            '<svg><use href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+"/></svg>',
        ],
        ['style 안 javascript', '<div style="background:url(javascript:alert(1))">x</div>'],
        ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
        ['form action', '<form action="javascript:alert(1)"><input></form>'],
        ['base 태그', '<base href="//evil.example/">'],
        ['meta refresh', '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">'],
        [
            'mXSS (math/mglyph/style)',
            '<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>',
        ],
        ['noscript 우회', '<noscript><p title="</noscript><img src=x onerror=alert(1)>">'],
        ['srcset', '<img srcset="x.jpg 1x, javascript:alert(1) 2x">'],
    ];

    for (const [name, payload] of VECTORS) {
        it(`본문 살균 — ${name}`, () => {
            const out = sanitize(payload);
            expect(dangerous(out), `살아남았다: ${out.slice(0, 120)}`).toEqual([]);
        });
    }

    const SVG_VECTORS: Array<[string, string]> = [
        ['script', '<svg><script>alert(1)</script></svg>'],
        ['onload', '<svg onload="alert(1)"><g/></svg>'],
        [
            'foreignObject 안 img',
            '<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>',
        ],
        ['a href javascript', '<svg><a href="javascript:alert(1)"><text>x</text></a></svg>'],
        [
            'animate 로 href 바꾸기',
            '<svg><a><animate attributeName="href" to="javascript:alert(1)"/></a></svg>',
        ],
        ['style 안 @import', '<svg><style>@import url("//evil.example/x.css");</style><g/></svg>'],
        ['iframe 끼워넣기', '<svg><iframe src="javascript:alert(1)"></iframe></svg>'],
        ['handler 속성', '<svg><rect onmouseover="alert(1)" width="10" height="10"/></svg>'],
    ];

    for (const [name, payload] of SVG_VECTORS) {
        it(`다이어그램 SVG 살균 — ${name}`, () => {
            const out = sanitizeMermaidSvg(payload);
            expect(dangerous(out), `살아남았다: ${out.slice(0, 120)}`).toEqual([]);
        });
    }

    it('★ 살균해도 멀쩡한 다이어그램은 그대로다', () => {
        const svg =
            '<svg viewBox="0 0 100 50"><style>.n{fill:#eee}</style>' +
            '<g class="n"><rect width="40" height="20"/><text x="5" y="15">노드</text></g>' +
            '<path d="M0 0 L10 10" marker-end="url(#arrow)"/></svg>';
        const out = sanitizeMermaidSvg(svg);
        expect(out).toContain('<style>');
        expect(out).toContain('노드');
        expect(out).toContain('marker-end');
        expect(out).toContain('viewBox');
    });
});

describe('상대 주소 (데스크톱 전용 옵트인)', () => {
    afterEach(() => allowRelativeUrls(false));

    const rel = ['img/a.png', 'other.md', './a.md', '../a.md', 'a.md#절', '#앵커', 'a?x=1'];
    const evil = [
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        'java	script:alert(1)',
        ' javascript:alert(1)',
        'data:text/html,<script>1</script>',
        'vbscript:x',
        'file:///C:/Windows/win.ini',
        'C:\Windows\win.ini',
    ];

    it('★ 기본은 꺼져 있다 — 모바일 동작이 바뀌지 않는다', () => {
        for (const u of ['img/a.png', 'other.md']) expect(isSafeUrl(u)).toBe(false);
    });

    it('켜면 스킴 없는 주소가 통과한다', () => {
        allowRelativeUrls(true);
        for (const u of rel) expect(isSafeUrl(u), u).toBe(true);
    });

    it('★ 켜도 위험한 스킴·경로는 막는다', () => {
        allowRelativeUrls(true);
        for (const u of evil) expect(isSafeUrl(u), u).toBe(false);
    });

    it('★ 프로토콜 상대(//host)와 네트워크 경로(\\\\host)는 켜든 끄든 막는다', () => {
        // 출처를 바꾸는 주소다. 모바일에서는 원격 이미지 차단을 우회하고, 윈도우에서는 UNC 경로가 되어
        // 링크를 누르거나 그림을 그리는 것만으로 SMB 인증(NTLM 해시)이 나간다.
        const nets = [
            '//evil.example/x.png',
            '/\\evil.example/x.png',
            '\\\\evil.example\\share\\x.png',
            '\\evil.example\\x.png',
        ];
        for (const on of [false, true]) {
            allowRelativeUrls(on);
            for (const u of nets) expect(isSafeUrl(u), `${u} (옵트인 ${on})`).toBe(false);
        }
    });

    it('★ 살균기도 //host 를 지운다 — 그림 src 와 링크 href 모두', () => {
        for (const on of [false, true]) {
            allowRelativeUrls(on);
            const host = document.createElement('div');
            host.innerHTML = sanitize(
                '<p><img src="//evil.example/x.png"><a href="//evil.example/a.md">x</a>' +
                    '<a href="/\\evil.example/b.md">y</a><a href="\\\\evil.example\\s\\c.md">z</a></p>',
            );
            expect(host.querySelector('img')?.hasAttribute('src'), `img (옵트인 ${on})`).toBe(
                false,
            );
            for (const a of host.querySelectorAll('a')) {
                expect(a.hasAttribute('href'), `${a.textContent} (옵트인 ${on})`).toBe(false);
            }
        }
    });

    it('살균기도 같은 기준이다 — 그림 src 와 링크 href 가 살아남고 javascript: 는 지워진다', () => {
        allowRelativeUrls(true);
        const host = document.createElement('div');
        host.innerHTML = sanitize(
            '<p><img src="img/a.png"><a href="other.md">x</a><a href="javascript:alert(1)">y</a></p>',
        );
        expect(host.querySelector('img')?.getAttribute('src')).toBe('img/a.png');
        const links = host.querySelectorAll('a');
        expect(links[0].getAttribute('href')).toBe('other.md');
        expect(links[1].hasAttribute('href')).toBe(false);
    });

    it('끄면 상대 주소가 다시 지워진다', () => {
        const host = document.createElement('div');
        host.innerHTML = sanitize('<img src="img/a.png">');
        expect(host.querySelector('img')?.hasAttribute('src')).toBe(false);
    });
});
