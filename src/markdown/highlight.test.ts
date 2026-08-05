import { describe, it, expect, beforeEach } from 'vitest';
import { looksLikeCode, ensureHighlight, __resetHighlightForTest } from './highlight';
import { createMarkdownIt } from './renderer';

/**
 * 코드 하이라이트 지연 로드 (12-1절 번들 예산).
 *
 * ★★ 여기서 지키려는 것은 두 가지다.
 *   1) **코드 없는 문서는 hljs 를 아예 안 받는다.** 그러라고 지연으로 옮겼다.
 *      looksLikeCode 가 헛되이 true 를 돌려주면 그 22.6KB 가 통째로 헛수고다.
 *   2) **붙이는 것은 인스턴스마다.** 뷰어는 문서를 열 때마다 새 markdown-it 을 만든다 —
 *      "이미 붙였다"로 기억하면 두 번째 문서부터 색이 사라진다(math.ts 가 그 사고를 겪었다).
 */

beforeEach(() => {
    __resetHighlightForTest();
});

describe('looksLikeCode — 받을지 말지', () => {
    it('아는 언어의 코드 블록을 찾는다', () => {
        expect(looksLikeCode('본문\n\n```ts\nconst a = 1;\n```\n')).toBe(true);
        expect(looksLikeCode('```python\nprint(1)\n```')).toBe(true);
        expect(looksLikeCode('```JSON\n{}\n```')).toBe(true); // 대소문자 무시
    });

    it('별칭도 알아본다', () => {
        for (const alias of ['js', 'py', 'sh', 'zsh', 'html', 'yml', 'md']) {
            expect(looksLikeCode('```' + alias + '\nx\n```'), alias).toBe(true);
        }
    });

    it('~~~ 울타리도 받는다', () => {
        expect(looksLikeCode('~~~bash\nls\n~~~')).toBe(true);
    });

    it('```ts {1,3} 같은 꼬리표가 붙어도 알아본다', () => {
        expect(looksLikeCode('```ts {1,3}\nconst a = 1;\n```')).toBe(true);
        expect(looksLikeCode('```ts title="a.ts"\nx\n```')).toBe(true);
    });

    it('들여쓴 울타리도 찾는다 — 목록 안의 코드 블록', () => {
        expect(looksLikeCode('- 항목\n\n  ```ts\n  const a = 1;\n  ```\n')).toBe(true);
    });

    it('코드가 없으면 받지 않는다', () => {
        expect(looksLikeCode('# 제목\n\n그냥 글입니다.')).toBe(false);
        expect(looksLikeCode('')).toBe(false);
    });

    it('언어를 안 적은 블록만 있으면 받지 않는다', () => {
        // 언어가 없으면 어차피 하이라이트할 수 없다.
        expect(looksLikeCode('```\n아무 글\n```')).toBe(false);
    });

    it('모르는 언어만 있으면 받지 않는다', () => {
        expect(looksLikeCode('```brainfuck\n+++\n```')).toBe(false);
        expect(looksLikeCode('```rust\nfn main() {}\n```')).toBe(false);
    });

    it('★ mermaid 만 있는 문서는 받지 않는다', () => {
        /*
         * ★★ 다이어그램은 자기 청크(900KB)가 따로 있다. 여기서 하이라이터까지 받으면
         *   그 22.6KB 가 통째로 헛수고다. 예제 문서가 정확히 이 모양이었다.
         */
        expect(looksLikeCode('```mermaid\ngraph TD\nA-->B\n```')).toBe(false);
    });

    it('mermaid 와 코드가 함께 있으면 받는다', () => {
        expect(looksLikeCode('```mermaid\ngraph TD\n```\n\n```ts\nconst a = 1;\n```')).toBe(true);
    });

    it('본문 중간의 ``` 세 글자에 속지 않는다', () => {
        // 줄 맨 앞이 아니면 울타리가 아니다.
        expect(looksLikeCode('설명에서 ```ts 라고 쓰는 법을 알려 줍니다.')).toBe(false);
    });
});

describe('ensureHighlight — 붙이기', () => {
    it('★ 붙이기 전에는 highlight 가 없다', () => {
        const md = createMarkdownIt({ breaks: true });
        /*
         * ★★ 생성자에서 highlight 를 걸면 그 순간 hljs 가 초기 번들로 딸려 온다.
         *   이 테스트가 그걸 막는다 — 무심코 되돌리면 여기서 걸린다.
         */
        expect(md.options.highlight).toBeFalsy();
    });

    it('붙이면 코드에 색이 들어간다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);

        const html = md.render('```ts\nconst a: number = 1;\n```');
        expect(html).toContain('hljs-keyword');
        expect(html).toContain('const');
    });

    it('★ 인스턴스마다 다시 붙는다', async () => {
        const first = createMarkdownIt({ breaks: true });
        await ensureHighlight(first);
        expect(first.render('```ts\nconst a = 1;\n```')).toContain('hljs-');

        /*
         * ★★ 뷰어는 문서를 열 때마다 **새 markdown-it 을 만든다**(설정이 파서에 들어간다).
         *   "이미 붙였다"로 기억하면 두 번째 문서부터 색이 사라진다.
         *   math.ts 가 정확히 그 사고를 겪었다(v1.0.3).
         */
        const second = createMarkdownIt({ breaks: true });
        await ensureHighlight(second);
        expect(second.render('```ts\nconst a = 1;\n```')).toContain('hljs-');
    });

    it('두 번 불러도 터지지 않는다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);
        await expect(ensureHighlight(md)).resolves.toBeUndefined();
        expect(md.render('```ts\nconst a = 1;\n```')).toContain('hljs-');
    });

    it('동시에 불러도 한 번만 받는다', async () => {
        const a = createMarkdownIt({ breaks: true });
        const b = createMarkdownIt({ breaks: true });
        await Promise.all([ensureHighlight(a), ensureHighlight(b)]);

        expect(a.render('```ts\nconst x = 1;\n```')).toContain('hljs-');
        expect(b.render('```ts\nconst x = 1;\n```')).toContain('hljs-');
    });

    it('★ 모르는 언어는 색 없이 평문으로 — 깨지지 않는다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);

        const html = md.render('```brainfuck\n+++[->+++<]\n```');
        expect(html).not.toContain('hljs-');
        expect(html).toContain('+++[-&gt;+++&lt;]'); // 이스케이프는 markdown-it 이 한다
    });

    it('★ mermaid 블록은 평문으로 남는다 — 그 뒤 단계가 SVG 로 바꾼다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);

        const html = md.render('```mermaid\ngraph TD\nA-->B\n```');
        expect(html).not.toContain('hljs-');
        expect(html).toContain('graph TD');
    });

    it('언어를 안 적으면 이스케이프된 평문이다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);

        const html = md.render('```\n<script>alert(1)</script>\n```');
        expect(html).toContain('&lt;script&gt;');
        expect(html).not.toContain('<script>');
    });

    it('★ 문법이 깨진 코드에도 문서를 죽이지 않는다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);

        // ignoreIllegals 가 없으면 여기서 던지고 문서 전체가 안 그려진다.
        expect(() => md.render('```json\n{ 이건 JSON 이 아니다 " " " }\n```')).not.toThrow();
    });

    it('꼬리표가 붙은 언어도 색이 들어간다', async () => {
        const md = createMarkdownIt({ breaks: true });
        await ensureHighlight(md);
        expect(md.render('```ts {1,3}\nconst a = 1;\n```')).toContain('hljs-');
    });
});
