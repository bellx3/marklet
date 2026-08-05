import { loadRecents, removeRecent, type RecentDoc } from '../../services/recents';
import { loadFolders, listFolder, removeFolder, type FolderListing } from '../../services/folders';
import { matchesName } from '../../utils/hangul';
import { debounce } from '../../utils/debounce';
import { icon, iconButton, type IconName } from '../icons';
import { t, localeTag } from '../../i18n';
import type { MdDocument } from '../../plugins/md-file';

/**
 * S2 시작 화면 — 최근 문서 · 내 폴더 · [파일 열기].
 *
 * ★ 내 폴더(M32)가 이 앱의 킬러 기능이다. 앱을 열 때마다 목록을 다시 읽으므로
 *   사용자가 PC 에서 새로 만든 .md 도 자동으로 나타난다.
 *
 * ★ 파일 이름 검색에는 최소 길이 제한이 없다(8-5절). 이름은 짧아서 1자도 쓸 만하다.
 */

export interface HomeCallbacks {
    openRecent(r: RecentDoc): void | Promise<void>;
    openFolderFile(doc: MdDocument): void | Promise<void>;
    pickFile(): void | Promise<void>;
    addFolder(): void | Promise<void>;
    openExample(): void | Promise<void>;
    openSettings(): void;
}

export interface HomeScreen {
    root: HTMLElement;
    refresh(): Promise<void>;
}

