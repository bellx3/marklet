import { getSamples, clearSamples } from '../../utils/perf';
import { measureStorage, formatBytes, type StorageBucket } from '../../services/storage-usage';
import { Toast } from '../../utils/toast';
import { iconButton } from '../icons';
import { t, localeTag } from '../../i18n';

/**
 * 진단 화면 (12-3절).
 *
 * ★ 릴리스 빌드에서는 console 이 지워지므로 계측값을 볼 방법이 이것뿐이다.
 *   설정 화면의 버전 표시를 5번 연속 탭하면 열린다. 사용자 문의를 받을 때도 쓴다.
 */
export interface DiagnosticsScreen {
    root: HTMLElement;
    refresh(): void;
}

export function createDiagnostics(onBack: () => void): DiagnosticsScreen {
    const root = document.createElement('div');
    root.className = 'screen screen-diagnostics';

    const bar = document.createElement('div');
    bar.className = 'app-topbar';

    const back = iconButton('back', t.common.back, onBack);

    const title = document.createElement('h1');
    title.className = 'topbar-title';
    title.textContent = t.diagnostics.title;

    bar.append(back, title);

    const main = document.createElement('main');
    main.className = 'home-body';

    const table = document.createElement('div');
    table.className = 'diag-list';

    const actions = document.createElement('div');
    actions.className = 'home-actions';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn';
    copy.textContent = t.diagnostics.copy;
    copy.addEventListener('click', () => void copyAll());

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'btn';
    clear.textContent = t.diagnostics.clear;
    clear.addEventListener('click', () => {
        clearSamples();
        refresh();
    });

    /*
     * ── 앱이 보관 중인 사본.
     *
     * ★★ 이 앱은 사용자 파일을 건드리지 않는 대신 앱 안에 사본을 만든다.
     *   그런데 그건 안드로이드 '앱 정보 → 저장공간' 에만 숫자로 뜬다 —
     *   사용자는 무엇이 얼마나 쌓였는지 알 방법이 없고, 문의를 받아도 물어볼 게 없었다.
     */
    const storage = document.createElement('div');
    storage.className = 'diag-list';

    const storageTitle = document.createElement('h2');
    storageTitle.className = 'home-section-title';
    storageTitle.textContent = t.diagnostics.storage;

    const storageHint = document.createElement('p');
    storageHint.className = 'setting-hint';
    storageHint.textContent = t.diagnostics.storageHint;

    actions.append(copy, clear);
    main.append(actions, table, storageTitle, storage, storageHint);
    root.append(bar, main);

    const BUCKET_LABEL: Record<string, string> = {
        snapshot: t.diagnostics.bucketSnapshot,
        backup: t.diagnostics.bucketBackup,
        draft: t.diagnostics.bucketDraft,
    };

    function renderStorage(buckets: StorageBucket[]): void {
        storage.replaceChildren();
        for (const b of buckets) {
            const row = document.createElement('div');
            row.className = 'diag-row';

            const name = document.createElement('span');
            name.className = 'diag-name';
            name.textContent = BUCKET_LABEL[b.name] ?? b.name;

            const size = document.createElement('span');
            size.className = 'diag-ms';
            size.textContent = formatBytes(b.bytes);

            const count = document.createElement('span');
            count.className = 'diag-at';
            count.textContent = `${b.files}`;

            row.append(name, size, count);
            storage.appendChild(row);
        }
    }

    function asText(): string {
        const lines = getSamples().map(
            (s) => `${new Date(s.at).toISOString()}\t${s.name}\t${s.ms.toFixed(1)}ms`,
        );
        // ★ 사본 크기도 함께 넣는다. 문의를 받았을 때 이 한 덩이만 있으면 되게 한다.
        const storageLines = lastBuckets.map(
            (b) => `${b.name}\t${b.files}개\t${formatBytes(b.bytes)}`,
        );
        return [
            `Marklet ${__APP_VERSION__}`,
            navigator.userAgent,
            '',
            ...lines,
            '',
            ...storageLines,
        ].join('\n');
    }

    async function copyAll(): Promise<void> {
        const text = asText();
        try {
            await navigator.clipboard.writeText(text);
            Toast.success(t.diagnostics.copied);
        } catch {
            // 클립보드 권한이 없는 환경. 선택할 수 있게 화면에 펼쳐 준다.
            const pre = document.createElement('pre');
            pre.className = 'md-plain';
            pre.textContent = text;
            table.replaceChildren(pre);
            Toast.info(t.diagnostics.copyFailed);
        }
    }

    /** 마지막으로 잰 사본 크기. 복사 글에도 함께 넣는다. */
    let lastBuckets: StorageBucket[] = [];

    function refresh(): void {
        // ★ 파일 목록 읽기는 느릴 수 있다. 화면을 붙잡지 않는다.
        void measureStorage().then((b) => {
            lastBuckets = b;
            renderStorage(b);
        });

        table.replaceChildren();
        const samples = getSamples();
        if (samples.length === 0) {
            const p = document.createElement('p');
            p.className = 'list-empty';
            p.textContent = t.diagnostics.empty;
            table.appendChild(p);
            return;
        }
        // 최신이 위로
        for (const s of [...samples].reverse()) {
            const row = document.createElement('div');
            row.className = 'diag-row';

            const name = document.createElement('span');
            name.className = 'diag-name';
            name.textContent = s.name;

            const ms = document.createElement('span');
            ms.className = 'diag-ms';
            ms.textContent = `${s.ms.toFixed(1)} ms`;

            const at = document.createElement('span');
            at.className = 'diag-at';
            // ★ 'ko-KR' 을 박아 두지 마라 — 영어로 쓰는 사람에게 "오후 3:04:12" 가 나온다.
            //   i18n/index.ts 80줄이 이미 금지한 것이고 folders 정렬은 지키고 있었다.
            at.textContent = new Date(s.at).toLocaleTimeString(localeTag());

            row.append(name, ms, at);
            table.appendChild(row);
        }
    }

    return { root, refresh };
}
