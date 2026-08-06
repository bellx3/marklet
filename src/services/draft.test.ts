import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * 편집 초안 (8-4절).
 *
 * ★ 이 모듈은 **사용자가 친 글자를 들고 있는 유일한 곳**이다. 원본에 자동 저장하지 않기로
 *   했으므로(8-4절), 여기서 잃으면 정말로 없어진다. 그래서 타이밍을 테스트로 고정한다.
 */

const store = new Map<string, string>();
const files = new Map<string, string>();

/**
 * 네이티브 브리지 왕복 시간.
 *
 * ★ 0 이면 get→set 사이가 마이크로태스크 하나뿐이라 **경쟁이 아예 안 생긴다.**
 *   실제 Preferences 는 JS↔네이티브 왕복이라 매 호출이 진짜로 늦다.
 *   그 사실을 지우면 목이 구현보다 순해져서 초록불만 보게 된다(11장).
 */
const bridge = { delayMs: 0 };
const hop = async () => {
    if (bridge.delayMs) await new Promise((r) => setTimeout(r, bridge.delayMs));
};

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => {
            await hop();
            return { value: store.get(key) ?? null };
        },
        set: async ({ key, value }: { key: string; value: string }) => {
            await hop();
            store.set(key, value);
        },
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        mkdir: async () => {},
        writeFile: async ({ path, data }: { path: string; data: string }) => {
            await hop();
            files.set(path, data);
        },
        readFile: async ({ path }: { path: string }) => {
            if (!files.has(path)) throw new Error('ENOENT');
            return { data: files.get(path) };
        },
        deleteFile: async ({ path }: { path: string }) => {
            files.delete(path);
        },
        // ★ 실제 플러그인처럼 폴더가 없으면 던진다. 조용히 빈 목록을 주면
        //   "폴더 없음" 갈래를 시험한 적이 없게 된다.
        readdir: async ({ path }: { path: string }) => {
            // ★ 이것도 네이티브 왕복이다. 즉답으로 두면 정리가 쓰기보다 항상 먼저 끝나
            //   **겹침이 아예 안 생긴다** — 목이 구현보다 순해지는 그 함정이다(11장).
            await hop();
            const prefix = `${path}/`;
            const names = [...files.keys()]
                .filter((p) => p.startsWith(prefix))
                .map((p) => ({ name: p.slice(prefix.length), type: 'file' }));
            if (names.length === 0) throw new Error('ENOENT');
            return { files: names };
        },
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('@capacitor/app', () => ({
    App: { addListener: async () => ({ remove: () => {} }) },
}));

const { scheduleDraftSave, flushDraft, readDraft, draftSavedAt, clearDraft, pruneDraftOrphans } =
    await import('./draft');

