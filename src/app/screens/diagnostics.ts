import { getSamples, clearSamples } from '../../utils/perf';
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

    actions.append(copy, clear);
    main.append(actions, table);
    root.append(bar, main);

    function asText(): string {
        const lines = getSamples().map(
            (s) => `${new Date(s.at).toISOString()}\t${s.name}\t${s.ms.toFixed(1)}ms`,
        );
        return [`Marklet ${__APP_VERSION__}`, navigator.userAgent, '', ...lines].join('\n');
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

    function refresh(): void {
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
