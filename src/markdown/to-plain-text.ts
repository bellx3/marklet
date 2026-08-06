/**
 * 렌더된 문서를 **읽기 좋은 글자**로 바꾼다 (5-8절 공유 3형태 중 하나).
 *
 * ★ 왜 마크다운 원문을 정규식으로 벗기지 않는가.
 *   `#`·`|`·`*` 를 지우는 방식은 코드 블록 안의 `#` 까지 지우고, 표는 여전히 깨지고,
 *   각주·체크박스 상태처럼 **렌더 단계에서만 결정되는 것**을 놓친다.
 *   우리는 이미 그 문서를 그려 봤다. 그 결과를 걸어 다니며 글자로 옮기는 쪽이 정확하다.
 *
 * ★ 화면의 DOM 을 쓰지 않고 **따로 한 번 더 그린다.** 화면 쪽은 청크가 덜 붙어 있을 수
 *   있고(6-3절), 공유하려고 renderRest() 를 부르면 큰 문서에서 화면이 멈춘다.
 *
 * ★ 살릴 수 없는 것은 **정직하게 자리만 남긴다.** 다이어그램·이미지는 글자로 못 만든다.
 *   조용히 빼면 받는 사람은 문서가 원래 그런 줄 안다.
 */

import { t } from '../i18n';

const BULLET = '• ';
const INDENT = '  ';

export interface PlainTextOptions {
    /** 문서 제목을 맨 앞에 넣는다 */
    title?: string;
}

/**
 * @param html 살균까지 끝난 렌더 결과 HTML
 */
export function htmlToPlainText(html: string, opts: PlainTextOptions = {}): string {
    const host = document.createElement('div');
    host.innerHTML = html;

    const out: string[] = [];
    if (opts.title) out.push(opts.title, '');

    for (const node of Array.from(host.childNodes)) walkBlock(node, out, 0);

    return out
        .join('\n')
        .replace(/\n{3,}/g, '\n\n') // 빈 줄이 세 줄 넘게 이어지지 않게
        .trim();
}

function walkBlock(node: Node, out: string[], depth: number): void {
    if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.nodeValue ?? '').trim();
        if (t) out.push(t);
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    switch (tag) {
        case 'h1':
        case 'h2':
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
            out.push('', inline(el), '');
            return;

        case 'p':
            out.push(inline(el), '');
            return;

        case 'ul':
        case 'ol':
            walkList(el, out, depth);
            out.push('');
            return;

        case 'blockquote': {
            const inner: string[] = [];
            for (const c of Array.from(el.childNodes)) walkBlock(c, inner, depth);
            // 인용은 들여쓰기로 표시한다. '>' 를 다시 넣으면 마크다운 기호가 되살아난다.
            for (const line of inner.join('\n').trim().split('\n')) {
                out.push(line ? `${INDENT}${line}` : '');
            }
            out.push('');
            return;
        }

        case 'pre':
            // 코드는 기호가 곧 내용이다. 손대지 않는다.
            out.push(el.textContent?.replace(/\n+$/, '') ?? '', '');
            return;

        case 'table':
            walkTable(el, out);
            out.push('');
            return;

        case 'hr':
            out.push('────────────', '');
            return;

        case 'img':
            out.push(t.plain.image(el.getAttribute('alt') || t.plain.noAlt), '');
            return;

        default:
            break;
    }

    // 다이어그램 — 글자로 옮길 수 없다. 자리만 남긴다.
    if (el.classList.contains('mermaid-block')) {
        out.push(t.plain.diagram, '');
        return;
    }
    // 이미지 자리표시자(원격 이미지 정책, 6-4절)
    if (el.classList.contains('md-image-placeholder')) {
        out.push(t.plain.image(el.getAttribute('aria-label') ?? ''), '');
        return;
    }

    for (const c of Array.from(el.childNodes)) walkBlock(c, out, depth);
}

/**
 * 목록 항목 안에서 **inline() 에 넘기면 안 되는** 것들.
 *
 * ★★ inline() 은 이어진 공백을 한 칸으로 줄인다. 문단에서는 맞지만
 *   코드 안에서는 **들여쓰기가 곧 문법**이다. 파이썬·YAML·JSON 이 통째로 망가진다.
 *   2026-08-06 실측:
 *       1. 설정 파일을 만듭니다        →   {
 *          ```json                         "port": 3000,     ← 두 칸이 한 칸으로
 *          {                              }
 *            "port": 3000,
 *          }
 *   그리고 AI 가 쓴 설치 안내는 거의 항상 "1. …" 아래에 코드 블록을 놓는다.
 *   즉 가장 흔한 모양이 가장 크게 깨져 있었다. 게다가 이 글은 **남에게 보내는 글**이다.
 */
