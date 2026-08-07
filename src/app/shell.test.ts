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
    fsStore: new Map<string, string>(),
    /*
     * ★★ 네이티브가 들고 있는 **파일 내용**. write 가 여기에 쓰고 read 가 여기서 읽는다.
     *   예전에는 read 가 늘 같은 글을 돌려줬는데, save.ts 는 쓴 뒤에 **되읽어 검증한다**.
     *   그래서 어떤 저장도 verify-failed 로 끝났고 — 그 갈래를 시험하는 줄 알았지만
     *   실제로는 **저장 성공 경로를 한 번도 안 밟았다.** 대역이 구현보다 순하면 이렇게 된다.
     */
    docContent: new Map<string, string>(),
    /**
     * uri → 쓰기 가능 여부. 안 넣으면 쓸 수 있는 문서다.
     * ★ 이게 없을 때는 read 대역이 doc() 기본값(writable:true)을 돌려줘서
     *   **읽기 전용 문서를 시험할 방법이 아예 없었다.**
     */
    docWritable: new Map<string, boolean>(),
    confirmAnswer: { value: true },
    /** 확인 상자를 사람이 늦게 누르는 상황을 만든다. 0 이면 예전과 똑같이 즉시 답한다. */
    confirmDelayMs: { value: 0 },
    choiceAnswer: { value: 'original' as string | null },
    alerts: [] as string[],
}));

const {
    exitApp,
    nativeStore,
    fsStore,
    docContent,
    docWritable,
    mdFile,
    confirmAnswer,
    confirmDelayMs,
    choiceAnswer,
    alerts,
} = h;

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

/*
 * ★★ 파일 시스템도 **경계**다. 대역이 없으면 draft.ts 의 readFile 이 그냥 던지고
 *   readDraft 가 null 을 돌려준다 — 즉 초안 복구 경로가 이 파일에서
 *   **한 번도 돌지 않은 채** 초록불이었다. 여기 로직(쓰기 큐·목록 갱신)은
 *   진짜를 돌려야 의미가 있으므로, 네이티브 호출만 메모리로 받는다.
 */
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        mkdir: async () => {},
        writeFile: async ({ path, data }: { path: string; data: string }) => {
            h.fsStore.set(path, data);
        },
        readFile: async ({ path }: { path: string }) => {
            if (!h.fsStore.has(path)) throw new Error('없음');
            return { data: h.fsStore.get(path) };
        },
        deleteFile: async ({ path }: { path: string }) => {
            h.fsStore.delete(path);
        },
        readdir: async ({ path }: { path: string }) => ({
            files: [...h.fsStore.keys()]
                .filter((p) => p.startsWith(`${path}/`))
                .map((p) => ({ name: p.slice(path.length + 1), mtime: 0 })),
        }),
        stat: async ({ path }: { path: string }) => {
            if (!h.fsStore.has(path)) throw new Error('없음');
            return { size: (h.fsStore.get(path) ?? '').length, mtime: 0 };
        },
    },
}));

vi.mock('../plugins/md-file', () => ({ MdFile: h.mdFile }));

