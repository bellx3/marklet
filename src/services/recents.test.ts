import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MdDocument } from '../plugins/md-file';

/*
 * 11-2절 #13 · #14.
 *
 * ★ 목의 형태는 MdFilePlugin.java 의 put( 호출을 보고 맞췄다:
 *     getPersistedUris() → { uris: [{ uri, read, write, persistedTime }] }
 *     releaseUri({uri})  → void
 *
 * 회귀: rememberDoc 에서 list.slice(MAX) 정리 루프를 지우면
 *   "51번째를 넣으면 releaseUri 가 불린다" 테스트가 실패하는 것을 확인함.
 */

const store = new Map<string, string>();
const mdFile = {
    read: vi.fn(),
    releaseUri: vi.fn(),
    getPersistedUris: vi.fn(),
};
const fs = {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    deleteFile: vi.fn(),
    readdir: vi.fn(),
};

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        },
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        mkdir: (o: unknown) => fs.mkdir(o),
        writeFile: (o: unknown) => fs.writeFile(o),
        readFile: (o: unknown) => fs.readFile(o),
        deleteFile: (o: unknown) => fs.deleteFile(o),
        readdir: (o: unknown) => fs.readdir(o),
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('../plugins/md-file', () => ({
    MdFile: {
        read: (o: unknown) => mdFile.read(o),
        releaseUri: (o: unknown) => mdFile.releaseUri(o),
        getPersistedUris: () => mdFile.getPersistedUris(),
    },
}));

const {
    rememberDoc,
    loadRecents,
    openRecent,
    removeRecent,
    reconcileRecents,
    sanitizeFileName,
    pruneSnapshotOrphans,
} = await import('./recents');

function doc(n: number, persisted = true): MdDocument {
    return {
        uri: `content://test/${n}`,
        name: `문서${n}.md`,
        size: 100,
        mimeType: 'text/markdown',
        writable: true,
        persisted,
    };
}

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    fs.mkdir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    fs.deleteFile.mockResolvedValue(undefined);
    mdFile.releaseUri.mockResolvedValue(undefined);
});

