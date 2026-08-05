import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * S2 시작 화면.
 *
 * ★ 여기서 지키려는 것은 두 가지다.
 *   1) **초성 검색** — 이 앱의 차별점이다(8-5절). 조용히 망가지면 아무도 신고하지 않는다.
 *   2) **사본 배지** — 사용자가 사본을 원본으로 착각한 채 고치면 그게 곧 데이터 유실이다.
 */

const h = vi.hoisted(() => ({
    store: new Map<string, string>(),
    /** uri → 그 폴더가 돌려줄 파일들. 지연을 주려면 delay 를 함께 넣는다. */
    folderFiles: new Map<string, { files: Array<{ name: string }>; delayMs?: number }>(),
    deleted: [] as string[],
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: h.store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            h.store.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            h.store.delete(key);
        },
    },
}));

vi.mock('@capacitor/filesystem', () => ({
    Filesystem: {
        mkdir: vi.fn(async () => {}),
        writeFile: vi.fn(async () => ({ uri: '' })),
        readFile: vi.fn(async () => ({ data: '' })),
        deleteFile: vi.fn(async ({ path }: { path: string }) => {
            h.deleted.push(path);
        }),
    },
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));

vi.mock('../../plugins/md-file', () => ({
    MdFile: {
        listFolder: vi.fn(async ({ uri }: { uri: string }) => {
            const entry = h.folderFiles.get(uri);
            if (!entry) throw Object.assign(new Error('no perm'), { code: 'EPERM' });
            if (entry.delayMs) await new Promise((r) => setTimeout(r, entry.delayMs));
            return {
                files: entry.files.map((f) => ({
                    uri: `${uri}/${f.name}`,
                    name: f.name,
                    size: 100,
                    mimeType: 'text/markdown',
                    writable: true,
                })),
            };
        }),
        releaseUri: vi.fn(async () => {}),
    },
}));

import { createHome, formatSize, formatWhen, type HomeScreen } from './home';
import { t } from '../../i18n';
import type { RecentDoc } from '../../services/recents';

const cb = {
    openRecent: vi.fn(),
    openFolderFile: vi.fn(),
    pickFile: vi.fn(),
    addFolder: vi.fn(),
    openExample: vi.fn(),
    openSettings: vi.fn(),
};

let home: HomeScreen;

function seedRecents(...docs: Array<Partial<RecentDoc>>): void {
    const list = docs.map((d, i) => ({
        uri: `content://docs/${i}.md`,
        name: `문서${i}.md`,
        lastOpened: 1_700_000_000_000 - i * 1000,
        persisted: true,
        size: 1024,
        source: 'picker' as const,
        ...d,
    }));
    h.store.set('recentDocs', JSON.stringify(list));
}

function seedFolder(uri: string, name: string, files: string[], delayMs?: number): void {
    const prev = JSON.parse(h.store.get('folders') ?? '[]') as unknown[];
    h.store.set('folders', JSON.stringify([...prev, { uri, name, addedAt: 1_700_000_000_000 }]));
    h.folderFiles.set(uri, { files: files.map((f) => ({ name: f })), delayMs });
}

function names(sel: string): string[] {
    return [...home.root.querySelectorAll(sel)].map((el) => el.textContent ?? '');
}

function typeSearch(value: string): void {
    const input = home.root.querySelector<HTMLInputElement>('.search-input')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
}

beforeEach(() => {
    vi.useFakeTimers();
    h.store.clear();
    h.folderFiles.clear();
    h.deleted.length = 0;
    Object.values(cb).forEach((f) => f.mockClear());
    home = createHome(cb);
    document.body.appendChild(home.root);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('최근 문서', () => {
    it('목록이 비면 그 구획을 통째로 감춘다', async () => {
        await home.refresh();
        expect(home.root.querySelectorAll<HTMLElement>('.home-section')[0].hidden).toBe(true);
    });

    it('이름과 보조 줄을 그린다', async () => {
        seedRecents({ name: '회의록.md', size: 2048 });
        await home.refresh();
        expect(names('.list-name')).toEqual(['회의록.md']);
        expect(home.root.querySelector('.list-meta')?.textContent).toContain('2 KB');
    });

    it('★ 다시 못 여는 문서에 배지를 단다', async () => {
        seedRecents(
            { name: '사본있음.md', persisted: false, snapshotPath: 'snapshot/1-a.md' },
            { name: '사본없음.md', persisted: false },
            { name: '멀쩡함.md', persisted: true },
        );
        await home.refresh();

        /*
         * ★★ 사본을 원본으로 착각한 채 고치면 그게 곧 데이터 유실이다.
         *   배지가 사라지면 아무도 신고하지 않고 조용히 잃는다.
         */
        expect(names('.badge')).toEqual([t.home.readOnlyCopy, t.home.cannotReopen]);
    });

    it('누르면 그 문서를 연다', async () => {
        seedRecents({ name: 'a.md' });
        await home.refresh();
        home.root.querySelector<HTMLButtonElement>('.list-main')!.click();
        expect(cb.openRecent).toHaveBeenCalledOnce();
    });

    it('× 를 누르면 목록에서 빠지고 사본도 지운다', async () => {
        seedRecents({ name: 'a.md', persisted: false, snapshotPath: 'snapshot/1-a.md' });
        await home.refresh();

        home.root.querySelector<HTMLButtonElement>('.list-remove')!.click();
        await vi.advanceTimersByTimeAsync(50);

        expect(names('.list-name')).toEqual([]);
        // 사본을 안 지우면 앱 저장소에 영영 남는다.
        expect(h.deleted).toContain('snapshot/1-a.md');
    });
});

describe('★ 초성 검색 (8-5절)', () => {
    beforeEach(async () => {
        seedRecents({ name: '회의록.md' }, { name: '가계부.md' }, { name: 'readme.md' });
        await home.refresh();
    });

    it('초성만으로 찾는다', async () => {
        typeSearch('ㅎㅇ');
        await vi.advanceTimersByTimeAsync(200); // debounce 120ms
        expect(names('.list-name')).toEqual(['회의록.md']);
    });

    it('한 글자도 받는다 — 이름은 짧다', async () => {
        typeSearch('ㄱ');
        await vi.advanceTimersByTimeAsync(200);
        expect(names('.list-name')).toEqual(['가계부.md']);
    });

    it('영문은 대소문자를 가리지 않는다', async () => {
        typeSearch('README');
        await vi.advanceTimersByTimeAsync(200);
        expect(names('.list-name')).toEqual(['readme.md']);
    });

    it('하나도 안 맞으면 그렇게 말한다 — 구획을 감추지 않는다', async () => {
        typeSearch('없는이름');
        await vi.advanceTimersByTimeAsync(200);
        expect(names('.list-name')).toEqual([]);
        expect(home.root.querySelector('.list-empty')?.textContent).toBe(t.home.noMatchingDoc);
    });

    it('한글 조합 중에는 훑지 않는다', async () => {
        const input = home.root.querySelector<HTMLInputElement>('.search-input')!;
        input.value = 'ㅎ';
        // isComposing 인 input 은 무시된다 — 조합 중 글자로 목록이 튀면 안 된다.
        input.dispatchEvent(
            Object.assign(new Event('input'), { isComposing: true }) as unknown as Event,
        );
        await vi.advanceTimersByTimeAsync(200);
        expect(names('.list-name')).toHaveLength(3);

        input.value = '회';
        input.dispatchEvent(new Event('compositionend'));
        await vi.advanceTimersByTimeAsync(200);
        expect(names('.list-name')).toEqual(['회의록.md']);
    });
});

describe('내 폴더', () => {
    it('파일을 이름순으로 그린다', async () => {
        seedFolder('content://tree/work', '업무', ['b.md', 'a.md']);
        await home.refresh();
        expect(names('.list-name')).toEqual(['a.md', 'b.md']);
    });

    it('권한이 끊긴 폴더를 지우지 않고 사유를 보여 준다', async () => {
        // ★ SD 카드를 잠깐 뺐을 뿐일 수 있다. 자동으로 지우면 안 된다.
        h.store.set(
            'folders',
            JSON.stringify([{ uri: 'content://tree/gone', name: '사라짐', addedAt: 1 }]),
        );
        await home.refresh();

        expect(home.root.querySelector('.list-error')?.textContent).toBe(t.folders.expired);
        expect(home.root.querySelector('.folder-name')?.textContent).toBe('사라짐');
    });

    it('빈 폴더와 검색 결과 없음을 구분해서 말한다', async () => {
        seedFolder('content://tree/empty', '빈폴더', []);
        await home.refresh();
        expect(home.root.querySelector('.list-empty')?.textContent).toBe(t.home.emptyFolder);

        seedFolder('content://tree/x', 'x', []);
        typeSearch('없음');
        await vi.advanceTimersByTimeAsync(200);
        expect(home.root.querySelector('.list-empty')?.textContent).toBe(t.home.emptyFolder);
    });
});

describe('★ refresh 가 겹칠 때', () => {
    it('느린 앞 요청이 새 결과를 덮어쓰지 않는다', async () => {
        // 느린 폴더 하나만 있는 상태로 첫 새로고침을 띄운다.
        seedFolder('content://tree/slow', '느림', ['옛파일.md'], 300);
        const first = home.refresh();

        // ★ 여기서 한 틱 흘려야 한다. 그래야 R1 이 loadFolders() 까지 지나
        //   '느림 하나뿐'인 목록을 손에 쥔 채 listFolder 를 기다리는 상태가 된다.
        //   그 전에 저장소를 건드리면 R1 도 새 목록을 읽어 버려 경쟁이 안 만들어진다.
        await vi.advanceTimersByTimeAsync(0);

        // 그 사이 폴더가 하나 더 붙었다(사용자가 '폴더 추가'를 눌렀다).
        seedFolder('content://tree/fast', '빠름', ['새파일.md']);
        h.folderFiles.set('content://tree/slow', { files: [{ name: '옛파일.md' }] });
        const second = home.refresh();

        await vi.advanceTimersByTimeAsync(500);
        await Promise.all([first, second]);

        /*
         * ★★ 앞 요청이 늦게 끝나면서 listings 를 옛 것으로 덮으면
         *   방금 추가한 폴더가 목록에서 사라진다 — 사용자에게는
         *   "폴더 추가가 안 먹었다" 로 보인다. 원인은 화면 어디에도 안 남는다.
         */
        expect(names('.folder-name')).toEqual(['느림', '빠름']);
    });
});

describe('formatSize', () => {
    it('알 수 없으면 빈 문자열', () => {
        expect(formatSize(-1)).toBe('');
    });
    it('경계값', () => {
        expect(formatSize(0)).toBe('0 B');
        expect(formatSize(1023)).toBe('1023 B');
        expect(formatSize(1024)).toBe('1 KB');
        expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    });
});

describe('formatWhen', () => {
    const now = 1_700_000_000_000;
    it('방금 · 분 · 시간 · 일', () => {
        expect(formatWhen(now, now)).toBe(t.time.justNow);
        expect(formatWhen(now - 5 * 60_000, now)).toBe(t.time.minutesAgo(5));
        expect(formatWhen(now - 3 * 3_600_000, now)).toBe(t.time.hoursAgo(3));
        expect(formatWhen(now - 2 * 86_400_000, now)).toBe(t.time.daysAgo(2));
    });
    it('일주일이 넘으면 날짜로 적는다', () => {
        const out = formatWhen(now - 30 * 86_400_000, now);
        expect(out).not.toContain(t.time.justNow);
        expect(out).toMatch(/\d/);
    });
});
