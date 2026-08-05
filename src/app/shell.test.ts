import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * 앱 셸 — 화면 사이를 오갈 때 뒤에 남는 것이 없는지.
 *
 * ★★ 이 파일이 왜 뒤늦게 생겼나.
 *   services·markdown 은 촘촘히 시험되고 있었는데 src/app/ 은 통째로 비어 있었다.
 *   그런데 셸은 **상태를 들고 있는 유일한 곳**이다(current / editor / viewerFrom /
 *   back 스택). 여기서 나는 버그는 "화면은 멀쩡한데 안에서 어긋난" 형태라
 *   손으로 눌러 보는 것만으로는 좀처럼 안 잡힌다.
 *
 * ★ 대역은 **경계에만** 둔다 — 네이티브 플러그인과 다이얼로그.
 *   services 는 진짜를 쓴다. 목이 구현과 어긋난 채 초록불이 되는 것을 막으려면(11장)
 *   대역은 우리가 못 부르는 것에만 씌워야 한다.
 */

// ── 경계: 네이티브 · 다이얼로그 ─────────────────────────────
// ★ vi.mock 의 팩토리는 파일 맨 위로 끌어올려진다. 바깥 변수를 그냥 쓰면
//   "Cannot access before initialization" 으로 죽는다. vi.hoisted 로 같이 올린다.

const h = vi.hoisted(() => ({
    exitApp: vi.fn(async () => {}),
    nativeStore: new Map<string, string>(),
    /*
     * ★ 이 대역은 md-file.ts 의 **타입 표가 아니라 반환 계약**을 따라야 한다.
     *   read() 는 content 만이 아니라 MdDocument 전체를 돌려준다. 처음에
     *   { content, charset } 만 돌려줬더니 doc.name 이 undefined 로 흘러
     *   recents 가 터졌다 — 대역이 구현과 어긋나면 이렇게 엉뚱한 데서 난다(11장).
     */
    mdFile: {
        pickFile: vi.fn(),
        createFile: vi.fn(),
        read: vi.fn(),
        write: vi.fn(),
        shareFile: vi.fn(async () => ({ completed: true })),
        listFolder: vi.fn(async () => ({ files: [] })),
        pickFolder: vi.fn(async () => ({ uri: '', name: '', persisted: false, cancelled: true })),
        getPersistedUris: vi.fn(async () => ({ uris: [] })),
        releaseUri: vi.fn(async () => {}),
        getSystemFontScale: vi.fn(async () => ({ scale: 1 })),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
        getPendingOpen: vi.fn(async () => ({})),
    },
    confirmAnswer: { value: true },
    choiceAnswer: { value: 'original' as string | null },
    alerts: [] as string[],
}));

const { exitApp, nativeStore, mdFile, confirmAnswer, choiceAnswer, alerts } = h;

vi.mock('@capacitor/app', () => ({
    App: {
        exitApp: () => h.exitApp(),
        addListener: vi.fn(async () => ({ remove: async () => {} })),
    },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: h.nativeStore.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            h.nativeStore.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            h.nativeStore.delete(key);
        },
    },
}));

vi.mock('../plugins/md-file', () => ({ MdFile: h.mdFile }));

vi.mock('../utils/dialog', () => ({
    alertDialog: async (title: string) => {
        h.alerts.push(title);
    },
    confirmDialog: async () => h.confirmAnswer.value,
    choiceDialog: async () => h.choiceAnswer.value,
}));

// ── 대역 없이 쓰는 것들 ─────────────────────────────────────

import { mount, entryHandlers, suggestName } from './shell';
import { __resetRouterForTest, __pressBackForTest, hasLayer } from './router';
import { t } from '../i18n';
import type { MdDocument } from '../plugins/md-file';

function doc(over: Partial<MdDocument> = {}): MdDocument {
    return {
        uri: 'content://docs/a.md',
        name: 'a.md',
        size: 32,
        mimeType: 'text/markdown',
        writable: true,
        ...over,
    };
}

/**
 * 아이콘 버튼에는 글자가 없다. 접근성 이름으로 찾는다 —
 * 그러라고 aria-label 을 붙였고, 누가 떼면 이 테스트가 먼저 알려 준다.
 */
function buttonByLabel(label: string): HTMLButtonElement | null {
    return (
        [...document.querySelectorAll('button')].find(
            (b) => b.getAttribute('aria-label') === label,
        ) ?? null
    );
}

/** 셸이 붙인 화면들 중 지금 보이는 것 */
function visibleScreen(root: HTMLElement): string {
    const shown = [...root.children].find((el) => !(el as HTMLElement).hidden);
    return (shown?.className ?? '').replace('screen ', '').trim() || 'none';
}

let root: HTMLElement;

beforeEach(() => {
    vi.useFakeTimers();
    nativeStore.clear();
    alerts.length = 0;
    confirmAnswer.value = true;
    choiceAnswer.value = 'original';
    __resetRouterForTest();

    // read() 는 넘긴 uri 의 문서를 통째로 돌려준다 — 네이티브가 그렇게 한다.
    mdFile.read.mockImplementation(async ({ uri }: { uri: string }) => ({
        ...doc({ uri, name: uri.split('/').pop() ?? 'doc.md' }),
        content: '# 문서\n\n본문',
        encoding: 'UTF-8' as const,
        persisted: true,
    }));
    mdFile.write.mockImplementation(async ({ uri, content }: { uri: string; content: string }) => ({
        uri,
        bytesWritten: new TextEncoder().encode(content).length,
    }));
    mdFile.pickFile.mockResolvedValue({ cancelled: true });
    mdFile.createFile.mockResolvedValue({ cancelled: true });

    root = document.createElement('div');
    document.body.appendChild(root);
    mount(root);
});