describe('rememberDoc', () => {
    it('최근에 연 것이 맨 앞이고 같은 URI 는 중복되지 않는다', async () => {
        await rememberDoc(doc(1), '내용', 'picker');
        await rememberDoc(doc(2), '내용', 'picker');
        await rememberDoc(doc(1), '내용', 'picker');

        const list = await loadRecents();
        expect(list.map((r) => r.uri)).toEqual(['content://test/1', 'content://test/2']);
    });

    it('영속화되지 않은 문서는 사본을 남긴다 (카톡·메일로 받은 파일)', async () => {
        await rememberDoc(doc(9, false), '카톡에서 온 내용', 'intent');

        expect(fs.writeFile).toHaveBeenCalledWith(
            expect.objectContaining({ data: '카톡에서 온 내용' }),
        );
        const [saved] = await loadRecents();
        expect(saved.persisted).toBe(false);
        expect(saved.snapshotPath).toMatch(/^snapshot\//);
    });

    it('영속화된 문서는 사본을 만들지 않는다', async () => {
        await rememberDoc(doc(1, true), '내용', 'picker');
        expect(fs.writeFile).not.toHaveBeenCalled();
    });

    it('★ 51번째를 넣으면 밀려난 항목의 releaseUri 와 사본 삭제가 호출된다', async () => {
        for (let i = 1; i <= 50; i++) await rememberDoc(doc(i), '내용', 'picker');
        vi.clearAllMocks();
        fs.deleteFile.mockResolvedValue(undefined);
        mdFile.releaseUri.mockResolvedValue(undefined);

        await rememberDoc(doc(51), '내용', 'picker');

        // 가장 오래된 것(1번)이 밀려난다
        expect(mdFile.releaseUri).toHaveBeenCalledWith({ uri: 'content://test/1' });
        const list = await loadRecents();
        expect(list.length).toBe(50);
        expect(list.some((r) => r.uri === 'content://test/1')).toBe(false);
    });

    it('밀려난 항목이 사본을 갖고 있으면 사본도 지운다', async () => {
        for (let i = 1; i <= 50; i++) await rememberDoc(doc(i, i !== 1), '내용', 'picker');
        vi.clearAllMocks();
        fs.deleteFile.mockResolvedValue(undefined);

        await rememberDoc(doc(99), '내용', 'picker');

        expect(fs.deleteFile).toHaveBeenCalledWith(
            expect.objectContaining({ path: expect.stringMatching(/^snapshot\//) }),
        );
    });
});

describe('openRecent', () => {
    it('원본이 열리면 그대로 쓴다', async () => {
        mdFile.read.mockResolvedValue({ ...doc(1), content: '원본 내용' });
        const r = await openRecent({
            uri: 'content://test/1',
            name: '문서1.md',
            lastOpened: 0,
            persisted: true,
            size: 100,
            source: 'picker',
        });
        expect(r?.fromSnapshot).toBe(false);
        expect(r?.content).toBe('원본 내용');
        expect(r?.doc.writable).toBe(true);
    });

    it('★ 원본이 실패하면 사본으로 폴백하고 writable:false 를 강제한다', async () => {
        mdFile.read.mockRejectedValue(new Error('없음'));
        fs.readFile.mockResolvedValue({ data: '사본 내용' });

        const r = await openRecent({
            uri: 'content://test/1',
            name: '문서1.md',
            lastOpened: 0,
            persisted: false,
            snapshotPath: 'snapshot/x.md',
            size: 100,
            source: 'intent',
        });

        expect(r?.fromSnapshot).toBe(true);
        expect(r?.content).toBe('사본 내용');
        // ★ 사본을 원본으로 착각해 저장하면 그게 곧 데이터 유실이다
        expect(r?.doc.writable).toBe(false);
    });

    it('원본도 사본도 없으면 null 을 돌려준다', async () => {
        mdFile.read.mockRejectedValue(new Error('없음'));
        const r = await openRecent({
            uri: 'content://test/1',
            name: '문서1.md',
            lastOpened: 0,
            persisted: false,
            size: 100,
            source: 'intent',
        });
        expect(r).toBeNull();
    });
});

describe('reconcileRecents', () => {
    it('실제 권한 목록과 대조해 persisted 를 갱신한다', async () => {
        await rememberDoc(doc(1), '내용', 'picker');
        await rememberDoc(doc(2), '내용', 'picker');
        mdFile.getPersistedUris.mockResolvedValue({
            uris: [{ uri: 'content://test/2', read: true, write: true, persistedTime: 0 }],
        });

        const list = await reconcileRecents();
        const byUri = Object.fromEntries(list.map((r) => [r.uri, r.persisted]));
        expect(byUri['content://test/1']).toBe(false);
        expect(byUri['content://test/2']).toBe(true);
    });

    it('★ 권한이 사라졌다고 목록에서 지우지는 않는다', async () => {
        await rememberDoc(doc(1), '내용', 'picker');
        mdFile.getPersistedUris.mockResolvedValue({ uris: [] });
        expect((await reconcileRecents()).length).toBe(1);
    });

    it('네이티브가 없으면(웹) 저장된 값을 그대로 돌려준다', async () => {
        await rememberDoc(doc(1), '내용', 'picker');
        mdFile.getPersistedUris.mockRejectedValue(new Error('not implemented'));
        expect((await reconcileRecents()).length).toBe(1);
    });

    /*
     * ★★ 폴더 안의 파일은 **트리 권한 하나**로 다시 열린다.
     *   정확히 일치하는 URI 만 살아 있다고 보면 폴더의 파일이 전부 탈락해서
     *   최근 목록에 '읽기 전용 사본' 으로 뜨고, 사본까지 만들어진다.
     *   2026-08-04 에뮬레이터에서 실제로 그랬다.
     */
    it('★ 트리 권한이 있으면 그 아래 파일도 다시 열 수 있다고 본다', async () => {
        const tree = 'content://p/tree/primary%3ADocs';
        const child = `${tree}/document/primary%3ADocs%2Fnote.md`;
        await rememberDoc(
            { uri: child, name: 'note.md', size: 10, mimeType: 'text/markdown', writable: true },
            '내용',
            'folder',
        );
        mdFile.getPersistedUris.mockResolvedValue({
            uris: [{ uri: tree, read: true, write: true, persistedTime: 0 }],
        });

        const list = await reconcileRecents();
        expect(list.find((r) => r.uri === child)?.persisted).toBe(true);
    });

    it('트리가 달라지면 살아 있다고 보지 않는다', async () => {
        const child = 'content://p/tree/A/document/A%2Fnote.md';
        await rememberDoc(
            { uri: child, name: 'note.md', size: 10, mimeType: 'text/markdown', writable: true },
            '내용',
            'folder',
        );
        mdFile.getPersistedUris.mockResolvedValue({
            uris: [{ uri: 'content://p/tree/B', read: true, write: true, persistedTime: 0 }],
        });

        expect((await reconcileRecents()).find((r) => r.uri === child)?.persisted).toBe(false);
    });
});

describe('removeRecent', () => {
    it('권한을 반납하고 사본을 지운다', async () => {
        await rememberDoc(doc(1, false), '내용', 'intent');
        vi.clearAllMocks();
        fs.deleteFile.mockResolvedValue(undefined);

        const next = await removeRecent('content://test/1');

        expect(next.length).toBe(0);
        expect(fs.deleteFile).toHaveBeenCalled();
    });
});

describe('sanitizeFileName', () => {
    it('파일 이름에 못 쓰는 문자를 바꾼다', () => {
        expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    });
    it('빈 이름이면 기본값을 준다', () => {
        expect(sanitizeFileName('')).toBe('doc.md');
    });
});

/**
 * ★★★ 2026-08-06. **다시 못 여는 문서의 사본이 새고 있었다.**
 *
 *   rememberDoc 은 같은 URI 의 옛 항목을 목록에서 빼면서 **그 사본 파일은 그대로 뒀다.**
 *   영속 권한을 못 받은 URI 는 열 때마다 새 사본을 만드므로,
 *   같은 문서를 스무 번 열면 사본 스무 개 중 열아홉 개가 쓰레기다.
 *
 *   ACTION_VIEW 로 온 URI 는 영속 권한을 못 받는데(파일 관리자·메신저),
 *   같은 파일을 다시 여는 것은 아주 흔한 일이고 URI 는 대개 그대로다.
 *   4MB 문서라면 스무 번에 76MB 다 — 사용자는 이유를 알 수 없다.
 *
 *   ★ 초안 쪽에는 pruneDraftOrphans() 가 있었는데 사본에는 없었다.
 */
describe('★★ 사본이 새지 않는다', () => {
    it('★ 같은 문서를 다시 열어도 사본 파일이 늘지 않는다', async () => {
        const d = { ...doc(1, false), name: 'a.md' };

        // ★ 시간을 흘려보낸다. 안 그러면 같은 밀리초에 두 번 불려서
        //   시각 기반 이름으로도 우연히 같은 경로가 나오고, 테스트가 아무것도 못 잡는다.
        vi.useFakeTimers();
        try {
            await rememberDoc(d, '첫 내용', 'intent');
            const 첫사본 = (await loadRecents())[0].snapshotPath!;
            expect(첫사본).toBeTruthy();

            vi.setSystemTime(new Date(Date.now() + 60_000));
            await rememberDoc(d, '둘째 내용', 'intent');
            const 둘째사본 = (await loadRecents())[0].snapshotPath!;

            // 같은 자리에 덮어쓴다 — 새 파일이 생기지 않으므로 버려질 것도 없다.
            expect(둘째사본, '열 때마다 새 파일이 생긴다').toBe(첫사본);
            const 쓴경로 = fs.writeFile.mock.calls.map((c) => (c[0] as { path: string }).path);
            expect(new Set(쓴경로).size, `사본 파일이 늘었다: ${쓴경로.join(', ')}`).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('시각이 아니라 URI 로 자리를 정한다 (같은 밀리초에도 안 겹친다)', async () => {
        // 이름이 같고 URI 만 다른 두 문서 — 예전에는 같은 밀리초면 경로가 겹쳤다.
        await rememberDoc({ ...doc(1, false), name: 'README.md' }, '가', 'intent');
        await rememberDoc({ ...doc(2, false), name: 'README.md' }, '나', 'intent');
        const 사본들 = (await loadRecents()).map((r) => r.snapshotPath);
        expect(new Set(사본들).size, `경로가 겹쳤다: ${사본들.join(', ')}`).toBe(2);
    });

    it('★ 이름이 바뀌면 옛 사본을 지운다', async () => {
        const d = { ...doc(1, false), name: 'a.md' };
        await rememberDoc(d, '가', 'intent');
        const 옛사본 = (await loadRecents())[0].snapshotPath!;

        fs.deleteFile.mockClear();
        await rememberDoc({ ...d, name: 'b.md' }, '나', 'intent');

        expect((await loadRecents())[0].snapshotPath).not.toBe(옛사본);
        expect(fs.deleteFile, '이름만 바뀌었는데 옛 사본이 남았다').toHaveBeenCalledWith(
            expect.objectContaining({ path: 옛사본 }),
        );
    });

    it('다른 문서의 사본은 건드리지 않는다', async () => {
        await rememberDoc({ ...doc(1, false), name: 'a.md' }, '가', 'intent');
        const 남의사본 = (await loadRecents())[0].snapshotPath!;

        fs.deleteFile.mockClear();
        await rememberDoc({ ...doc(2, false), name: 'b.md' }, '나', 'intent');

        expect(fs.deleteFile).not.toHaveBeenCalledWith(expect.objectContaining({ path: 남의사본 }));
        expect((await loadRecents()).map((r) => r.snapshotPath)).toContain(남의사본);
    });
});

/**
 * ★ rememberDoc 을 고쳐도 **어제까지 쌓인 사본은 그대로 남는다.**
 *   첫 화면 뒤에 조용히 치운다 — 초안 쪽과 같은 자리, 같은 이유다.
 */
describe('★ pruneSnapshotOrphans — 이미 새어 나간 것을 치운다', () => {
    it('목록이 가리키지 않는 사본만 지운다', async () => {
        await rememberDoc({ ...doc(1, false), name: 'a.md' }, '가', 'intent');
        const 쓰는것 = (await loadRecents())[0].snapshotPath!;
        const 이름 = 쓰는것.replace('snapshot/', '');

        fs.readdir.mockResolvedValue({
            files: [{ name: 이름 }, { name: '999-버려진것.md' }, { name: '998-이것도.md' }],
        });
        fs.deleteFile.mockClear();

        await pruneSnapshotOrphans();

        const 지운것 = fs.deleteFile.mock.calls.map((c) => (c[0] as { path: string }).path);
        expect(지운것).toEqual(['snapshot/999-버려진것.md', 'snapshot/998-이것도.md']);
        expect(지운것, '쓰는 사본을 지웠다').not.toContain(쓰는것);
    });

    it('폴더가 없어도(첫 실행·웹) 조용히 넘어간다', async () => {
        fs.readdir.mockRejectedValue(new Error('ENOENT'));
        await expect(pruneSnapshotOrphans()).resolves.toBeUndefined();
    });
});

/**
 * ★★★ 2026-08-06. **저장된 목록 하나로 시작 화면이 안 그려질 수 있었다.**
 *
 *   loadRecents 는 `JSON.parse(value) as RecentDoc[]` 로 그대로 돌려줬다.
 *   배열이 아닌 값이 들어 있으면 시작 화면의 `recents.filter(...)` 가 터지고,
 *   이름이 없는 항목 하나만 있어도 `matchesName` 이 터진다:
 *       TypeError: recents.filter is not a function
 *       TypeError: Cannot read properties of null (reading 'normalize')
 *   둘 다 **시작 화면이 안 그려진다.** 저장된 값이라 켤 때마다 같은 자리에서 죽고,
 *   사용자는 앱 데이터를 지우는 것 말고는 길이 없다 — 설정 쪽과 같은 종류다.
 */
describe('★★ 망가진 최근 목록으로도 시작 화면이 뜬다', () => {
    it.each([
        ['객체', '{"a":1}'],
        ['숫자', '5'],
        ['문자열', '"안녕"'],
        ['null', 'null'],
        ['깨진 JSON', '{이건 JSON 이'],
    ])('%s 이 저장돼 있어도 빈 목록을 준다', async (_이름, 값) => {
        store.set('recentDocs', 값);
        const list = await loadRecents();
        expect(Array.isArray(list), '배열이 아니면 화면에서 filter 가 터진다').toBe(true);
        expect(list).toEqual([]);
    });

    it('★ 이름·주소가 없는 항목만 빼고 나머지는 살린다', async () => {
        store.set(
            'recentDocs',
            JSON.stringify([
                { uri: 'content://a', name: 'a.md', lastOpened: 1, persisted: true, size: 1 },
                { uri: 'content://b' }, // 이름 없음
                { name: 'c.md' }, // 주소 없음
                { uri: 'content://d', name: null }, // 이름이 null
                null,
                'ㅋㅋ',
                { uri: 'content://e', name: 'e.md', lastOpened: 2, persisted: true, size: 1 },
            ]),
        );
        const list = await loadRecents();
        expect(list.map((r) => r.name)).toEqual(['a.md', 'e.md']);
    });

    it('멀쩡한 목록은 그대로 살린다 (전부 버리지 않는다)', async () => {
        await rememberDoc(doc(1), '내용', 'picker');
        await rememberDoc(doc(2), '내용', 'picker');
        expect((await loadRecents()).length).toBe(2);
    });
});
