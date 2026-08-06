import { describe, it, expect, beforeEach, vi } from 'vitest';
import { t, setLanguage } from '../i18n';

/**
 * 내 폴더 (8-3절, M32) — 이 앱의 킬러 기능이다.
 *
 * ★ 여기서 지키는 것은 셋이다.
 *   ① 영속화되지 않은 폴더는 목록에 **넣지 않는다** — 다음 실행에서 못 읽는 폴더다
 *   ② 권한이 만료돼도 목록에서 **지우지 않는다** — SD 카드를 잠깐 뺐을 뿐일 수 있다
 *   ③ 폴더 안의 파일은 트리 권한으로 다시 열리므로 persisted 로 표시한다
 */

const store = new Map<string, string>();
const mdFile = {
    pickFolder: vi.fn(),
    releaseUri: vi.fn(),
    listFolder: vi.fn(),
};

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        },
    },
}));

vi.mock('../plugins/md-file', () => ({
    MdFile: {
        pickFolder: () => mdFile.pickFolder(),
        releaseUri: (o: unknown) => mdFile.releaseUri(o),
        listFolder: (o: unknown) => mdFile.listFolder(o),
    },
}));

const { loadFolders, addFolder, removeFolder, listFolder } = await import('./folders');

const FOLDER = { uri: 'content://p/tree/A', name: '내 노트', addedAt: 0 };
const file = (name: string) => ({
    uri: `content://p/tree/A/document/${name}`,
    name,
    size: 10,
    mimeType: 'text/markdown',
    writable: true,
});

beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    mdFile.releaseUri.mockResolvedValue(undefined);
    setLanguage('ko');
});

describe('폴더 추가', () => {
    it('영속 권한을 받은 폴더만 목록에 넣는다', async () => {
        mdFile.pickFolder.mockResolvedValue({
            cancelled: false,
            persisted: true,
            uri: FOLDER.uri,
            name: FOLDER.name,
        });
        const added = await addFolder();
        expect(added?.uri).toBe(FOLDER.uri);
        expect((await loadFolders()).map((f) => f.uri)).toEqual([FOLDER.uri]);
    });

    /*
     * ★ 영속화가 안 된 폴더를 넣으면 다음 실행에서 목록만 남고 내용을 못 읽는다.
     *   그 상태는 사용자에게 "폴더가 비었다"로 보여서 고장으로 읽힌다. 아예 안 넣는다.
     */
    it('★ 영속화되지 않은 폴더는 넣지 않고 알린다', async () => {
        mdFile.pickFolder.mockResolvedValue({
            cancelled: false,
            persisted: false,
            uri: FOLDER.uri,
            name: FOLDER.name,
        });
        await expect(addFolder()).rejects.toThrow(t.folders.noPermission);
        expect(await loadFolders()).toEqual([]);
    });

    it('취소하면 아무것도 하지 않는다', async () => {
        mdFile.pickFolder.mockResolvedValue({ cancelled: true });
        expect(await addFolder()).toBe(null);
        expect(await loadFolders()).toEqual([]);
    });

    it('같은 폴더를 다시 추가하면 중복되지 않고 맨 앞으로 온다', async () => {
        mdFile.pickFolder.mockResolvedValue({
            cancelled: false,
            persisted: true,
            uri: 'content://p/tree/B',
            name: 'B',
        });
        await addFolder();
        mdFile.pickFolder.mockResolvedValue({
            cancelled: false,
            persisted: true,
            uri: FOLDER.uri,
            name: FOLDER.name,
        });
        await addFolder();
        await addFolder();

        const list = await loadFolders();
        expect(list.map((f) => f.uri)).toEqual([FOLDER.uri, 'content://p/tree/B']);
    });
});

describe('폴더 빼기', () => {
    it('권한을 반납하고 목록에서 지운다', async () => {
        store.set(KEY(), JSON.stringify([FOLDER]));
        const list = await removeFolder(FOLDER.uri);
        expect(mdFile.releaseUri).toHaveBeenCalledWith({ uri: FOLDER.uri });
        expect(list).toEqual([]);
    });

    it('권한 반납이 실패해도 목록에서는 지운다', async () => {
        store.set(KEY(), JSON.stringify([FOLDER]));
        mdFile.releaseUri.mockRejectedValue(new Error('이미 없음'));
        expect(await removeFolder(FOLDER.uri)).toEqual([]);
    });
});

describe('폴더 읽기', () => {
    it('이름순으로 정렬한다', async () => {
        mdFile.listFolder.mockResolvedValue({
            files: [file('나중.md'), file('가장먼저.md'), file('다음.md')],
        });
        const { files } = await listFolder(FOLDER);
        expect(files.map((f) => f.name)).toEqual(['가장먼저.md', '나중.md', '다음.md']);
    });

    /*
     * ★★ 폴더 안의 파일은 **폴더의 트리 권한**으로 다시 열린다.
     *   이 표시가 빠지면 최근 목록에서 '읽기 전용 사본' 으로 뜨고,
     *   rememberDoc 이 필요 없는 사본까지 만든다(2026-08-04에 실제로 그랬다).
     */
    it('★ 폴더 안의 파일은 다시 열 수 있다고 표시한다', async () => {
        mdFile.listFolder.mockResolvedValue({ files: [file('a.md'), file('b.md')] });
        const { files } = await listFolder(FOLDER);
        expect(files.every((f) => f.persisted === true)).toBe(true);
    });

    it('★ 권한이 만료돼도 폴더를 목록에서 지우지 않는다 — 안내만 담는다', async () => {
        mdFile.listFolder.mockRejectedValue({ code: 'EPERM' });
        const listing = await listFolder(FOLDER);
        expect(listing.folder).toEqual(FOLDER);
        expect(listing.files).toEqual([]);
        expect(listing.error).toBe(t.folders.expired);
    });

    it('그 밖의 오류는 일반 안내로 바꾼다', async () => {
        mdFile.listFolder.mockRejectedValue(new Error('아무거나'));
        expect((await listFolder(FOLDER)).error).toBe(t.folders.readFailed);
    });
});

/** Preferences 키. 구현과 같아야 하므로 한 곳에 둔다. */
function KEY(): string {
    return 'folders';
}

/**
 * ★★★ 2026-08-06. 최근 목록과 같은 자리 — 저장된 값이 배열이 아니거나
 *   이름이 없으면 시작 화면의 `folders.map(...)`·`matchesName` 이 터진다.
 *   **시작 화면이 안 그려지고, 켤 때마다 같은 자리에서 죽는다.**
 */
describe('★★ 망가진 폴더 목록으로도 시작 화면이 뜬다', () => {
    it.each([
        ['객체', '{"a":1}'],
        ['숫자', '5'],
        ['null', 'null'],
        ['깨진 JSON', '{이건 JSON 이'],
    ])('%s 이 저장돼 있어도 빈 목록을 준다', async (_이름, 값) => {
        store.set('folders', 값);
        const list = await loadFolders();
        expect(Array.isArray(list), '배열이 아니면 화면에서 map 이 터진다').toBe(true);
        expect(list).toEqual([]);
    });

    it('★ 이름·주소가 없는 폴더만 빼고 나머지는 살린다', async () => {
        store.set(
            'folders',
            JSON.stringify([
                { uri: 'content://tree/a', name: '가폴더', addedAt: 1 },
                { uri: 'content://tree/b' },
                { name: '다폴더' },
                null,
                { uri: 'content://tree/d', name: '라폴더', addedAt: 2 },
            ]),
        );
        expect((await loadFolders()).map((f) => f.name)).toEqual(['가폴더', '라폴더']);
    });
});