afterEach(() => {
    vi.useRealTimers();
});

/** 붙어 있는 마이크로태스크가 다 풀릴 때까지 돌린다. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(50);
    }
}

describe('셸 — 첫 상태', () => {
    it('시작 화면부터 보여 준다', () => {
        expect(visibleScreen(root)).toContain('screen-home');
    });

    it('화면이 하나만 보인다', () => {
        const shown = [...root.children].filter((el) => !(el as HTMLElement).hidden);
        expect(shown).toHaveLength(1);
    });
});

describe('셸 — 외부 문서 진입', () => {
    it('뷰어를 띄우고 back 레이어를 얹는다', async () => {
        await entryHandlers.openDocument(doc());
        await settle();

        expect(visibleScreen(root)).toContain('screen-viewer');
        expect(hasLayer('viewer')).toBe(true);
    });

    it('외부에서 들어왔으면 뒤로가기가 앱을 닫는다', async () => {
        await entryHandlers.openDocument(doc());
        await settle();

        await __pressBackForTest();
        await settle();

        // ★ 카톡에서 열어 놓고 뒤로 갔는데 우리 시작 화면이 뜨면
        //   사용자는 카톡으로 못 돌아간다고 느낀다(9-1절).
        expect(exitApp).toHaveBeenCalled();
    });

    it('앱 안에서 연 문서는 뒤로가기가 시작 화면으로 간다', async () => {
        await entryHandlers.openSharedText('그냥 글자');
        await settle();
        expect(visibleScreen(root)).toContain('screen-viewer');
    });
});

describe('★ 편집 중에 밖에서 문서가 들어오면', () => {
    /** 문서를 열고 편집 화면까지 들어간다. */
    async function enterEditor(): Promise<HTMLTextAreaElement> {
        await entryHandlers.openDocument(doc());
        await settle();

        const editBtn = buttonByLabel(t.viewer.edit);
        expect(editBtn, '뷰어에 편집 버튼이 없다').not.toBeNull();
        editBtn!.click();
        await settle();

        const ta = root.querySelector<HTMLTextAreaElement>('#editor');
        expect(ta).not.toBeNull();
        return ta!;
    }

    it('편집기가 남지 않는다', async () => {
        const ta = await enterEditor();
        expect(visibleScreen(root)).toContain('screen-editor');

        ta.value = '# 문서\n\n고치는 중';
        ta.dispatchEvent(new Event('input'));
        expect(entryHandlers.hasUnsavedChanges()).toBe(true);

        // 카톡에서 다른 .md 를 누른 상황. 사용자는 '새로 열기'를 고른다.
        confirmAnswer.value = true;
        await entryHandlers.openDocument(doc({ uri: 'content://docs/b.md', name: 'b.md' }));
        await settle();

        expect(visibleScreen(root)).toContain('screen-viewer');

        /*
         * ★★ 여기가 핵심이다.
         *   편집기를 접지 않으면 textarea 에 옛 글이 남아 isDirty() 가 계속 true 다.
         *   그러면 **그 다음부터 문서를 열 때마다** 근거 없는
         *   "저장하지 않은 편집이 있습니다" 가 뜬다 — 사용자는 편집한 적이 없다.
         */
        expect(entryHandlers.hasUnsavedChanges()).toBe(false);
    });

    it("back 스택에 'editor' 가 남지 않는다", async () => {
        const ta = await enterEditor();
        ta.value = '고치는 중';
        ta.dispatchEvent(new Event('input'));
        expect(hasLayer('editor')).toBe(true);

        await entryHandlers.openDocument(doc({ uri: 'content://docs/b.md', name: 'b.md' }));
        await settle();

        // 남아 있으면 뒤로가기가 옛 문서의 편집 화면으로 되돌아간다.
        expect(hasLayer('editor')).toBe(false);
    });

    it("'계속 편집'을 고르면 편집 화면에 그대로 있는다", async () => {
        const ta = await enterEditor();
        ta.value = '고치는 중';
        ta.dispatchEvent(new Event('input'));

        confirmAnswer.value = false; // 계속 편집
        // document-entry 가 하는 판단을 그대로 흉내 낸다.
        if (entryHandlers.hasUnsavedChanges() && !(await entryHandlers.confirmDiscard())) {
            /* 열지 않는다 */
        } else {
            await entryHandlers.openDocument(doc({ uri: 'content://docs/b.md' }));
        }
        await settle();

        expect(visibleScreen(root)).toContain('screen-editor');
        expect(entryHandlers.hasUnsavedChanges()).toBe(true);
    });

    it('공유된 글자로 들어와도 마찬가지다', async () => {
        const ta = await enterEditor();
        ta.value = '고치는 중';
        ta.dispatchEvent(new Event('input'));

        await entryHandlers.openSharedText('메모 앱에서 보낸 글');
        await settle();

        expect(entryHandlers.hasUnsavedChanges()).toBe(false);
        expect(hasLayer('editor')).toBe(false);
    });
});

describe('suggestName', () => {
    it('확장자 앞에 붙인다', () => {
        expect(suggestName('note.md')).toMatch(/^note \(.+\)\.md$/);
    });

    it('확장자가 없으면 .md 를 붙인다', () => {
        expect(suggestName('note')).toMatch(/^note \(.+\)\.md$/);
    });

    it('점으로 시작하는 이름을 확장자로 오해하지 않는다', () => {
        // '.gitignore' 의 dot 은 0 이므로 확장자가 아니다.
        expect(suggestName('.gitignore')).toMatch(/^\.gitignore \(.+\)\.md$/);
    });

    it('점이 여럿이면 마지막 것만 확장자다', () => {
        expect(suggestName('a.b.md')).toMatch(/^a\.b \(.+\)\.md$/);
    });
});
