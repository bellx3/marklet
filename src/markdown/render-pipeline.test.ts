import { describe, it, expect } from 'vitest';
import { createMarkdownIt } from './renderer';
import { sliceTokens, renderProgressive, extractHeadings } from './render-pipeline';
import { sanitize } from './sanitize';
import { liftTaskCheckedState } from './post-process';
import { getSamples, clearSamples } from '../utils/perf';

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

/**
 * ★★★ 2026-08-06. **빈 문서에서 렌더가 터졌다.**
 *
 *   sliceTokens 가 빈 배열을 돌려주면 renderProgressive 의 `renderRange(0)` 이
 *   `ranges[0]` 을 구조 분해하다 터진다:
 *       TypeError: undefined is not iterable
 *
 *   그런 문서는 드물지 않다 — **0바이트 파일**, 공백만 있는 파일,
 *   **frontmatter 만 있는 파일**(옵시디언 템플릿·메타데이터 노트)이 전부 여기다.
 *
 *   ★ 뷰어에 try/catch 폴백이 있어 화면이 죽지는 않았다. 하지만 그 그물은
 *     **예상 못 한 렌더 실패**를 위한 것이다. 정상 입력이 거기로 떨어지면
 *     "렌더 실패" 가 로그에 찍히고 원문 보기 경로로 그려진다 —
 *     진짜 사고가 났을 때 그 로그를 믿을 수 없게 된다.
 */
describe('★★ 내용이 없는 문서', () => {
    it('★ sliceTokens 는 토큰이 없어도 범위 하나를 준다', () => {
        expect(sliceTokens([])).toEqual([[0, 0]]);
    });

    it.each([
        ['완전히 빈 문서', ''],
        ['공백만', '   \n\n  \t\n'],
        ['개행 하나', '\n'],
        ['frontmatter 를 걷어내고 남은 것이 없음', ''],
    ])('%s — 터지지 않는다', (_이름, src) => {
        const md = createMarkdownIt({ breaks: true });
        const host = document.createElement('div');
        expect(() => renderProgressive(md, src, host)).not.toThrow();
        expect(host.querySelectorAll('.md-chunk').length, '청크가 하나는 있어야 한다').toBe(1);
        expect(host.textContent).toBe('');
    });

    it('평범한 문서는 그대로다 (빈 범위가 끼어들지 않는다)', () => {
        const md = createMarkdownIt({ breaks: true });
        const host = document.createElement('div');
        renderProgressive(md, '# 제목\n\n본문입니다.\n', host);
        expect(host.textContent).toContain('제목');
        expect(host.textContent).toContain('본문입니다');
        expect(host.querySelectorAll('.md-chunk').length).toBe(1);
    });
});

/**
 * 멈춤 측정이 **첫 청크와 단일 청크에서도 돈다** (2026-08-07).
 *
 * ★★★ 예전에는 appendedAt 을 루프 안에서만 세웠다. 그래서 0번 청크 —
 *   문서를 여는 순간 동기로 붙는, 사용자가 제일 크게 느끼는 그 청크 — 의 멈춤이
 *   한 번도 안 잡혔고, 청크가 하나뿐인 문서는 **기록 자체가 없었다.**
 *
 *   실기기에서 600KB 를 문단 두 개로만 담은 문서(줄바꿈 없는 긴 글)를 열었더니
 *   화면이 729ms 멎었는데 진단에는 chunk-max 50.3ms 만 남았다. 그 지표가
 *   존재하는 이유가 바로 그 차이(브라우저 레이아웃)인데 가장 심한 경우에 침묵했다.
 */
describe('★★ 멈춤 기록이 침묵하지 않는다', () => {
    it('청크가 하나뿐인 문서도 doc:chunk-stall-max 를 남긴다', async () => {
        clearSamples();
        const md = createMarkdownIt({ breaks: false });
        const container = document.createElement('div');
        // 토큰이 몇 개 안 되는 문서 — sliceTokens 가 범위 하나만 만든다.
        const handle = renderProgressive(md, '# 제목\n\n짧은 한 문단.\n', container);
        await handle.complete;

        const 이름들 = getSamples().map((s) => s.name);
        expect(이름들, 'doc:chunk-stall-max 가 아예 없다').toContain('doc:chunk-stall-max');
    });

    it('여러 청크 문서에서도 그대로 남는다 (규칙이 과하지 않다)', async () => {
        clearSamples();
        const md = createMarkdownIt({ breaks: false });
        const container = document.createElement('div');
        const 긴글 = Array.from({ length: 400 }, (_, i) => `## 절 ${i}\n\n본문 ${i}.\n`).join('\n');
        const handle = renderProgressive(md, 긴글, container);
        await handle.complete;

        const 이름들 = getSamples().map((s) => s.name);
        expect(이름들).toContain('doc:chunk-stall-max');
        expect(이름들).toContain('doc:chunk-max');
    });
});

/**
 * 양보는 **프레임이 끝난 뒤에** 돌아와야 한다 (2026-08-07 LG Q7 실측).
 *
 * ★★★ requestAnimationFrame 콜백은 프레임의 맨 앞, 레이아웃 **이전에** 불린다.
 *   거기서 양보를 끝내면 두 가지가 한꺼번에 어긋난다 —
 *     ① 멈춤 측정이 브라우저가 일을 **시작하기도 전**의 시각을 찍는다
 *        (20만 자 문단: rAF 까지 5ms, 프레임 완료까지 532ms — 100배 축소 보고)
 *     ② 다음 청크를 앞 청크가 배치되지도 않은 상태에서 밀어 넣는다
 *   rAF 뒤에 태스크를 하나 더 태워야 프레임이 커밋된 뒤에 돌아온다.
 */
describe('★★ 양보 시점', () => {
    it('rAF 콜백만으로는 다음 청크가 붙지 않는다', async () => {
        const 잡힌rAF: FrameRequestCallback[] = [];
        const 원래 = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
            잡힌rAF.push(cb);
            return 1;
        }) as typeof requestAnimationFrame;

        try {
            const md = createMarkdownIt({ breaks: false });
            const container = document.createElement('div');
            // 청크가 여러 개 나오도록 넉넉히
            const 긴글 = Array.from({ length: 600 }, (_, i) => `## 절 ${i}\n\n본문 ${i}.\n`).join(
                '\n',
            );
            renderProgressive(md, 긴글, container);

            expect(container.querySelectorAll('.md-chunk').length, '0번은 동기로 붙는다').toBe(1);

            // 프레임이 시작됐다고만 알린다(레이아웃 전 시점).
            await Promise.resolve();
            for (const cb of 잡힌rAF.splice(0)) cb(0);
            await Promise.resolve();
            await Promise.resolve();

            expect(
                container.querySelectorAll('.md-chunk').length,
                'rAF 콜백만으로 다음 청크를 붙였다 — 앞 청크는 아직 배치도 안 됐다',
            ).toBe(1);
        } finally {
            globalThis.requestAnimationFrame = 원래;
        }
    });
});
