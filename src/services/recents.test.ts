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

const { rememberDoc, loadRecents, openRecent, removeRecent, reconcileRecents, sanitizeFileName } =
    await import('./recents');

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
