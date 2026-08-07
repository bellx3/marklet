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
/** 네이티브 Preferences 가 실패하는 상황. 드물지만 일어난다. */
const prefsFail = { get: false };
const mdFile = {
    pickFolder: vi.fn(),
    releaseUri: vi.fn(),
    listFolder: vi.fn(),
};

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => {
            if (prefsFail.get) throw new Error('네이티브 실패');
            return { value: store.get(key) ?? null };
        },
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
    prefsFail.get = false;
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

/**
 * ★★★ 2026-08-06. 폴더 목록도 **읽고-고치고-쓴다.**
 *   못 읽은 것을 [] 로 퉁치면 폴더 하나 더한 결과가 '나머지가 전부 사라짐' 이 된다.
 *   폴더는 사용자가 시스템 선택기로 하나씩 골라 권한을 받아 둔 것이라
 *   목록이 날아가면 전부 다시 골라야 한다. 최근 문서 쪽과 같은 종류다.
 */
describe('★★ 목록을 못 읽으면 폴더 목록을 덮어쓰지 않는다', () => {
    it('addFolder — 조용히 하나만 남기지 않고 알린다', async () => {
        mdFile.pickFolder.mockResolvedValue({ ...FOLDER, persisted: true, cancelled: false });
        await addFolder();
        mdFile.pickFolder.mockResolvedValue({
            uri: 'content://p/tree/B',
            name: '두 번째',
            persisted: true,
            cancelled: false,
        });
        const 저장된것 = store.get('folders');

        prefsFail.get = true;
        try {
            await expect(addFolder()).rejects.toThrow(t.folders.listUnavailable);
        } finally {
            prefsFail.get = false;
        }

        expect(store.get('folders'), '폴더 목록을 덮어썼다').toBe(저장된것);
        expect(await loadFolders()).toHaveLength(1);
    });

    it('★★ removeFolder — 권한을 반납해 버리지 않는다 (반납은 되돌릴 수 없다)', async () => {
        mdFile.pickFolder.mockResolvedValue({ ...FOLDER, persisted: true, cancelled: false });
        await addFolder();
        const 저장된것 = store.get('folders');
        mdFile.releaseUri.mockClear();

        prefsFail.get = true;
        let 결과: unknown;
        try {
            결과 = await removeFolder(FOLDER.uri);
        } finally {
            prefsFail.get = false;
        }

        expect(결과, '[] 를 돌려주면 아무것도 안 했다는 사실이 가려진다').toBeNull();
        expect(mdFile.releaseUri, '읽지도 못했는데 권한을 놓아 버렸다').not.toHaveBeenCalled();
        expect(store.get('folders')).toBe(저장된것);
    });

    it('제대로 읽히면 지금까지대로 지운다 (규칙이 과하지 않다)', async () => {
        mdFile.pickFolder.mockResolvedValue({ ...FOLDER, persisted: true, cancelled: false });
        await addFolder();
        mdFile.releaseUri.mockClear();

        const next = await removeFolder(FOLDER.uri);

        expect(next).toEqual([]);
        expect(mdFile.releaseUri).toHaveBeenCalledWith({ uri: FOLDER.uri });
        expect(await loadFolders()).toHaveLength(0);
    });
});

/**
 * 폴더를 못 읽었을 때 **이유마다 다른 말을 한다** (2026-08-07 LG Q7 실측).
 *
 * ★★★ 폴더를 밖에서 지우거나 이름을 바꾸면, 네이티브 walk() 가 자식 커서를 못 얻고
 *   조용히 빈 목록으로 성공했다. 그래서 화면에는
 *   **"이 폴더에는 마크다운 파일이 없습니다"** 가 떴다 —
 *   못 찾는 것을 '비어 있다' 고 말한 것이다. 사용자는 자기 파일이 사라진 줄 알거나
 *   폴더를 잘못 골랐다고 생각한다. 실제로 할 일(어디로 옮겼는지 찾기)은 화면에 없다.
 *
 *   네이티브가 ENOENT 를 주게 고쳤고, 여기서 그 갈래를 문구로 잇는다.
 */
describe('★★ 폴더를 못 읽은 이유를 구분한다', () => {
    beforeEach(() => {
        mdFile.pickFolder.mockResolvedValue({ ...FOLDER, persisted: true, cancelled: false });
    });

    const 실패로listFolder = async (code: string): Promise<string | undefined> => {
        await addFolder();
        mdFile.listFolder.mockRejectedValue(Object.assign(new Error('x'), { code }));
        const [listing] = await Promise.all([listFolder({ ...FOLDER })]);
        return listing.error;
    };

    it('★★ 폴더가 없으면 "찾을 수 없다" 고 한다 (빈 폴더가 아니다)', async () => {
        const err = await 실패로listFolder('ENOENT');
        expect(err).toBe(t.folders.notFound);
        expect(err, '없는 폴더를 빈 폴더라고 하면 안 된다').not.toBe(t.folders.readFailed);
    });

    it('권한이 만료됐으면 그렇게 말한다', async () => {
        expect(await 실패로listFolder('EPERM')).toBe(t.folders.expired);
    });

    it('그 밖의 실패는 "읽지 못했다" 로 남긴다', async () => {
        expect(await 실패로listFolder('EIO')).toBe(t.folders.readFailed);
    });

    it('★ 진짜로 비어 있는 폴더는 오류가 아니다 (규칙이 과하지 않다)', async () => {
        await addFolder();
        mdFile.listFolder.mockResolvedValue({ files: [] });
        const listing = await listFolder({ ...FOLDER });
        expect(listing.error).toBeUndefined();
        expect(listing.files).toEqual([]);
    });
});
