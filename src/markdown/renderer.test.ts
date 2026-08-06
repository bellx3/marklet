import { describe, it, expect } from 'vitest';
import { createMarkdownIt, slugify, unwrapPlugin } from './renderer';

const TASKS = '- [x] 완료\n- [ ] 미완\n';

/**
 * ★★★ 2026-08-06. markdown-it-task-lists 는 옵션을 **모듈 전역**에 담는다
 *   (index.js 6행 `var disableCheckboxes = true`). 렌더할 때 그 전역을 읽으므로
 *   나중에 만든 인스턴스의 옵션이 **먼저 만들어 둔 인스턴스까지 바꿔 버린다.**
 *
 *   뷰어에서 체크박스가 눌리게 되면 사용자는 표시가 저장된 줄 알지만
 *   아무 데도 남지 않는다 — 되돌릴 수 없는 종류의 오해다.
 *
 *   지금은 두 호출부가 다 false 라서 겉으로 드러나지 않았다. 즉 **터지기를
 *   기다리던 함정**이었고, 밟는 순간의 증상이 "가끔 눌린다"라 찾기도 어렵다.
 */
describe('★★ 체크박스 잠금은 인스턴스마다 따로 간다', () => {
    it('뷰어는 체크박스가 잠겨 있다', () => {
        const html = createMarkdownIt({ breaks: true }).render(TASKS);
        expect(html).toContain('disabled');
        expect(html).not.toContain('task-list-item enabled');
    });

    it('편집기는 체크박스를 누를 수 있다', () => {
        const html = createMarkdownIt({ breaks: true, taskListsEnabled: true }).render(TASKS);
        expect(html).not.toContain('disabled');
        expect(html).toContain('task-list-item enabled');
    });

    /*
     * ★ 이 테스트가 그 함정을 잡는다. createMarkdownIt 안에서 플러그인에
     *   `enabled: opts.taskListsEnabled` 를 그대로 넘기도록 되돌리면 여기서 깨진다.
     */
    it('★ 편집기 인스턴스를 만든 뒤에도 뷰어 인스턴스는 잠긴 채다', () => {
        const viewer = createMarkdownIt({ breaks: true });
        expect(viewer.render(TASKS), '만들자마자').toContain('disabled');

        createMarkdownIt({ breaks: true, taskListsEnabled: true }); // 만들기만 한다

        expect(viewer.render(TASKS), '편집기를 만든 뒤').toContain('disabled');
    });

    it('★ 뷰어 인스턴스를 만든 뒤에도 편집기 인스턴스는 눌린다 (반대 방향)', () => {
        const editor = createMarkdownIt({ breaks: true, taskListsEnabled: true });
        expect(editor.render(TASKS)).not.toContain('disabled');

        createMarkdownIt({ breaks: true });

        expect(editor.render(TASKS), '뷰어를 만든 뒤').not.toContain('disabled');
    });

    it('체크 상태 자체는 어느 쪽이든 그대로다', () => {
        for (const taskListsEnabled of [false, true]) {
            const html = createMarkdownIt({ breaks: true, taskListsEnabled }).render(TASKS);
            expect(html.match(/checked/g)?.length, String(taskListsEnabled)).toBe(1);
        }
    });
});

describe('slugify — 한글 헤딩을 살린다', () => {
    it('한글이 물음표로 뭉개지지 않는다', () => {
        expect(decodeURIComponent(slugify('설치 방법'))).toBe('설치-방법');
    });

    it('문장 부호를 걷어낸다', () => {
        expect(decodeURIComponent(slugify('3.2 절차 (중요!)'))).toBe('32-절차-중요');
    });

    it('★ 같은 제목이 여러 번 나와도 앵커가 갈린다', () => {
        const html = createMarkdownIt({ breaks: true }).render(
            '### 예시\n\n### 예시\n\n### 예시\n',
        );
        const ids = [...html.matchAll(/<h3 id="([^"]*)"/g)].map((m) => m[1]);
        expect(new Set(ids).size, `겹쳤다: ${ids.join(', ')}`).toBe(3);
    });

    it('★ 같은 문서를 다시 렌더해도 앵커가 흔들리지 않는다', () => {
        // 인스턴스를 새로 만드는 경로(보기 설정 변경·재진입)에서 목차 링크가 어긋나면 안 된다.
        const src = '## 개요\n\n### 예시\n\n### 예시\n';
        const first = createMarkdownIt({ breaks: true }).render(src);
        const second = createMarkdownIt({ breaks: true }).render(src);
        expect(second).toBe(first);
    });
});

describe('unwrapPlugin — CJS/ESM 상호운용', () => {
    const fn = (): void => {};
    it.each([
        ['함수 그대로', fn],
        ['{default:fn}', { default: fn }],
        ['{default:{default:fn}}', { default: { default: fn } }],
    ])('%s → 함수를 꺼낸다', (_name, mod) => {
        expect(unwrapPlugin(mod)).toBe(fn);
    });
});

