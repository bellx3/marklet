import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 편집 초안 (8-4절).
 *
 * ★ 이 모듈은 **사용자가 친 글자를 들고 있는 유일한 곳**이다. 원본에 자동 저장하지 않기로
 *   했으므로(8-4절), 여기서 잃으면 정말로 없어진다. 그래서 타이밍을 테스트로 고정한다.
 */

const store = new Map<string, string>();
const files = new Map<string, string>();

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
        mkdir: async () => {},
        writeFile: async ({ path, data }: { path: string; data: string }) => {
            files.set(path, data);
        },
        readFile: async ({ path }: { path: string }) => {
            if (!files.has(path)) throw new Error('ENOENT');
            return { data: files.get(path) };
        },
        deleteFile: async ({ path }: { path: string }) => {
            files.delete(path);
        },
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/app', () => ({
    App: { addListener: async () => ({ remove: () => {} }) },
}));

const { scheduleDraftSave, flushDraft, readDraft, draftSavedAt, clearDraft } =
    await import('./draft');

beforeEach(() => {
    store.clear();
    files.clear();
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('초안 저장', () => {
    it('타이핑 직후에는 아직 쓰지 않는다 (디바운스)', async () => {
        scheduleDraftSave('content://a', '안녕');
        expect(files.size).toBe(0);
    });

    it('디바운스가 지나면 쓴다', async () => {
        scheduleDraftSave('content://a', '안녕');
        await vi.advanceTimersByTimeAsync(900);
        expect(await readDraft('content://a')).toBe('안녕');
    });

    it('연속 타이핑은 마지막 것만 쓴다', async () => {
        scheduleDraftSave('content://a', '안');
        scheduleDraftSave('content://a', '안녕');
        scheduleDraftSave('content://a', '안녕하세요');
        await vi.advanceTimersByTimeAsync(900);
        expect(files.size).toBe(1);
        expect(await readDraft('content://a')).toBe('안녕하세요');
    });

    it('flushDraft 는 디바운스를 기다리지 않는다', async () => {
        scheduleDraftSave('content://a', '급합니다');
        await flushDraft();
        expect(await readDraft('content://a')).toBe('급합니다');
    });

    it('저장 시각을 남긴다', async () => {
        scheduleDraftSave('content://a', 'x');
        await flushDraft();
        expect(typeof (await draftSavedAt('content://a'))).toBe('number');
    });

    it('초안이 없으면 null 이다', async () => {
        expect(await readDraft('content://없음')).toBe(null);
        expect(await draftSavedAt('content://없음')).toBe(null);
    });
});

describe('초안 지우기', () => {
    it('파일과 목록에서 함께 지운다', async () => {
        scheduleDraftSave('content://a', 'x');
        await flushDraft();
        await clearDraft('content://a');
        expect(await readDraft('content://a')).toBe(null);
        expect(files.size).toBe(0);
    });

    /*
     * ★★ 이 앱에서 가장 흔한 순간이다 — 글자를 치고 **800ms 안에** [저장]을 누른다.
     *   그때 pending 이 살아 있는데, clearDraft 가 그걸 취소하지 않으면
     *   디바운스가 뒤늦게 깨어나 **방금 지운 초안을 되살린다.**
     *   같은 파일에 저장했을 때는 내용이 같아 조용히 정리되지만,
     *   [새 이름으로 저장] 에서는 옛 URI 의 초안이 남아 나중에 그 파일을 열면
     *   있지도 않은 "저장하지 않은 편집" 을 묻게 된다.
     */
    it('★ 대기 중이던 쓰기를 되살리지 않는다', async () => {
        scheduleDraftSave('content://a', '치는 중');
        await clearDraft('content://a');
        await vi.advanceTimersByTimeAsync(2000);

        expect(await readDraft('content://a')).toBe(null);
        expect(files.size).toBe(0);
    });

    it('다른 문서의 대기 중인 쓰기는 건드리지 않는다', async () => {
        scheduleDraftSave('content://b', '남아야 한다');
        await clearDraft('content://a');
        await vi.advanceTimersByTimeAsync(2000);

        expect(await readDraft('content://b')).toBe('남아야 한다');
    });
});
