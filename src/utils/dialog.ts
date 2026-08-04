import { Overlay } from '../app/overlay';
import { t } from '../i18n';

export interface DialogAction {
    label: string;
    /** 눌렀을 때 돌려줄 값 */
    value: string;
    /** 강조(파란) 버튼 */
    primary?: boolean;
    /** 되돌릴 수 없는 동작 — 위험색 */
    destructive?: boolean;
}

export interface ConfirmOptions {
    title: string;
    body: string;
    confirmText?: string;
    cancelText?: string;
    /** 되돌릴 수 없는 동작이면 true — 확인 버튼을 위험색으로 */
    destructive?: boolean;
    /**
     * 알림용. 취소 버튼을 아예 그리지 않는다.
     * ★ 같은 뜻의 버튼 두 개([확인]/[닫기])를 나란히 두면 사용자는 차이를 찾느라 멈춘다.
     *   고를 것이 없는 알림에는 버튼도 하나여야 한다.
     */
    hideCancel?: boolean;
}

let seq = 0;

/**
 * 버튼이 여러 개인 다이얼로그 (5-6절 저장 실패용).
 *
 * ★ 저장 실패를 토스트로 끝내지 마라. 출구 없는 에러 화면은
 *   픽셀오아시스 작업 #24("광고 실패 시 게임 영구 잠김")와 같은 종류의 사고다.
 *
 * @returns 누른 버튼의 value. 뒤로가기·배경 탭·Esc 로 닫히면 null.
 */
export function choiceDialog(o: {
    title: string;
    body: string;
    actions: DialogAction[];
}): Promise<string | null> {
    return new Promise((resolve) => {
        const name = `dialog-${++seq}`;
        const titleId = `${name}-title`;
        const bodyId = `${name}-body`;

        const el = document.createElement('div');
        el.className = 'dialog-backdrop';
        el.hidden = true;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-modal', 'true');
        el.setAttribute('aria-labelledby', titleId);
        el.setAttribute('aria-describedby', bodyId);

        const box = document.createElement('div');
        box.className = 'dialog';

        const h = document.createElement('h2');
        h.className = 'dialog-title';
        h.id = titleId;
        // ★ 사용자 문자열은 textContent 로만 넣는다. innerHTML 에 끼워 넣지 마라.
        h.textContent = o.title;

        const p = document.createElement('p');
        p.className = 'dialog-body';
        p.id = bodyId;
        p.textContent = o.body;

        const actions = document.createElement('div');
        actions.className = 'dialog-actions';

        let settled = false;
        const overlay = new Overlay(el, name, () => {
            el.remove();
            // 뒤로가기/배경 탭으로 닫혔으면 '선택 없음'이다.
            if (!settled) {
                settled = true;
                resolve(null);
            }
        });

        const finish = (v: string) => {
            if (settled) return;
            settled = true;
            resolve(v);
            overlay.hide();
        };

        o.actions.forEach((a, i) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `btn${a.primary ? ' btn-primary' : ''}${
                a.destructive ? ' btn-danger' : ''
            }`;
            btn.textContent = a.label;
            // 마지막(=가장 오른쪽) 버튼이 기본 포커스다.
            if (i === o.actions.length - 1) btn.dataset.autofocus = '';
            btn.addEventListener('click', () => finish(a.value));
            actions.appendChild(btn);
        });

        box.append(h, p, actions);
        el.appendChild(box);
        el.addEventListener('click', (e) => {
            if (e.target === el) overlay.hide(); // 배경 탭 = 취소
        });

        (document.querySelector('#overlay-root') ?? document.body).appendChild(el);
        overlay.show();
    });
}

/** 확인/취소. 취소·뒤로가기·배경 탭은 전부 false 다. */
export async function confirmDialog(o: ConfirmOptions): Promise<boolean> {
    const actions: DialogAction[] = [];
    if (!o.hideCancel) actions.push({ label: o.cancelText ?? t.common.cancel, value: 'cancel' });
    actions.push({
        label: o.confirmText ?? t.common.confirm,
        value: 'ok',
        primary: true,
        destructive: o.destructive,
    });
    return (await choiceDialog({ title: o.title, body: o.body, actions })) === 'ok';
}

/** 확인 버튼 하나짜리. ★ 저장 실패에는 쓰지 마라 — 출구가 있는 choiceDialog 를 써라(5-6절). */
export function alertDialog(title: string, body: string): Promise<boolean> {
    return confirmDialog({ title, body, confirmText: t.common.confirm, hideCancel: true });
}
