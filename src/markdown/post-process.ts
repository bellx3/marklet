import { getSettings } from '../services/settings';
import { t } from '../i18n';

/**
 * DOMPurify 가 <input> 을 지우기 전에 체크 상태를 <li> 클래스로 옮긴다.
 * ★ sanitize() 를 부르기 '전에' 문자열 단계에서 처리해야 한다.
 *   (실제 플러그인 출력으로 검증된 정규식이다. enabled:false/true 양쪽, 대문자 [X] 모두 동작)
 */
export function liftTaskCheckedState(html: string): string {
    return html.replace(
        /<li class="task-list-item([^"]*)"><label><input([^>]*\bchecked\b[^>]*)>/g,
        '<li class="task-list-item$1 checked"><label><input$2>',
    );
}

/** 청크를 DOM 에 붙인 직후 호출. 순서가 있다. */
export function postProcessSection(section: HTMLElement): void {
    wrapTables(section);
    markMermaidBlocks(section);
    applyImagePolicy(section);
}

/**
 * 표를 가로 스크롤 컨테이너로 감싼다.
 * markdown-it 출력에는 래퍼가 없다. 모바일에서 표가 화면을 밀어내는 게 흔한 사고다.
 * 경쟁 앱 한국어 리뷰에서 실제로 지적된 문제이기도 하다
 * ("가로로 긴 표의 오른쪽 열을 볼 수가 없어서").
 */
export function wrapTables(section: HTMLElement): void {
    for (const table of Array.from(section.querySelectorAll('table'))) {
        if (table.parentElement?.classList.contains('table-scroll')) continue;
        const wrap = document.createElement('div');
        wrap.className = 'table-scroll';
        // 키보드/스크린 리더로도 스크롤할 수 있게 한다(10-3절).
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', t.content.tableScrollable);
        table.replaceWith(wrap);
        wrap.appendChild(table);
    }
}

/**
 * Mermaid 코드 블록에 표시를 남긴다. ★ 여기서 그리지 않는다.
 *
 * 렌더 1단계: 다이어그램은 일단 '코드 블록'으로 보인다. 본문은 Mermaid 로딩과 무관하게
 * 즉시 읽을 수 있어야 한다. 실제 SVG 교체는 6-12절 upgradeMermaidBlocks() 가
 * 청크가 전부 붙은 뒤에 따로 한다.
 *
 * 여기서 하는 일은 두 가지뿐이다.
 *   ① 나중에 찾을 수 있게 래퍼를 씌우고 data-mermaid-src 에 원본 소스를 담는다
 *      (DOM 의 textContent 를 다시 읽으면 하이라이트가 넣은 태그 때문에 소스가 망가진다)
 *   ② 사람이 보기에 "깨진 코드"가 아니라 "아직 안 그려진 그림"으로 읽히게 라벨을 붙인다
 */
export function markMermaidBlocks(section: HTMLElement): void {
    for (const code of Array.from(section.querySelectorAll('pre > code.language-mermaid'))) {
        const pre = code.parentElement as HTMLElement;
        if (pre.parentElement?.classList.contains('mermaid-block')) continue;

        const wrap = document.createElement('div');
        wrap.className = 'mermaid-block';
        // textContent 는 하이라이트 태그를 벗겨낸 순수 소스다. 이걸 보관한다.
        wrap.dataset.mermaidSrc = code.textContent ?? '';
        wrap.dataset.mermaidState = 'pending';

        const label = document.createElement('div');
        label.className = 'md-block-label';
        label.textContent = t.mermaid.blockLabel;

        pre.replaceWith(wrap);
        wrap.append(label, pre);
    }
}

/**
 * 원격 이미지 정책. 기본은 '불러오지 않음'이다.
 * 문서를 여는 것만으로 외부 서버에 요청이 나가면 안 된다 — 사생활 문제다.
 * 끈 상태에서는 src 를 떼고 탭하면 그때 불러오는 자리표시자로 바꾼다.
 */
export function applyImagePolicy(section: HTMLElement): void {
    if (getSettings().remoteImages) return;

    for (const img of Array.from(section.querySelectorAll('img'))) {
        const src = img.getAttribute('src') ?? '';
        if (!/^https?:/i.test(src)) continue;

        const alt = img.getAttribute('alt') || t.content.image;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'md-image-placeholder';
        btn.textContent = t.content.loadRemoteImage(alt);
        btn.setAttribute('aria-label', t.content.loadRemoteImageLabel(alt));
        btn.addEventListener(
            'click',
            () => {
                img.setAttribute('src', src);
                btn.replaceWith(img);
            },
            { once: true },
        );

        img.removeAttribute('src');
        img.replaceWith(btn);
    }
}