beforeEach(() => {
    store.clear();
    files.clear();
    bridge.delayMs = 0;
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

describe('★ 쓰기가 겹칠 때', () => {
    /**
     * ★★ 목록(index)은 읽고-고치고-쓴다. 두 flush 가 겹치면 나중 것이
     *   **앞 것을 못 본 채** 목록을 통째로 덮어쓴다.
     *
     *   그러면 초안 **파일은 남는데 목록이 가리키지 않는다.** readDraft 가 null 을
     *   돌려주니 "저장하지 않은 편집" 을 묻지도 않는다 —
     *   사용자가 친 글이 조용히 닿을 수 없는 곳으로 간다. 신고조차 안 된다.
     *
     *   실제 경로: 편집 중에 밖에서 다른 문서가 들어와 leaveEditor() 가
     *   flushDraft() 를 **기다리지 않고** 띄운 직후, 새 문서를 편집해 초안이 나가는 것.
     */
    it('앞 문서의 초안이 목록에서 사라지지 않는다', async () => {
        bridge.delayMs = 10; // 실제 기기의 브리지 왕복

        scheduleDraftSave('content://a', 'A 의 소중한 글');
        const firstFlush = flushDraft(); // 기다리지 않는다 — 실제 코드가 그렇다

        // 그 사이 다른 문서를 편집해 초안이 나간다.
        scheduleDraftSave('content://b', 'B 의 글');
        const secondFlush = flushDraft();

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all([firstFlush, secondFlush]);

        // 확인하는 동안에는 브리지를 즉답으로 되돌린다 — 가짜 타이머를 더 돌릴 사람이 없다.
        bridge.delayMs = 0;

        expect(await readDraft('content://b')).toBe('B 의 글');
        expect(await readDraft('content://a'), 'A 의 초안이 목록에서 사라졌다').toBe(
            'A 의 소중한 글',
        );
    });

    it('★ 지우기와 쓰기가 겹쳐도 서로를 덮지 않는다', async () => {
        // A 는 이미 저장된 초안, B 는 지금 쓰는 중.
        scheduleDraftSave('content://a', 'A 의 글');
        await flushDraft();

        bridge.delayMs = 10;
        scheduleDraftSave('content://b', 'B 의 글');
        const clearing = clearDraft('content://a'); // 저장 직후 [저장]을 누른 상황
        const writing = flushDraft();

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all([writing, clearing]);
        bridge.delayMs = 0;

        // A 는 지워지고 B 는 남아야 한다. 겹치면 둘 중 하나가 상대를 덮는다.
        expect(await readDraft('content://a')).toBe(null);
        expect(await readDraft('content://b'), 'B 의 초안이 지우기에 덮였다').toBe('B 의 글');
    });

    it('같은 문서를 연달아 flush 해도 마지막 내용이 남는다', async () => {
        scheduleDraftSave('content://a', '첫 번째');
        const f1 = flushDraft();
        scheduleDraftSave('content://a', '두 번째');
        const f2 = flushDraft();

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all([f1, f2]);

        expect(await readDraft('content://a')).toBe('두 번째');
    });
});

describe('★ 닿을 수 없는 초안 정리', () => {
    it('목록이 가리키지 않는 파일을 지운다', async () => {
        scheduleDraftSave('content://a', '살아 있는 초안');
        await flushDraft();

        // v1.0.3 이하에서 목록이 덮여 쓰여 남은 파일을 흉내 낸다.
        files.set('draft/orphan1.md', '아무도 못 읽는 글');
        files.set('draft/orphan2.md', '이것도');
        expect(files.size).toBe(3);

        await pruneDraftOrphans();

        /*
         * ★★ 이런 파일은 readDraft 가 목록을 거쳐서만 찾으므로 **영원히 아무도 못 읽는다.**
         *   자리만 차지한다.
         */
        expect(files.size).toBe(1);
        expect(await readDraft('content://a')).toBe('살아 있는 초안');
    });

    it('★★ 살아 있는 초안은 건드리지 않는다', async () => {
        scheduleDraftSave('content://a', 'A');
        await flushDraft();
        scheduleDraftSave('content://b', 'B');
        await flushDraft();

        await pruneDraftOrphans();

        expect(await readDraft('content://a')).toBe('A');
        expect(await readDraft('content://b')).toBe('B');
    });

    it('★★★ 쓰기 중에 끼어들어도 방금 쓴 초안을 지우지 않는다', async () => {
        bridge.delayMs = 10;

        scheduleDraftSave('content://a', '지금 쓰는 중');
        const writing = flushDraft();
        // 파일은 써졌는데 목록이 아직 안 갱신된 그 틈을 노린다.
        const pruning = pruneDraftOrphans();

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all([writing, pruning]);
        bridge.delayMs = 0;

        /*
         * ★★ 정리를 쓰기 큐에 안 태우면 여기서 사용자 글이 사라진다 —
         *   "목록에 없네" 하고 방금 쓴 파일을 지운다. 지우는 쪽이 데이터를
         *   없애는 방향이라 겹침 사고 중에서도 제일 나쁘다.
         */
        expect(await readDraft('content://a'), '방금 쓴 초안이 정리에 지워졌다').toBe(
            '지금 쓰는 중',
        );
    });

    it('초안 폴더가 없어도 터지지 않는다', async () => {
        await expect(pruneDraftOrphans()).resolves.toBeUndefined();
    });
});

/**
 * 프로세스가 갑자기 죽는 자리 (2026-08-06).
 *
 * ★★★ 이 모듈은 **사용자가 아직 아무 데도 저장하지 않은 글**을 들고 있다.
 *   되돌릴 원본이 없으므로, 여기서 잃으면 정말로 없어지고 사용자는 잃은 줄도 모른다.
 *   그래서 '죽는 순간'과 '목록이 깨진 경우'를 못으로 박아 둔다.
 */
describe('초안 — 잃지 않는 순서', () => {
    it('★★ 파일이 디스크에 닿는 순간 목록은 이미 그 파일을 안다', async () => {
        /*
         * 왜 이걸 재는가. 예전에는 파일을 먼저 쓰고 목록을 나중에 갱신했다.
         * 그 사이에 앱이 저메모리로 죽으면 **파일은 있는데 목록이 모르는** 상태가 남고,
         * 다음 부팅의 정리기가 그걸 '닿을 수 없는 파일' 로 보고 지운다.
         * mtime 60초 가드는 그때 이미 지나 있다.
         */
        const 쓰는순간의목록: string[] = [];
        const 원래 = files.set.bind(files);
        files.set = ((path: string, data: string) => {
            쓰는순간의목록.push(store.get('draftIndex') ?? '(목록 없음)');
            return 원래(path, data);
        }) as typeof files.set;

        try {
            scheduleDraftSave('content://죽는문서', '살아남아야 하는 글');
            await vi.advanceTimersByTimeAsync(900);
        } finally {
            files.set = 원래;
        }

        expect(쓰는순간의목록).toHaveLength(1);
        expect(
            쓰는순간의목록[0],
            '파일이 먼저 쓰였다 — 여기서 죽으면 정리기가 그 글을 지운다',
        ).toContain('content://죽는문서');
    });

    it('★★ 목록이 깨져 있으면 초안을 한 개도 지우지 않는다', async () => {
        // 초안 두 개를 정상으로 만들어 둔다.
        scheduleDraftSave('content://가', '가 문서의 글');
        await vi.advanceTimersByTimeAsync(900);
        scheduleDraftSave('content://나', '나 문서의 글');
        await vi.advanceTimersByTimeAsync(900);
        expect(files.size).toBe(2);

        // 목록만 망가진다. 파일은 멀쩡하다.
        store.set('draftIndex', '{이건 JSON 이 아니다');

        await pruneDraftOrphans();

        expect(files.size, '목록 하나 깨졌다고 사용자 글을 통째로 버렸다').toBe(2);
    });

    it('목록이 배열로 들어와도 초안을 지우지 않는다', async () => {
        scheduleDraftSave('content://가', '가 문서의 글');
        await vi.advanceTimersByTimeAsync(900);

        store.set('draftIndex', '[]'); // 객체가 아니다

        await pruneDraftOrphans();
        expect(files.size).toBe(1);
    });

    it('항목 하나가 망가져도 나머지는 그대로 읽힌다', async () => {
        scheduleDraftSave('content://가', '가 문서의 글');
        await vi.advanceTimersByTimeAsync(900);

        const index = JSON.parse(store.get('draftIndex')!) as Record<string, unknown>;
        index['content://망가진것'] = { path: 42 }; // path 가 문자열이 아니다
        store.set('draftIndex', JSON.stringify(index));

        expect(await readDraft('content://가')).toBe('가 문서의 글');
        expect(await readDraft('content://망가진것')).toBeNull();
    });

    it('진짜 버려진 파일은 여전히 정리한다 (규칙이 과하지 않다)', async () => {
        scheduleDraftSave('content://가', '가 문서의 글');
        await vi.advanceTimersByTimeAsync(900);

        // 목록은 멀쩡한데 목록에 없는 파일이 하나 굴러다닌다(옛 버전이 남긴 것).
        files.set('draft/버려진것.md', '옛날 찌꺼기');
        expect(files.size).toBe(2);

        await pruneDraftOrphans();

        expect(files.has('draft/버려진것.md'), '닿을 수 없는 파일은 치워야 한다').toBe(false);
        expect(await readDraft('content://가')).toBe('가 문서의 글');
    });
});