describe('안전 기본값', () => {
    it('★ html:false 다 — 문서 안의 날 HTML 은 1차 방어선에서 막힌다', () => {
        const html = createMarkdownIt({ breaks: true }).render('<script>alert(1)</script>\n');
        expect(html).not.toContain('<script>');
    });

    /*
     * ★ 문자열로 'capacitor://' 를 찾으면 안 된다. 링크가 거부되면 markdown-it 은
     *   `[x](capacitor://…)` 를 **글자 그대로** 남기므로 그 문자열은 어차피 있다.
     *   봐야 하는 건 `<a href>` 가 만들어졌는지다.
     */
    it.each(['capacitor://localhost/y', 'javascript:alert(1)', 'file:///sdcard/x.md'])(
        '★ validateLink 가 덮여 있다 — %s 는 링크가 되지 않는다',
        (url) => {
            const host = document.createElement('div');
            host.innerHTML = createMarkdownIt({ breaks: true }).render(`[x](${url})\n`);
            expect(host.querySelector('a')).toBeNull();
        },
    );

    it('멀쩡한 주소는 링크가 된다 (위 검사가 전부를 막는 게 아니다)', () => {
        const host = document.createElement('div');
        host.innerHTML = createMarkdownIt({ breaks: true }).render('[x](https://example.com)\n');
        expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    });

    it('breaks 설정이 <br> 로 이어진다', () => {
        expect(createMarkdownIt({ breaks: true }).render('가\n나\n')).toContain('<br>');
        expect(createMarkdownIt({ breaks: false }).render('가\n나\n')).not.toContain('<br>');
    });
});

/**
 * ★★★ 2026-08-06. **제목이 겹치면 파싱이 제곱으로 늘었다.**
 *
 *   markdown-it-anchor 9.2.1 은 겹칠 때마다 1부터 다시 훑는다:
 *       for (; hasOwnProperty(slugs, a); ) { a = base + '-' + i; i += 1; }
 *   같은 제목이 N 개면 N 번째가 N 번 도니까 N² 이다.
 *
 *   실측 (`## a` 반복, 데스크톱 크로뮴):
 *        1,000개   6KB     28ms
 *        4,000개  23KB    473ms
 *       16,000개  94KB  8,876ms   → 고친 뒤 99ms (90배)
 *   2MB 면 35만 개라 한 시간이 넘는다.
 *
 *   ★★ 그리고 **94KB 는 어떤 안내도 안 뜨는 크기다.** 진행 표시는 512KB,
 *     확인 상자는 2MB 부터다. 남이 보낸 문서를 여는 앱에서 100KB 짜리 파일 하나가
 *     화면을 수십 초 얼린다 — YAML 폭탄과 같은 자리다.
 */
describe('★★ 겹치는 제목 — 번호를 O(1) 로 매긴다', () => {
    it('★ id 가 예전과 똑같다 (목차·문서 안 링크가 그대로 동작해야 한다)', () => {
        const html = createMarkdownIt({ breaks: true }).render(
            '### 예시\n\n### 예시\n\n### 예시\n\n## 개요\n\n## 개요\n',
        );
        const ids = [...html.matchAll(/<h\d id="([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
        expect(ids).toEqual(['예시', '예시-1', '예시-2', '개요', '개요-1']);
    });

    it('문서마다 번호가 처음부터 다시 시작한다', () => {
        // ★ 세는 표를 모듈 전역에 두면 두 번째 문서의 링크가 어긋난다.
        const md = createMarkdownIt({ breaks: true });
        const src = '## 개요\n\n## 개요\n';
        expect(md.render(src)).toBe(md.render(src));
    });

    it('만든 번호가 진짜 제목과 겹쳐도 id 는 여전히 갈린다', () => {
        const html = createMarkdownIt({ breaks: true }).render('## 가\n\n## 가\n\n## 가-1\n');
        const ids = [...html.matchAll(/<h\d id="([^"]*)"/g)].map((m) => decodeURIComponent(m[1]));
        expect(new Set(ids).size, `겹쳤다: ${ids.join(', ')}`).toBe(3);
    });

    /*
     * ★ 시간을 재는 테스트다. 기기마다 달라지므로 **아주 헐겁게** 잡았다 —
     *   고친 쪽은 여유가 30배 남고, 되돌리면 3배 넘게 초과한다.
     *   (되돌려서 8.9초가 나오는 것을 확인했다.)
     */
    it('★ 같은 제목 16,000개가 몇 초씩 걸리지 않는다', () => {
        const md = createMarkdownIt({ breaks: true });
        const t0 = performance.now();
        md.parse('## a\n\n'.repeat(16_000), {});
        const ms = performance.now() - t0;
        expect(ms, `${Math.round(ms)}ms 걸렸다 — 제곱으로 도는지 보라`).toBeLessThan(3000);
    });

    it('제목이 다 다를 때와 시간 차가 크지 않다', () => {
        const 재기 = (f: (i: number) => string) => {
            const src = Array.from({ length: 8000 }, (_, i) => `## ${f(i)}\n`).join('\n');
            const t0 = performance.now();
            createMarkdownIt({ breaks: true }).parse(src, {});
            return performance.now() - t0;
        };
        const 다름 = 재기((i) => `제목 ${i}`);
        const 같음 = 재기(() => '제목');
        // 제곱이면 수십 배가 난다. 넉넉히 10배로 잡는다.
        expect(같음, `다름 ${Math.round(다름)}ms · 같음 ${Math.round(같음)}ms`).toBeLessThan(
            Math.max(다름, 20) * 10,
        );
    });
});
