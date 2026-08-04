import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from './renderer';
import { sliceTokens, renderProgressive, extractHeadings } from './render-pipeline';
import { sanitize } from './sanitize';
import { liftTaskCheckedState } from './post-process';

/**
 * 11-2절 #3 · #4.
 *
 * ★ markdown-it 은 목으로 만들지 않는다. 실제로 돌린다(11-1절 1번).
 */

const MIXED = [
    '# 제목',
    '',
    '- 목록',
    '  - 중첩',
    '    - 더 중첩',
    '      1. 번호',
    '      2. 번호',
    '',
    '> 인용',
    '> > 중첩 인용',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '```js',
    'const x = 1;',
    '```',
    '',
    '문단입니다. **굵게** 그리고 `코드`.',
].join('\n');

function bigDoc(): string {
    const filler = Array.from({ length: 200 }, (_, i) => `문단 ${i} 입니다.\n`).join('\n');
    return `참조 링크는 [여기][ref]. 각주는 여기[^fn].\n\n${filler}\n[ref]: https://example.com\n[^fn]: 각주 내용\n`;
}

describe('sliceTokens', () => {
    it('nesting 이 0 인 지점에서만 자른다 (태그가 쪼개지지 않는다)', () => {
        const md = createMarkdownIt({ breaks: true });
        const tokens = md.parse(MIXED.repeat(6), {});
        const ranges = sliceTokens(tokens, 20);
        expect(ranges.length).toBeGreaterThan(1);

        for (const [a, b] of ranges) {
            let depth = 0;
            for (let i = a; i < b; i++) depth += tokens[i].nesting;
            expect(depth).toBe(0); // 구간마다 여닫이가 맞는다
        }
        // 구간이 빈틈없이 이어진다
        expect(ranges[0][0]).toBe(0);
        expect(ranges[ranges.length - 1][1]).toBe(tokens.length);
        for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1]);
    });

    it('청크를 이어붙인 HTML 이 한 번에 렌더한 HTML 과 같다', () => {
        const md = createMarkdownIt({ breaks: true });
        const source = MIXED.repeat(4);
        const env: Record<string, unknown> = {};
        const tokens = md.parse(source, env);

        const whole = md.renderer.render(tokens, md.options, env);
        const joined = sliceTokens(tokens, 15)
            .map(([a, b]) => md.renderer.render(tokens.slice(a, b), md.options, env))
            .join('');

        expect(joined).toBe(whole);
    });
});

describe('renderProgressive', () => {
    it('★ 각주·참조 링크가 문단 200개 뒤에 있어도 연결된다 (소스 분할로 되돌리면 실패한다)', async () => {
        const md = createMarkdownIt({ breaks: true });
        const container = document.createElement('div');
        const handle = renderProgressive(md, bigDoc(), container);
        await handle.renderRest();

        // 참조 링크
        const link = container.querySelector('a[href="https://example.com"]');
        expect(link).not.toBeNull();
        // 각주 — 본문 앵커와 아래 정의가 둘 다 생겼다
        expect(container.querySelector('.footnote-ref')).not.toBeNull();
        expect(container.querySelector('.footnotes')).not.toBeNull();
    });

    it('cancel() 뒤에는 청크가 더 붙지 않는다', async () => {
        const md = createMarkdownIt({ breaks: true });
        const container = document.createElement('div');
        const handle = renderProgressive(md, MIXED.repeat(30), container);
        const afterFirst = container.children.length;
        handle.cancel();
        await handle.complete;
        expect(container.children.length).toBe(afterFirst);
    });

    /*
     * 회귀: loop 의 `if (cancelled || next >= ranges.length) break;` 에서
     *   `|| next >= ranges.length` 를 지우면 이 테스트가 실패(시간 초과)하는 것을 확인함.
     *
     * 배경 루프가 yieldToBrowser() 에서 기다리는 동안 renderRest() 가 next 를 끝까지
     * 올려놓으면, 깨어난 루프가 ranges[next] === undefined 로 터진다.
     * 그러면 resolveComplete() 에 도달하지 못해 complete 가 영영 resolve 되지 않는다.
     * 실제 경로: 큰 문서를 열자마자 목차·검색을 누르는 것.
     */
    it('★ renderRest() 가 배경 루프와 겹쳐도 터지지 않는다 (경합 회귀)', async () => {
        const md = createMarkdownIt({ breaks: true });
        const container = document.createElement('div');
        // renderProgressive 가 돌아온 시점에 loop 는 이미 첫 await 에서 대기 중이다.
        const handle = renderProgressive(md, MIXED.repeat(40), container);
        await handle.renderRest(); // 여기서 next 가 끝까지 간다

        const settled = await Promise.race([
            handle.complete.then(() => 'ok'),
            new Promise((r) => setTimeout(() => r('timeout'), 1000)),
        ]);
        expect(settled).toBe('ok');
        expect(container.children.length).toBeGreaterThan(1);
    });

    it('renderRest() 는 남은 청크를 전부 붙인다 (목차·검색의 전제)', async () => {
        const md = createMarkdownIt({ breaks: true });
        const container = document.createElement('div');
        const source = `${MIXED.repeat(20)}\n\n## 맨 끝 제목\n`;
        const handle = renderProgressive(md, source, container);
        await handle.renderRest();
        const ids = handle.headings.map((h) => h.id);
        expect(ids.length).toBeGreaterThan(0);
        const last = handle.headings[handle.headings.length - 1];
        expect(container.querySelector(`#${CSS.escape(last.id)}`)).not.toBeNull();
    });
});

describe('extractHeadings', () => {
    it('레벨·본문·id 를 토큰에서 뽑는다', () => {
        const md = createMarkdownIt({ breaks: true });
        const tokens = md.parse('# 하나\n\n## 둘\n\n### 셋\n', {});
        const hs = extractHeadings(tokens);
        expect(hs.map((h) => h.level)).toEqual([1, 2, 3]);
        expect(hs.map((h) => h.text)).toEqual(['하나', '둘', '셋']);
        expect(hs.every((h) => h.id.length > 0)).toBe(true);
    });
});

describe('살균 후에도 구조가 남는다', () => {
    it('체크박스 상태가 클래스로 옮겨진 뒤 DOMPurify 를 통과한다', () => {
        const md = createMarkdownIt({ breaks: true });
        const raw = md.render('- [x] 완료\n- [ ] 미완료\n');
        const host = document.createElement('div');
        host.innerHTML = sanitize(liftTaskCheckedState(raw));
        expect(host.querySelectorAll('li.task-list-item').length).toBe(2);
        expect(host.querySelectorAll('li.checked').length).toBe(1);
        // <input> 은 살균기가 지운다 — 그래서 상태를 미리 클래스로 옮겼다
        expect(host.querySelector('input')).toBeNull();
    });
});
