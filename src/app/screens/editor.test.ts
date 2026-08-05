import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 편집기 (9-5절).
 *
 * ★★ 이 앱의 두 번째 차별점이 **한글이 안 깨지는 편집**이다.
 *   그래서 에디터 라이브러리를 쓰지 않고 순수 <textarea> 로 갔다.
 *   조합 중에 값을 프로그램으로 덮어쓰면 글자가 씹히는데, 그건 사용자가
 *   "이 앱은 한글이 안 된다" 로 받아들이는 종류의 고장이다.
 *
 * ★ 그리고 여기서 만든 초안이 **사용자가 친 글을 들고 있는 유일한 곳**이다.
 */

const h = vi.hoisted(() => ({
    scheduled: [] as Array<{ uri: string; content: string }>,
    flushes: 0,
}));

vi.mock('../../services/draft', () => ({
    scheduleDraftSave: (uri: string, content: string) => {
        h.scheduled.push({ uri, content });
    },
    flushDraft: async () => {
        h.flushes += 1;
    },
}));

import { createEditor, createTextArea, type EditorHandle } from './editor';
import { t } from '../../i18n';

let ta: HTMLTextAreaElement;
let editor: EditorHandle | null;

/** 한글 조합을 흉내 낸다 — 안드로이드 IME 가 보내는 순서 그대로. */
function compose(steps: string[], final: string): void {
    ta.dispatchEvent(new Event('compositionstart'));
    for (const s of steps) {
        ta.value = s;
        const e = new Event('input');
        Object.defineProperty(e, 'isComposing', { value: true });
        ta.dispatchEvent(e);
    }
    ta.value = final;
    ta.dispatchEvent(new Event('compositionend'));
}

beforeEach(() => {
    h.scheduled.length = 0;
    h.flushes = 0;
    ta = createTextArea();
    document.body.appendChild(ta);
    editor = null;
});

afterEach(() => {
    editor?.destroy();
});

describe('textarea 자체', () => {
    it('★ maxlength 를 걸지 않는다', () => {
        /*
         * ★★ 한글 IME 는 조합 중인 글자도 길이에 넣는다. 한도에 닿으면
         *   마지막 글자만 계속 바뀌면서 더 이상 못 친다 — 앱이 고장 난 것처럼 보인다.
         */
        expect(ta.hasAttribute('maxlength')).toBe(false);
    });

    it('자동 고침·대문자화를 끈다 — 마크다운에 방해된다', () => {
        expect(ta.spellcheck).toBe(false);
        expect(ta.autocapitalize).toBe('off');
        expect(ta.getAttribute('autocorrect')).toBe('off');
    });

    it('소리로 읽을 이름이 있다', () => {
        expect(ta.getAttribute('aria-label')).toBe(t.editor.title);
    });
});

describe('처음 값과 더러움 판정', () => {
    beforeEach(() => {
        editor = createEditor(ta, 'content://a', '# 처음 글');
    });

    it('처음 값을 넣는다', () => {
        expect(ta.value).toBe('# 처음 글');
        expect(editor!.getValue()).toBe('# 처음 글');
    });

    it('아무것도 안 고쳤으면 깨끗하다', () => {
        expect(editor!.isDirty()).toBe(false);
    });

    it('고치면 더러워진다', () => {
        ta.value = '# 처음 글 + 더';
        expect(editor!.isDirty()).toBe(true);
    });

    it('★ 되돌려 놓으면 다시 깨끗하다', () => {
        ta.value = '아무거나';
        ta.value = '# 처음 글';
        // 안 그러면 고쳤다 되돌린 사람에게 "저장하지 않은 편집" 을 묻게 된다.
        expect(editor!.isDirty()).toBe(false);
    });

    it('저장했다고 표시하면 그 값이 기준이 된다', () => {
        ta.value = '고친 글';
        editor!.markSaved();
        expect(editor!.isDirty()).toBe(false);

        ta.value = '또 고친 글';
        expect(editor!.isDirty()).toBe(true);
    });
});

describe('초안 저장', () => {
    beforeEach(() => {
        editor = createEditor(ta, 'content://a', '처음');
    });

    it('타이핑마다 초안을 예약한다', () => {
        ta.value = '처음 고침';
        ta.dispatchEvent(new Event('input'));
        expect(h.scheduled).toEqual([{ uri: 'content://a', content: '처음 고침' }]);
    });

    it('만들 때 받은 uri 로 예약한다', () => {
        editor!.destroy();
        editor = createEditor(ta, 'content://다른곳', 'x');
        ta.value = 'y';
        ta.dispatchEvent(new Event('input'));

        /*
         * ★★ [새 이름으로 저장] 뒤에 편집기를 다시 묶지 않으면 이어서 친 글자가
         *   **이미 없어진 옛 파일의 초안**으로 쌓인다(2026-08-03 에뮬레이터 확인).
         */
        expect(h.scheduled.at(-1)?.uri).toBe('content://다른곳');
    });

    it('★ 닫을 때 대기 중인 초안을 흘려보낸다', () => {
        ta.value = '마지막 몇 글자';
        ta.dispatchEvent(new Event('input'));
        editor!.destroy();
        editor = null;

        // ★ 이걸 빼면 홈키 한 번에 마지막 몇 백 ms 의 편집이 사라진다.
        expect(h.flushes).toBe(1);
    });
});