const LIST_BLOCK_TAGS = new Set(['ul', 'ol', 'pre', 'blockquote', 'table']);

function walkList(list: HTMLElement, out: string[], depth: number): void {
    const ordered = list.tagName.toLowerCase() === 'ol';
    let index = Number(list.getAttribute('start') ?? '1') || 1;

    for (const li of Array.from(list.children)) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const item = li as HTMLElement;

        // 체크박스는 DOMPurify 가 <input> 을 지우므로 클래스로 판정한다(6-4절).
        let marker: string;
        if (item.classList.contains('task-list-item')) {
            marker = item.classList.contains('checked') ? '☑ ' : '☐ ';
        } else {
            marker = ordered ? `${index++}. ` : BULLET;
        }

        // 블록 자식은 떼어 두고 따로 옮긴다 — 본문에 섞이면 한 줄로 뭉친다(위 주석).
        const blocks = Array.from(item.children).filter((c) =>
            LIST_BLOCK_TAGS.has(c.tagName.toLowerCase()),
        );
        for (const b of blocks) b.remove();

        out.push(`${INDENT.repeat(depth)}${marker}${inline(item)}`);

        const pad = INDENT.repeat(depth + 1);
        for (const b of blocks) {
            const tag = b.tagName.toLowerCase();
            if (tag === 'ul' || tag === 'ol') {
                walkList(b as HTMLElement, out, depth + 1);
                continue;
            }
            // ★ 한 단계만 들여쓴다. 안쪽 들여쓰기는 손대지 않는다 — 그게 요점이다.
            const sub: string[] = [];
            walkBlock(b, sub, depth + 1);
            for (const line of sub.join('\n').replace(/\n+$/, '').split('\n')) {
                out.push(line ? pad + line : '');
            }
        }
    }
}

/**
 * 표. ★ 구분선(`|---|---|`)은 버리고 셀 구분자는 남긴다.
 *   기호가 지저분해 보이는 건 구분선 쪽이고, 열 구분이 없으면 표는 아예 못 읽는다.
 */
function walkTable(table: HTMLElement, out: string[]): void {
    for (const row of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(row.querySelectorAll('th, td')).map((c) =>
            inline(c as HTMLElement),
        );
        if (cells.length) out.push(cells.join(' | '));
    }
}

/** 인라인 요소를 글자로. 링크는 주소를 괄호로 남긴다 — 지우면 정보가 사라진다. */
function inline(el: HTMLElement): string {
    const parts: string[] = [];

    const visit = (node: Node): void => {
        if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue ?? '');
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const e = node as HTMLElement;
        const tag = e.tagName.toLowerCase();

        if (tag === 'br') {
            parts.push('\n');
            return;
        }
        if (tag === 'img') {
            parts.push(t.plain.image(e.getAttribute('alt') || t.plain.noAlt));
            return;
        }
        // ★ KaTeX 는 같은 수식을 HTML 과 MathML 로 두 번 넣는다. 그대로 두면 두 번 나온다.
        //   TeX 원문이 annotation 에 들어 있으므로 그걸 쓰고 나머지는 건너뛴다(8-6절과 같은 함정).
        if (e.classList.contains('katex')) {
            const tex = e.querySelector('annotation')?.textContent?.trim();
            parts.push(tex ? `$${tex}$` : (e.querySelector('.katex-html')?.textContent ?? ''));
            return;
        }
        if (tag === 'a') {
            const href = e.getAttribute('href') ?? '';
            const text = e.textContent ?? '';
            // 각주 앵커(#fn1)까지 주소를 붙이면 지저분하다. 문서 밖 주소만 남긴다.
            parts.push(href && !href.startsWith('#') && href !== text ? `${text} (${href})` : text);
            return;
        }
        for (const c of Array.from(e.childNodes)) visit(c);
    };

    for (const c of Array.from(el.childNodes)) visit(c);
    return parts
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim();
}
