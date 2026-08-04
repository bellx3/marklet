import { describe, it, expect, vi } from 'vitest';
import { t } from '../i18n';
import { createMarkdownIt } from './renderer';
import { liftTaskCheckedState, wrapTables, applyImagePolicy } from './post-process';

vi.mock('../services/settings', () => ({
    getSettings: () => mockSettings,
}));
let mockSettings = { remoteImages: false };

/**
 * 11-2절 #5 · #6.
 *
 * ★ 손으로 쓴 HTML 로 테스트하지 마라. 플러그인 출력이 바뀌어도 통과해 버린다.
 *   여기서는 **실제 markdown-it 출력**에 적용한다(11-1절 1번).
 */

function render(src: string): string {
    return createMarkdownIt({ breaks: true }).render(src);
}

describe('liftTaskCheckedState — 실제 markdown-it 출력에 적용', () => {
    it('체크된 항목에만 .checked 가 붙는다', () => {
        const html = liftTaskCheckedState(render('- [x] 완료\n- [ ] 미완료\n'));
        const host = document.createElement('div');
        host.innerHTML = html;
        const items = host.querySelectorAll('li.task-list-item');
        expect(items.length).toBe(2);
        expect(items[0].classList.contains('checked')).toBe(true);
        expect(items[1].classList.contains('checked')).toBe(false);
    });

    it('대문자 [X] 도 처리한다', () => {
        const html = liftTaskCheckedState(render('- [X] 대문자\n'));
        expect(html).toMatch(/task-list-item[^"]*\bchecked\b/);
    });

    it('일반 목록은 건드리지 않는다', () => {
        const before = render('- 그냥 목록\n');
        expect(liftTaskCheckedState(before)).toBe(before);
    });

    it('여러 개가 섞여 있어도 각각 맞게 붙는다', () => {
        const host = document.createElement('div');
        host.innerHTML = liftTaskCheckedState(render('- [ ] 하나\n- [x] 둘\n- [ ] 셋\n- [x] 넷\n'));
        const checked = Array.from(host.querySelectorAll('li.task-list-item')).map((li) =>
            li.classList.contains('checked'),
        );
        expect(checked).toEqual([false, true, false, true]);
    });
});

describe('wrapTables', () => {
    function section(src: string): HTMLElement {
        const el = document.createElement('section');
        el.innerHTML = render(src);
        return el;
    }

    const TABLE = '| a | b |\n|---|---|\n| 1 | 2 |\n';

    it('표를 .table-scroll 로 감싸고 접근성 속성을 붙인다', () => {
        const el = section(TABLE);
        wrapTables(el);
        const wrap = el.querySelector('.table-scroll') as HTMLElement;
        expect(wrap).not.toBeNull();
        expect(wrap.getAttribute('role')).toBe('region');
        expect(wrap.tabIndex).toBe(0);
        expect(wrap.getAttribute('aria-label')).toBe(t.content.tableScrollable);
        expect(wrap.querySelector('table')).not.toBeNull();
    });

    it('두 번 불러도 중복 래핑되지 않는다', () => {
        const el = section(TABLE);
        wrapTables(el);
        wrapTables(el);
        expect(el.querySelectorAll('.table-scroll').length).toBe(1);
    });

    it('표가 여러 개면 각각 감싼다', () => {
        const el = section(`${TABLE}\n문단\n\n${TABLE}`);
        wrapTables(el);
        expect(el.querySelectorAll('.table-scroll').length).toBe(2);
    });
});

describe('applyImagePolicy — 사생활 기본값', () => {
    function section(src: string): HTMLElement {
        const el = document.createElement('section');
        el.innerHTML = render(src);
        return el;
    }

    it('설정이 꺼져 있으면 원격 이미지의 src 를 떼고 자리표시자로 바꾼다', () => {
        mockSettings = { remoteImages: false };
        const el = section('![고양이](https://example.com/cat.png)');
        applyImagePolicy(el);
        expect(el.querySelector('img')).toBeNull();
        const btn = el.querySelector('button.md-image-placeholder');
        expect(btn).not.toBeNull();
        expect(btn?.textContent).toContain('고양이');
    });

    it('상대 경로 이미지는 그대로 둔다 (외부 요청이 아니다)', () => {
        mockSettings = { remoteImages: false };
        const el = section('![로컬](./local.png)');
        applyImagePolicy(el);
        expect(el.querySelector('img')).not.toBeNull();
    });

    it('설정이 켜져 있으면 아무것도 하지 않는다', () => {
        mockSettings = { remoteImages: true };
        const el = section('![고양이](https://example.com/cat.png)');
        applyImagePolicy(el);
        expect(el.querySelector('img')).not.toBeNull();
    });

    it('자리표시자를 누르면 그때 src 가 붙는다', () => {
        mockSettings = { remoteImages: false };
        const el = section('![고양이](https://example.com/cat.png)');
        applyImagePolicy(el);
        el.querySelector<HTMLButtonElement>('button.md-image-placeholder')!.click();
        expect(el.querySelector('img')?.getAttribute('src')).toBe('https://example.com/cat.png');
    });
});