export function createHome(cb: HomeCallbacks): HomeScreen {
    const root = document.createElement('div');
    root.className = 'screen screen-home';

    // ── 상단 바
    const bar = document.createElement('div');
    bar.className = 'app-topbar home-topbar';

    const title = document.createElement('h1');
    title.className = 'topbar-title';
    title.textContent = 'Marklet';

    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'search-input';
    /*
     * ★ 초성 검색(8-5절)은 여기서 가르친다. 안 알려 주면 아무도 모르는 기능이다.
     *   문구가 길면 384px 화면에서 끝이 잘리므로 괄호를 버리고 가운뎃점으로 붙였다.
     */
    search.placeholder = t.home.searchPlaceholder;
    search.setAttribute('aria-label', t.home.searchLabel);
    search.autocomplete = 'off';
    search.autocapitalize = 'off';
    search.spellcheck = false;

    const settingsBtn = iconButton('settings', t.common.settings, () => cb.openSettings());

    bar.append(title, search, settingsBtn);

    // ── 본문
    const main = document.createElement('main');
    main.className = 'home-body';

    /*
     * ★ 세 칸 그리드로 고정한다. flex + wrap 이면 자리가 모자랄 때
     *   '둘 + 하나' 로 접혀서 세 번째 버튼만 폭이 달라진다(2026-08-04 실기기).
     *   그리드는 글자가 커져 두 줄이 되어도 세 칸이 같은 크기로 함께 자란다.
     */
    const actions = document.createElement('div');
    actions.className = 'home-actions';
    actions.append(
        actionBtn('fileOpen', t.home.openFile, () => void cb.pickFile(), true),
        actionBtn('folderPlus', t.home.addFolder, () => void cb.addFolder()),
        actionBtn('book', t.home.example, () => void cb.openExample()),
    );

    const recentsSection = section(t.home.recents);
    const foldersSection = section(t.home.myFolders);

    main.append(actions, recentsSection.root, foldersSection.root);
    root.append(bar, main);

    let recents: RecentDoc[] = [];
    // ★ 손으로 베낀 타입을 두지 마라 — 서비스가 필드를 늘려도 여기가 모른다.
    //   truncated 를 추가했을 때 실제로 여기서 걸렸다(2026-08-06).
    let listings: FolderListing[] = [];
    let query = '';

    const rerender = () => {
        renderRecents();
        renderFolders();
    };

    const onQuery = debounce(() => {
        query = search.value;
        rerender();
    }, 120);
    /*
     * ★★ `if (e.isComposing) return;` 을 되돌리지 마라. **초성 검색이 아예 안 돈다.**
     *
     *   검색창에서는 사용자가 마지막 글자를 치고 멈춘다 — 뒤에 스페이스도 엔터도 안 친다.
     *   그런데 한글 IME 는 마지막 음절을 조합 상태로 열어 두므로 compositionend 가
     *   영영 안 온다. 실기기에서 "ㅇㅁ" 을 쳤는데 목록 13개가 그대로였다
     *   (2026-08-06, 실제 Gboard 한국어 자판).
     *   이 앱이 내세우는 기능인데 한국어 사용자에게는 처음부터 죽어 있었다.
     *
     *   "매 자모마다 훑지 마라" 는 **디바운스가 이미 한다**(120ms).
     *   치는 동안에는 안 돌고, 멈췄을 때만 돈다.
     */
    search.addEventListener('input', () => onQuery());
    // 조합이 끝나는 순간에도 한 번 — 확정된 글자로 즉시 반응한다.
    search.addEventListener('compositionend', () => onQuery());
    search.addEventListener('keydown', (e) => {
        // ★ 조합 중인 Enter 를 가로채면 한글이 씹힌다(9-5절).
        if (e.key !== 'Enter' || e.isComposing) return;
        e.preventDefault();
        onQuery.flush();
        search.blur();
    });

    function renderRecents(): void {
        const list = recents.filter((r) => matchesName(r.name, query));
        recentsSection.body.replaceChildren();
        recentsSection.root.hidden = recents.length === 0;
        if (recents.length === 0) return;

        if (list.length === 0) {
            recentsSection.body.appendChild(empty(t.home.noMatchingDoc));
            return;
        }

        for (const r of list) {
            const item = document.createElement('div');
            item.className = 'list-item list-item--doc';

            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'list-main';
            open.addEventListener('click', () => void cb.openRecent(r));

            const name = document.createElement('span');
            name.className = 'list-name';
            name.textContent = r.name;

            /*
             * ★ 이름 아래 한 줄로 내린다. 예전에는 이름 옆에 붙였는데,
             *   배지가 있는 항목만 다음 줄로 접혀서 목록 높이가 들쭉날쭉했다(2026-08-04).
             *   보조 줄은 배지가 없어도 항상 있으므로 모든 행이 같은 높이가 된다.
             */
            const sub = document.createElement('span');
            sub.className = 'list-sub';

            const meta = document.createElement('span');
            meta.className = 'list-meta';
            meta.textContent = [formatWhen(r.lastOpened), formatSize(r.size)]
                .filter(Boolean)
                .join(' · ');
            sub.appendChild(meta);

            // ★ 사본 배지. 사용자가 사본을 편집하고 저장했다고 믿게 두면 그게 곧 데이터 유실이다.
            if (!r.persisted) {
                const badge = document.createElement('span');
                badge.className = 'badge';
                badge.textContent = r.snapshotPath ? t.home.readOnlyCopy : t.home.cannotReopen;
                sub.appendChild(badge);
            }

            open.append(name, sub);

            const del = iconButton('close', t.home.removeFromList(r.name), () => {
                void removeRecent(r.uri).then((next) => {
                    recents = next;
                    renderRecents();
                });
            });
            del.classList.add('list-remove');

            item.append(open, del);
            recentsSection.body.appendChild(item);
        }
    }

    function renderFolders(): void {
        foldersSection.body.replaceChildren();
        foldersSection.root.hidden = listings.length === 0;
        if (listings.length === 0) return;

        for (const listing of listings) {
            const head = document.createElement('div');
            head.className = 'folder-head';

            const fname = document.createElement('span');
            fname.className = 'folder-name';
            fname.textContent = listing.folder.name;

            const del = iconButton('close', t.home.removeFolder(listing.folder.name), () => {
                void removeFolder(listing.folder.uri).then(() => void refresh());
            });

            head.append(icon('folder', 16), fname, del);
            foldersSection.body.appendChild(head);

            if (listing.error) {
                const err = document.createElement('p');
                err.className = 'list-error';
                err.textContent = listing.error;
                foldersSection.body.appendChild(err);
                continue;
            }

            /*
             * ★★ 네이티브가 상한에서 멈췄으면 **반드시 말한다.**
             *   예전에는 조용히 잘렸다 — 사용자는 폴더에 파일이 더 있는데 목록에 없는 것을 보고
             *   "이 앱이 내 파일을 못 찾는다" 고 판단한다. 원인은 화면 어디에도 안 남는다.
             *
             * ★★ 걸러내기 **앞에** 둔다. 잘린 것은 검색 결과가 아니라 **목록 자체**다.
             *   뒤에 두면 "일치하는 파일 없음" 으로 빠져나가면서 안내가 통째로 사라지는데,
             *   하필 그때가 안내가 제일 필요한 순간이다 — 찾는 파일이 잘려 나간 꼬리에 있어서
             *   안 나오는 것일 수 있기 때문이다.
             */
            if (listing.truncated) {
                const note = document.createElement('p');
                note.className = 'list-error list-error--info';
                note.textContent = t.folders.truncated(listing.limit ?? listing.files.length);
                foldersSection.body.appendChild(note);
            }

            const files = listing.files.filter((f) => matchesName(f.name, query));
            if (files.length === 0) {
                foldersSection.body.appendChild(
                    empty(listing.files.length === 0 ? t.home.emptyFolder : t.home.noMatchingFile),
                );
                continue;
            }

            for (const f of files) {
                const item = document.createElement('button');
                item.type = 'button';
                item.className = 'list-item list-main';
                const name = document.createElement('span');
                name.className = 'list-name';
                name.textContent = f.name;
                const sub = document.createElement('span');
                sub.className = 'list-sub';
                const meta = document.createElement('span');
                meta.className = 'list-meta';
                meta.textContent = formatSize(f.size);
                sub.appendChild(meta);
                item.append(name, sub);
                item.addEventListener('click', () => void cb.openFolderFile(f));
                foldersSection.body.appendChild(item);
            }
        }
    }

    /**
     * ★★ 새로고침은 겹친다. 몇 군데서 부르는지 세어 보면 안다 —
     *   시작 화면 복귀 · 설정에서 나오기 · 폴더 추가 직후 · 문서 목록 변경.
     *   그런데 폴더 읽기는 SAF I/O 라 폴더가 크면 몇 초씩 걸린다.
     *
     *   세대 번호가 없으면 **먼저 시작한 느린 요청이 나중 결과를 덮는다.**
     *   사용자 눈에는 방금 추가한 폴더가 목록에서 사라진 것으로 보인다 —
     *   "폴더 추가가 안 먹었다". 원인은 화면 어디에도 안 남는다.
     *   (2026-08-05 테스트로 재현)
     */
    let refreshSeq = 0;

    async function refresh(): Promise<void> {
        const seq = ++refreshSeq;

        const nextRecents = await loadRecents();
        const folders = await loadFolders();
        // 폴더는 병렬로 읽는다. 하나가 느려도 나머지가 먼저 나온다.
        const nextListings = await Promise.all(folders.map((f) => listFolder(f)));

        // 내가 기다리는 동안 더 새 요청이 시작됐다면 그쪽이 맞다. 조용히 물러난다.
        if (seq !== refreshSeq) return;

        recents = nextRecents;
        listings = nextListings;
        rerender();
    }

    return { root, refresh };
}

