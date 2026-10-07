import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTocDock, type TocDock } from './toc-dock';
import type { Heading } from '../markdown/render-pipeline';

/**
 * 목차 도크.
 *
 * 지키려는 것: ① 제목이 있을 때만 열린다 ② 열리면 문서가 밀려난다(host 의 has-toc)
 * ③ 항목을 누르면 그 제목으로 간다 ④ 키보드 순회(Tab)에 끼지 않는다.
 */

const H: Heading[] = [
    { level: 1, text: '개요', id: 'a', line: 1 },
    { level: 2, text: '설치', id: 'b', line: 5 },
    { level: 3, text: '옵션', id: 'c', line: 9 },
];

let host: HTMLElement;
let container: HTMLElement;
let jumped: string[];
let dock: TocDock;

beforeEach(() => {
    // rAF 를 즉시 돌려 resize 알림과 위치 추적을 동기로 본다
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 1;
    });
    document.body.innerHTML = '<div id="host"><div id="doc"></div></div>';
    host = document.getElementById('host')!;
    container = document.getElementById('doc')!;
    jumped = [];
    dock = createTocDock({ host, container, onJump: (id) => jumped.push(id) });
    host.appendChild(dock.root);
    // jsdom 은 scrollIntoView 가 없다
    Element.prototype.scrollIntoView = vi.fn();
});

describe('열고 닫기', () => {
    it('★ 제목이 없으면 열리지 않는다 — 빈 도크 대신 안내 모달을 쓰는 것은 부르는 쪽이다', () => {
        dock.setHeadings([]);
        dock.open();
        expect(dock.isOpen).toBe(false);
        expect(host.classList.contains('has-toc')).toBe(false);
    });

    it('열면 보이고 문서 쪽에 has-toc 가 붙는다 (문서를 옆으로 민다)', () => {
        dock.setHeadings(H);
        dock.open();
        expect(dock.isOpen).toBe(true);
        expect(dock.root.hidden).toBe(false);
        expect(host.classList.contains('has-toc')).toBe(true);
    });

    it('toggle 로 열고 닫는다', () => {
        dock.setHeadings(H);
        dock.toggle();
        expect(dock.isOpen).toBe(true);
        dock.toggle();
        expect(dock.isOpen).toBe(false);
        expect(host.classList.contains('has-toc')).toBe(false);
    });

    it('닫기 버튼으로 닫힌다', () => {
        dock.setHeadings(H);
        dock.open();
        dock.root.querySelector<HTMLButtonElement>('.toc-dock-head button')!.click();
        expect(dock.isOpen).toBe(false);
    });

    it('★ 열려 있는 동안 제목이 사라지면(다른 문서·서식 없는 보기) 스스로 닫힌다', () => {
        dock.setHeadings(H);
        dock.open();
        dock.setHeadings([]);
        expect(dock.isOpen).toBe(false);
        expect(host.classList.contains('has-toc')).toBe(false);
    });

    it('편집처럼 문서가 가려지는 동안 접었다가 열림 상태를 돌려준다', () => {
        dock.setHeadings(H);
        dock.open();

        dock.suspend(true);
        expect(host.classList.contains('has-toc')).toBe(false);
        expect(dock.root.hidden).toBe(true);
        expect(dock.isOpen).toBe(true);

        dock.suspend(false);
        expect(host.classList.contains('has-toc')).toBe(true);
        expect(dock.root.hidden).toBe(false);
    });

    it('열고 닫을 때 resize 를 알린다 — 표·수식 폭 맞춤이 새 폭으로 다시 잰다', () => {
        const onResize = vi.fn();
        window.addEventListener('resize', onResize);
        dock.setHeadings(H);
        dock.open();
        dock.close();
        window.removeEventListener('resize', onResize);
        expect(onResize).toHaveBeenCalledTimes(2);
    });
});

describe('항목', () => {
    it('제목 수만큼 항목이 있고 단계가 data-level 로 남는다', () => {
        dock.setHeadings(H);
        const items = [...dock.root.querySelectorAll<HTMLButtonElement>('.toc-dock-item')];
        expect(items.map((b) => b.textContent)).toEqual(['개요', '설치', '옵션']);
        expect(items.map((b) => b.dataset.level)).toEqual(['1', '2', '3']);
    });

    it('누르면 그 제목의 id 로 이동을 요청한다', () => {
        dock.setHeadings(H);
        dock.open();
        dock.root.querySelectorAll<HTMLButtonElement>('.toc-dock-item')[1].click();
        expect(jumped).toEqual(['b']);
    });

    it('★ 항목과 닫기 버튼 모두 Tab 순회에 끼지 않는다', () => {
        dock.setHeadings(H);
        for (const b of dock.root.querySelectorAll('button')) {
            expect((b as HTMLButtonElement).tabIndex, b.textContent ?? 'close').toBe(-1);
        }
    });

    it('제목 글이 비어 있으면 (제목 없음) 으로 보인다', () => {
        dock.setHeadings([{ level: 1, text: '', id: 'x', line: 1 }]);
        expect(dock.root.querySelector('.toc-dock-item')!.textContent).not.toBe('');
    });
});

describe('지금 읽는 절', () => {
    function place(id: string, top: number) {
        const el = document.createElement('h2');
        el.id = id;
        el.getBoundingClientRect = () => ({ top }) as DOMRect;
        container.appendChild(el);
    }

    it('읽는 선(위에서 120px) 위로 올라간 마지막 제목이 현재 절이다', () => {
        place('a', -400);
        place('b', 50);
        place('c', 600);
        dock.setHeadings(H);
        dock.open();

        const active = dock.root.querySelector('.toc-dock-item.is-active');
        expect(active?.textContent).toBe('설치');
        expect(active?.getAttribute('aria-current')).toBe('location');
    });

    it('스크롤하면 따라간다', () => {
        place('a', -400);
        place('b', 600);
        dock.setHeadings(H);
        dock.open();
        expect(dock.root.querySelector('.toc-dock-item.is-active')?.textContent).toBe('개요');

        container.querySelector<HTMLElement>('#b')!.getBoundingClientRect = () =>
            ({ top: 10 }) as DOMRect;
        window.dispatchEvent(new Event('scroll'));
        expect(dock.root.querySelector('.toc-dock-item.is-active')?.textContent).toBe('설치');
        // 한 번에 하나만 표시된다
        expect(dock.root.querySelectorAll('.is-active')).toHaveLength(1);
    });
});
