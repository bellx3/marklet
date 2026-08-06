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
