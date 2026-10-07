import { getSamples, clearSamples } from '../../utils/perf';
import { getErrors, clearErrors } from '../../utils/errors';
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
        clearErrors();
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

    /*
     * ── 잡히지 않은 오류.
     *
     * ★★ 여기가 없어서 실기기에서 본 예외 하나를 이틀 동안 못 쫓았다(utils/errors.ts).
     *   화면이 멀쩡해 보이는 오류는 사용자도 신고하지 않으므로, 문의가 왔을 때
     *   **함께 보내지는 것**이 유일한 단서가 된다.
     * ★ 시간 기록보다 위에 둔다. 오류가 있다면 그게 먼저 볼 것이다.
     */
    const errorList = document.createElement('div');
    errorList.className = 'diag-list';

    const errorTitle = document.createElement('h2');
    errorTitle.className = 'home-section-title';
    errorTitle.textContent = t.diagnostics.errors;

    actions.append(copy, clear);
    main.append(actions, errorTitle, errorList, table, storageTitle, storage, storageHint);
    root.append(bar, main);

    const BUCKET_LABEL: Record<string, string> = {
        snapshot: t.diagnostics.bucketSnapshot,
        backup: t.diagnostics.bucketBackup,
        draft: t.diagnostics.bucketDraft,
    };

    function renderErrors(): void {
        errorList.replaceChildren();
        const list = getErrors();
        if (list.length === 0) {
            const p = document.createElement('p');
            p.className = 'list-empty';
            p.textContent = t.diagnostics.noErrors;
            errorList.appendChild(p);
            return;
        }
        // 최신이 위로
        for (const e of [...list].reverse()) {
            const row = document.createElement('div');
            row.className = 'diag-error';

            const msg = document.createElement('div');
            msg.className = 'diag-error-msg';
            msg.textContent = e.count > 1 ? `${e.message} (×${e.count})` : e.message;

            const where = document.createElement('div');
            where.className = 'diag-error-where';
            // ★ 스택이 없을 때가 많다(네이티브가 문자열로 평가한 코드). 자리만이라도 남긴다.
            where.textContent = [e.where, e.stack].filter(Boolean).join('\n');

            const at = document.createElement('div');
            at.className = 'diag-at';
            at.textContent = new Date(e.at).toLocaleTimeString(localeTag());

            row.append(msg, where, at);
            errorList.appendChild(row);
        }
    }

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
        // ★ 오류를 복사 글에 반드시 넣는다 — 문의에서 제일 값어치 있는 부분이다.
        const errorLines = getErrors().flatMap((e) => [
            `[${e.kind}] ${e.message}${e.count > 1 ? ` (×${e.count})` : ''}`,
            `  ${e.where}`,
            ...(e.stack ? e.stack.split('\n').map((l) => `  ${l}`) : []),
        ]);
        const storageLines = lastBuckets.map(
            (b) => `${b.name}\t${b.files}개\t${formatBytes(b.bytes)}`,
        );
        return [
            `Marklet ${__APP_VERSION__}`,
            navigator.userAgent,
            '',
            ...lines,
            '',
            ...(errorLines.length ? ['-- errors --', ...errorLines, ''] : []),
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

        renderErrors();

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