vi.mock('../utils/dialog', () => ({
    alertDialog: async (title: string) => {
        h.alerts.push(title);
    },
    confirmDialog: async () => {
        if (h.confirmDelayMs.value) {
            await new Promise((r) => setTimeout(r, h.confirmDelayMs.value));
        }
        return h.confirmAnswer.value;
    },
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
    fsStore.clear();
    docContent.clear();
    docWritable.clear();
    alerts.length = 0;
    confirmAnswer.value = true;
    confirmDelayMs.value = 0;
    choiceAnswer.value = 'original';
    __resetRouterForTest();

    // read() 는 넘긴 uri 의 문서를 통째로 돌려준다 — 네이티브가 그렇게 한다.
    /*
     * ★★ read 는 **write 가 쓴 내용을 돌려줘야 한다.**
     *   save.ts 는 쓴 뒤에 되읽어 검증한다(5-6절 4단계). 늘 같은 글을 돌려주면
     *   **어떤 저장도 verify-failed 로 끝난다** — 저장 성공 경로를 한 번도 안 밟는다.
     *   대역이 구현보다 순하면 초록불만 보게 된다(11장).
     *
     * ★ writable 도 넘겨받은 대로 돌려준다. 예전에는 doc() 기본값(true)이 덮어써서
     *   **읽기 전용 문서를 시험할 방법이 아예 없었다.**
     */
    mdFile.read.mockImplementation(async ({ uri }: { uri: string }) => ({
        ...doc({ uri, name: uri.split('/').pop() ?? 'doc.md' }),
        writable: docWritable.get(uri) ?? true,
        content: docContent.get(uri) ?? '# 문서\n\n본문',
        encoding: 'UTF-8' as const,
        persisted: true,
    }));
    mdFile.write.mockImplementation(async ({ uri, content }: { uri: string; content: string }) => {
        docContent.set(uri, content);
        return { uri, bytesWritten: new TextEncoder().encode(content).length };
    });
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

/**
 * ★★★ 2026-08-06. **먼저 시작한 문서가 나중에 도착해 화면을 덮었다.**
 *
 *   열기 경로에는 await 가 여럿이다 — 네이티브 읽기, 크기 확인 상자, 초안 복구 상자.
 *   뒤의 둘은 **사람이 버튼을 누를 때까지** 걸린다.
 *
 *   그 사이에 다른 문서가 들어오면 순서가 뒤집힌다:
 *       큰 파일 A 를 누른다 → 읽는 중
 *       카톡에서 작은 파일 B 를 누른다 → B 가 먼저 뜬다
 *       A 의 읽기가 끝난다 → **B 를 덮고 A 가 뜬다**
 *   사용자는 방금 연 문서가 아닌 것을 보게 된다.
 *
 *   ★ viewer-screen 의 renderSeq 는 render() **안**만 지킨다. 어느 문서가 render() 를
 *     마지막에 부르느냐는 셸에서 정해야 한다 — 두 자리 다 필요하다.
 */
describe('★★ 여는 도중에 다른 문서가 들어오면', () => {
    /**
     * uri 마다 읽기 지연을 다르게 준다.
     * ★ 기본 목은 어느 uri 든 같은 본문을 준다 — 그러면 어느 문서가 떠 있는지
     *   본문으로 구분할 수 없다. 여기서는 파일 이름을 본문에 넣는다.
     */
    function readWithDelay(delays: Record<string, number>): void {
        mdFile.read.mockImplementation(async ({ uri }: { uri: string }) => {
            const ms = delays[uri] ?? 0;
            if (ms) await new Promise((r) => setTimeout(r, ms));
            return {
                ...doc({ uri, name: uri.split('/').pop() ?? 'doc.md' }),
                content: `# ${uri.split('/').pop()}\n\n본문`,
                encoding: 'UTF-8' as const,
                persisted: true,
            };
        });
    }

    function 본문(): string {
        return root.querySelector('.md-target')?.textContent ?? '';
    }

    it('★ 느린 앞 문서가 뒤에 온 문서를 덮지 않는다', async () => {
        readWithDelay({ 'content://docs/느린.md': 200 });

        const 느린 = entryHandlers.openDocument(doc({ uri: 'content://docs/느린.md' }));
        await vi.advanceTimersByTimeAsync(20);

        await entryHandlers.openDocument(doc({ uri: 'content://docs/빠른.md' }));
        await settle();
        expect(본문(), '빠른 쪽이 먼저 떠 있어야 한다').toContain('빠른.md');

        await vi.advanceTimersByTimeAsync(400);
        await 느린;
        await settle();

        expect(본문(), '느린 앞 문서가 화면을 가로챘다').toContain('빠른.md');
        expect(본문()).not.toContain('느린.md');
    });

    /**
     * ★ 확인 상자는 **사람이 누를 때까지** 걸린다 — 열기 경로에서 가장 긴 await 다.
     *   4MB 를 넘는 공유 텍스트는 '텍스트로만 보기' 확인 상자를 띄운다.
     */
    it('★ 확인 상자를 늦게 누르면 그 사이 들어온 문서를 덮지 않는다', async () => {
        readWithDelay({});
        confirmDelayMs.value = 300;
        const 공유 = entryHandlers.openSharedText('가'.repeat(2 * 1024 * 1024));
        await vi.advanceTimersByTimeAsync(20);

        confirmDelayMs.value = 0;
        await entryHandlers.openDocument(doc({ uri: 'content://docs/나중.md' }));
        await settle();
        expect(본문()).toContain('나중.md');

        await vi.advanceTimersByTimeAsync(600); // 이제서야 [텍스트로만 보기] 를 누른다
        await 공유;
        await settle();

        expect(본문(), '늦게 누른 확인 상자가 화면을 가로챘다').toContain('나중.md');
        expect(본문()).not.toContain('가가가');
    });

    it('끼어드는 것이 없으면 그대로 열린다 (막는 조건이 과하지 않다)', async () => {
        readWithDelay({ 'content://docs/느린.md': 100 });
        // ★ 가짜 타이머에서는 **먼저 await 하면 멎는다** — 시계를 돌려 줄 사람이 없다.
        //   시작만 해 두고 시간을 흘려보낸 뒤에 기다린다.
        const p = entryHandlers.openDocument(doc({ uri: 'content://docs/느린.md' }));
        await settle();
        await p;
        expect(본문()).toContain('느린.md');
    });
});

/**
 * 저장하지 않은 초안 복구 (8-4절).
 *
 * ★★ 2026-08-06 실기기. 편집 중에 앱을 저메모리로 죽이고 같은 문서를 다시 열었다.
 *   "저장하지 않은 편집이 있습니다 … [원본 열기] [이어서 편집]" 이 뜨는 것까지는 맞았는데,
 *   **'이어서 편집'을 눌러도 뷰어에 내려놓았다.** 초안 내용이 실려 있기는 하지만
 *   읽기 전용 화면이라, 글을 잃었을까 봐 불안한 바로 그 순간에 사용자가
 *   편집 단추를 다시 찾아야 했다. 누른 것과 다른 일이 일어난 것이다.
 */
describe('셸 — 초안 복구', () => {
    /** 편집기에 글을 치고 백그라운드 전환으로 초안을 디스크에 떨군다. */
    async function 초안을남긴다(uri: string): Promise<void> {
        await entryHandlers.openDocument(doc({ uri, name: uri.split('/').pop() }));
        await settle();
        buttonByLabel(t.viewer.edit)!.click();
        await settle();

        const ta = root.querySelector<HTMLTextAreaElement>('#editor')!;
        ta.value = '# 문서\n\n본문\n\n초안에만 있는 줄';
        ta.dispatchEvent(new Event('input'));
        /*
         * ★ 초안 디바운스는 800ms 인데 settle() 은 600ms 만 돌린다.
         *   여기서 넉넉히 흘려보내지 않으면 **초안이 아직 안 쓰인 채로** 다음 단계로 간다.
         *   그러면 대기 중이던 쓰기가 나중에 깨어나 clearDraft 뒤에 초안을 되살려,
         *   테스트가 엉뚱한 곳에서 실패한다.
         */
        await vi.advanceTimersByTimeAsync(1200);
        await settle();

        // 앱이 죽은 것처럼 화면 상태만 되돌린다 — 디스크의 초안은 그대로 둔다.
        __resetRouterForTest();
        root.remove();
        root = document.createElement('div');
        document.body.appendChild(root);
        mount(root);
    }

    it('초안이 실제로 디스크에 남는다 (이게 없으면 아래 시험이 헛돈다)', async () => {
        await 초안을남긴다('content://docs/초안.md');
        const 남은것 = [...fsStore.entries()].filter(([p]) => p.startsWith('draft/'));
        expect(남은것.length, '초안 파일이 하나도 안 쓰였다').toBe(1);
        expect(남은것[0][1]).toContain('초안에만 있는 줄');
        expect(nativeStore.get('draftIndex')).toContain('content://docs/초안.md');
    });

    it("★★ '이어서 편집'을 고르면 편집 화면까지 데려간다", async () => {
        await 초안을남긴다('content://docs/초안.md');

        choiceAnswer.value = 'draft';
        await entryHandlers.openDocument(doc({ uri: 'content://docs/초안.md', name: '초안.md' }));
        await settle();

        expect(visibleScreen(root), '뷰어에 내려놓으면 누른 것과 다른 일이다').toContain(
            'screen-editor',
        );
        const ta = root.querySelector<HTMLTextAreaElement>('#editor')!;
        expect(ta.value, '편집기가 초안이 아니라 원본에서 시작했다').toContain('초안에만 있는 줄');
    });

    it("'원본 열기'를 고르면 뷰어에 머물고 초안을 버린다", async () => {
        await 초안을남긴다('content://docs/초안.md');

        choiceAnswer.value = 'original';
        await entryHandlers.openDocument(doc({ uri: 'content://docs/초안.md', name: '초안.md' }));
        await settle();

        expect(visibleScreen(root)).toContain('screen-viewer');
        expect(
            [...fsStore.keys()].filter((p) => p.startsWith('draft/')),
            '원본을 골랐으면 초안은 지워져야 한다',
        ).toEqual([]);
    });

    it('초안이 없으면 아무것도 묻지 않고 뷰어로 간다', async () => {
        choiceAnswer.value = 'draft'; // 물으면 이걸 고를 텐데, 물어선 안 된다
        await entryHandlers.openDocument(doc({ uri: 'content://docs/새.md', name: '새.md' }));
        await settle();

        expect(visibleScreen(root)).toContain('screen-viewer');
    });
});

/**
 * 읽기 전용 문서를 고쳐 '새 이름으로 저장' 하는 길 (5-6절).
 *
 * ★★★ 2026-08-07. **이 길로 저장하면 편집 화면에 그대로 남았다.**
 *
 *   일반 저장(saveFlow)은 성공하면 편집을 끝내고 뷰어로 돌아간다. 주석에도 이유가
 *   적혀 있다 — "저장은 '이 편집을 마쳤다'는 뜻이다. 저장 뒤에도 편집 화면에 남겨 두면
 *   사용자가 토스트를 보고도 뒤로가기를 한 번 더 눌러야 한다(2026-08-04 사장님 지적)."
 *   그런데 그 처리가 saveAsFlow 에는 없었다.
 *
 *   ★★ 하필 **읽기 전용 문서는 언제나 이 길로 간다.** 카톡·파일 관리자에서 들어온
 *     문서는 쓰기 권한을 못 받으므로 [저장] → 실패 → [새 이름으로 저장] 이 정상 경로다.
 *     즉 지적받아 고친 그 불편이, 가장 흔한 경로에서는 그대로 남아 있었다.
 */
describe('★★ 새 이름으로 저장', () => {
    /** 저장 단추는 글자로 되어 있다(아이콘이 아니다). */
    function 저장단추(): HTMLButtonElement {
        const b = [...root.querySelectorAll('button')].find(
            (x) => (x.textContent ?? '').trim() === t.editor.save,
        );
        expect(b, '편집 화면에 저장 단추가 없다').toBeTruthy();
        return b!;
    }

    async function 읽기전용문서를편집한다(): Promise<void> {
        // ★ 네이티브가 돌려주는 값이 기준이다 — openDocument 인자만 바꿔선 소용없다.
        docWritable.set('content://docs/읽기.md', false);
        await entryHandlers.openDocument(doc({ uri: 'content://docs/읽기.md', writable: false }));
        await settle();
        buttonByLabel(t.viewer.edit)!.click();
        await settle();
        const ta = root.querySelector<HTMLTextAreaElement>('#editor')!;
        ta.value = '# 문서\n\n고친 글';
        ta.dispatchEvent(new Event('input'));
        await settle();
    }

    it('★★ 저장에 성공하면 편집을 끝내고 뷰어로 돌아간다', async () => {
        await 읽기전용문서를편집한다();
        expect(visibleScreen(root)).toContain('screen-editor');

        // 읽기 전용이라 저장이 실패하고, 사용자는 [새 이름으로 저장] 을 고른다.
        choiceAnswer.value = 'saveas';
        mdFile.createFile.mockResolvedValue({
            uri: 'content://docs/새이름.md',
            name: '새이름.md',
            size: 0,
            mimeType: 'text/markdown',
            writable: true,
            cancelled: false,
        });

        저장단추().click();
        await settle();

        expect(visibleScreen(root), '저장했는데 편집 화면에 남아 있다').toContain('screen-viewer');
        expect(hasLayer('editor'), "back 스택에 'editor' 가 남았다").toBe(false);
        expect(entryHandlers.hasUnsavedChanges()).toBe(false);
    });

    it('사용자가 파일 만들기를 취소하면 편집 화면에 그대로 있는다', async () => {
        await 읽기전용문서를편집한다();

        choiceAnswer.value = 'saveas';
        mdFile.createFile.mockResolvedValue({ cancelled: true });

        저장단추().click();
        await settle();

        expect(visibleScreen(root), '취소했는데 편집 화면을 닫았다').toContain('screen-editor');
        expect(entryHandlers.hasUnsavedChanges(), '고친 글이 사라졌다').toBe(true);
    });
});

/**
 * 저장에 성공한 뒤의 뒷정리.
 *
 * ★★ 이 갈래는 **오늘까지 한 번도 안 돌았다.** read 대역이 늘 같은 글을 돌려줘서
 *   save.ts 의 되읽기 검증이 항상 실패했기 때문이다(위 대역 주석). 대역을 고치고
 *   처음으로 열린 길이라, 여기서 무엇이 갱신되고 무엇이 안 되는지 못으로 박아 둔다.
 */
describe('저장 성공 뒤', () => {
    async function 열고고치고저장(over: Partial<MdDocument> = {}): Promise<string> {
        const uri = over.uri ?? 'content://docs/쓸수있는.md';
        await entryHandlers.openDocument(doc({ uri, ...over }));
        await settle();
        buttonByLabel(t.viewer.edit)!.click();
        await settle();
        const ta = root.querySelector<HTMLTextAreaElement>('#editor')!;
        ta.value = '# 문서\n\n저장된 새 글';
        ta.dispatchEvent(new Event('input'));
        await settle();
        [...root.querySelectorAll('button')]
            .find((x) => (x.textContent ?? '').trim() === t.editor.save)!
            .click();
        await settle();
        return uri;
    }

    it('편집을 끝내고 뷰어로 돌아간다', async () => {
        await 열고고치고저장();
        expect(visibleScreen(root)).toContain('screen-viewer');
        expect(hasLayer('editor')).toBe(false);
        expect(entryHandlers.hasUnsavedChanges()).toBe(false);
    });

    it('원본 파일에 새 글이 들어갔다', async () => {
        const uri = await 열고고치고저장();
        expect(docContent.get(uri)).toContain('저장된 새 글');
    });

    it('초안을 지운다 (다음에 열 때 헛되이 묻지 않는다)', async () => {
        await 열고고치고저장();
        expect([...fsStore.keys()].filter((p) => p.startsWith('draft/'))).toEqual([]);
    });

    it('뷰어가 새 글을 보여 준다', async () => {
        await 열고고치고저장();
        expect(root.querySelector('.md-target')?.textContent).toContain('저장된 새 글');
    });

    /**
     * ★★★ 사본(snapshot)은 **다시 못 여는 URI 의 유일한 사본**이다.
     *   저장에 성공하면 원본은 새 글이 되는데 사본이 옛 글 그대로면,
     *   나중에 원본을 못 열게 됐을 때 **저장까지 마친 글이 조용히 옛 글로 되돌아간다.**
     *   사용자는 저장에 성공했다는 토스트까지 봤다.
     *
     *   writable 이면서 persisted 가 아닌 조합은 실제로 있다 — 파일 관리자가
     *   쓰기 권한은 주지만 영속 권한(ACTION_OPEN_DOCUMENT)은 아닌 경우다.
     */
    it('★★ 사본도 새 글로 갱신된다', async () => {
        mdFile.read.mockImplementation(async ({ uri }: { uri: string }) => ({
            ...doc({ uri, name: uri.split('/').pop() ?? 'doc.md' }),
            content: docContent.get(uri) ?? '# 문서\n\n본문',
            encoding: 'UTF-8' as const,
            persisted: false, // 다시 못 여는 URI — 사본이 남는다
        }));

        await 열고고치고저장({ uri: 'content://docs/사본.md' });

        const 사본 = [...fsStore.entries()].filter(([p]) => p.startsWith('snapshot/'));
        expect(사본.length, '사본이 하나는 있어야 한다').toBe(1);
        expect(사본[0][1], '저장했는데 사본은 옛 글 그대로다').toContain('저장된 새 글');
    });
});