function actionBtn(
    name: IconName,
    label: string,
    onClick: () => void,
    primary = false,
): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn-action${primary ? ' btn-primary' : ''}`;
    const text = document.createElement('span');
    text.textContent = label;
    b.append(icon(name), text);
    b.addEventListener('click', onClick);
    return b;
}

function section(title: string): { root: HTMLElement; body: HTMLElement } {
    const root = document.createElement('section');
    root.className = 'home-section';
    const h = document.createElement('h2');
    h.className = 'home-section-title';
    h.textContent = title;
    const body = document.createElement('div');
    body.className = 'home-list';
    root.append(h, body);
    return { root, body };
}

function empty(text: string): HTMLElement {
    const p = document.createElement('p');
    p.className = 'list-empty';
    p.textContent = text;
    return p;
}

export function formatSize(bytes: number): string {
    if (bytes < 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 상대 시각. ★ 절대 시각만 쓰면 "언제 봤더라"를 사용자가 계산해야 한다. */
export function formatWhen(at: number, now = Date.now()): string {
    const min = Math.floor((now - at) / 60000);
    if (min < 1) return t.time.justNow;
    if (min < 60) return t.time.minutesAgo(min);
    const hour = Math.floor(min / 60);
    if (hour < 24) return t.time.hoursAgo(hour);
    const day = Math.floor(hour / 24);
    if (day < 7) return t.time.daysAgo(day);
    return new Date(at).toLocaleDateString(localeTag());
}
