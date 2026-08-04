import { TipManager, TIP_PRODUCT_IDS, tipLabel } from '../../services/tip-manager';
import { t } from '../../i18n';
import { iconButton } from '../icons';

/**
 * S5 후원 화면 (7-3절 · 7-5절).
 *
 * ★ 가격을 여기에 적지 마라. 스토어가 내려준 표시 가격만 쓴다 —
 *   data-tip-price 를 TipManager.renderPrices() 가 채운다.
 *   Play Console 에서 값을 바꾸는 순간 코드에 적은 가격은 거짓이 되고,
 *   다른 통화를 쓰는 사용자에게는 처음부터 틀린 값이 보인다(정책 위반이기도 하다).
 *
 * ★ 기능을 잠그지 않는다. "후원해야 쓸 수 있는 기능"은 무료 뷰어라는 포지션을 스스로 깬다.
 *   돌려주는 것은 후원자 배지와 감사 화면뿐이다.
 */
export interface TipScreen {
    root: HTMLElement;
    refresh(): void;
}

export function createTipScreen(onBack: () => void): TipScreen {
    const root = document.createElement('div');
    root.className = 'screen screen-tip';

    const bar = document.createElement('div');
    bar.className = 'app-topbar';

    const back = iconButton('back', t.common.back, onBack);

    const title = document.createElement('h1');
    title.className = 'topbar-title';
    title.textContent = t.tip.title;

    bar.append(back, title);

    const main = document.createElement('main');
    main.className = 'home-body';

    const intro = document.createElement('p');
    intro.className = 'tip-intro';
    intro.textContent = t.tip.intro;

    const list = document.createElement('div');
    list.className = 'tip-list';

    for (const id of TIP_PRODUCT_IDS) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn tip-btn';
        btn.dataset.tipBuy = id;
        // 가격을 못 받았을 때를 대비해 기본은 비활성이다. renderPrices() 가 풀어 준다.
        btn.disabled = true;

        const label = document.createElement('span');
        label.className = 'tip-label';
        label.textContent = tipLabel(id);

        const price = document.createElement('span');
        price.className = 'tip-price';
        price.dataset.tipPrice = id;
        price.textContent = '';

        btn.append(label, price);
        btn.addEventListener('click', () => void TipManager.buy(id));
        list.appendChild(btn);
    }

    const thanks = document.createElement('p');
    thanks.className = 'tip-thanks';

    const note = document.createElement('p');
    note.className = 'setting-hint';
    note.textContent = t.tip.note;

    main.append(intro, list, thanks, note);
    root.append(bar, main);

    function refresh(): void {
        TipManager.renderPrices();
        const n = TipManager.tipCount;
        thanks.hidden = n === 0;
        thanks.textContent = n > 0 ? t.tip.thanks(n) : '';
    }

    return { root, refresh };
}