describe('★ 한글 IME (9-5절)', () => {
    beforeEach(() => {
        editor = createEditor(ta, 'content://a', '');
    });

    it('조합 중에도 초안은 쌓는다', () => {
        compose(['ㅎ', '하', '한'], '한');
        // 중간 글자가 섞여도 초안이니 괜찮다. 조합 끝나고도 한 번 더 예약된다.
        expect(h.scheduled.length).toBeGreaterThanOrEqual(2);
        expect(h.scheduled.at(-1)?.content).toBe('한');
    });

    it('조합이 끝나면 확정된 글자로 예약한다', () => {
        compose(['ㄱ', '가', '간', '감', '감ㅅ'], '감사');
        expect(h.scheduled.at(-1)?.content).toBe('감사');
        expect(editor!.getValue()).toBe('감사');
    });

    it('★★ 조합 중에는 값을 덮어쓰지 않는다', () => {
        ta.dispatchEvent(new Event('compositionstart'));
        ta.value = '한';

        editor!.setValue('바깥에서 들어온 글');

        /*
         * ★★ 조합 중에 ta.value 를 프로그램으로 바꾸면 **글자가 씹힌다.**
         *   IME 가 들고 있던 조합 상태와 실제 값이 어긋나기 때문이다.
         *   사용자에게는 "이 앱은 한글이 안 된다" 로 보인다 — 그 한 줄이 ★1 이다.
         */
        expect(ta.value).toBe('한');
    });

    it('조합이 끝난 뒤에는 덮어쓸 수 있다', () => {
        ta.dispatchEvent(new Event('compositionstart'));
        ta.value = '한';
        ta.dispatchEvent(new Event('compositionend'));

        editor!.setValue('바깥에서 들어온 글');

        expect(ta.value).toBe('바깥에서 들어온 글');
        // 덮어쓴 값이 곧 기준값이다 — 아니면 방금 넣은 글이 '고친 것'으로 잡힌다.
        expect(editor!.isDirty()).toBe(false);
    });
});

describe('키보드 여백', () => {
    /**
     * visualViewport — jsdom 에 없다. 안드로이드 WebView 에는 항상 있으므로 환경 메우기다.
     * ★ 이걸 안 채우면 bindKeyboardInset 이 조기 반환해서 **이 갈래가 통째로 안 돌고**
     *   테스트는 초록불이 된다. 없는 것을 시험한 셈이 된다.
     */
    beforeEach(() => {
        Object.defineProperty(window, 'visualViewport', {
            configurable: true,
            value: {
                height: 800,
                offsetTop: 0,
                addEventListener: () => {},
                removeEventListener: () => {},
            },
        });
    });

    afterEach(() => {
        Reflect.deleteProperty(window, 'visualViewport');
    });

    it('키보드가 올라온 만큼 여백을 준다', () => {
        // 화면 800, 보이는 영역 500 → 키보드가 300 을 먹었다.
        (window.visualViewport as { height: number }).height = 500;
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

        editor = createEditor(ta, 'content://a', 'x');

        expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('300px');
    });

    it('닫을 때 여백을 0 으로 되돌린다', () => {
        editor = createEditor(ta, 'content://a', 'x');
        document.documentElement.style.setProperty('--kb-inset', '300px');

        editor.destroy();
        editor = null;

        /*
         * ★ --kb-inset 은 문서 뿌리에 붙는 전역 값이다. 남기면 편집기를 닫은 뒤에도
         *   뷰어 아래쪽이 키보드만큼 잘린 채로 남는다.
         */
        expect(document.documentElement.style.getPropertyValue('--kb-inset')).toBe('0px');
    });
});

describe('★ 닫은 뒤에는 아무 일도 하지 않는다', () => {
    it('리스너를 뗀다', () => {
        editor = createEditor(ta, 'content://a', 'x');
        editor.destroy();
        editor = null;

        h.scheduled.length = 0;
        ta.value = '닫힌 뒤에 친 글';
        ta.dispatchEvent(new Event('input'));

        /*
         * ★★ 안 떼면 **죽은 편집기가 옛 uri 로 초안을 계속 쌓는다.**
         *   화면에는 아무것도 안 보이므로 알아챌 방법이 없다.
         */
        expect(h.scheduled).toEqual([]);
    });

    it('두 번 닫아도 터지지 않는다', () => {
        const e = createEditor(ta, 'content://a', 'x');
        e.destroy();
        expect(() => e.destroy()).not.toThrow();
    });
});
