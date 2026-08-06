import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { isSafeUrl } from './sanitize';

/**
 * CJS/ESM 상호운용 래퍼.
 * 이 플러그인들은 번들러·환경에 따라 함수 / {default:fn} / {default:{default:fn}} 로 들어온다.
 * @vscode/markdown-it-katex 는 실제로 2중 래핑되어 있어서(실측) 이 처리가 없으면
 * "plugin.apply is not a function" 으로 죽는다.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrapPlugin(m: any): any {
    if (typeof m === 'function') return m;
    if (typeof m?.default === 'function') return m.default;
    return m?.default?.default;
}

/** 한글 헤딩을 그대로 살리는 슬러그 생성기 */
export function slugify(s: string): string {
    return encodeURIComponent(
        String(s)
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[?!.,:;'"()[\]{}]/g, ''),
    );
}

export interface RendererOptions {
    /** 한 줄 개행을 <br> 로. 기본 true (6-10절) */
    breaks: boolean;
    /** 편집 모드에서 체크박스를 살릴지. 뷰어는 false */
    taskListsEnabled?: boolean;
}

export function createMarkdownIt(opts: RendererOptions): MarkdownIt {
    const md = new MarkdownIt({
        html: false, // ★ 절대 true 로 바꾸지 마라. 이게 1차 방어선이다.
        linkify: true, // 맨 URL 자동 링크. 비용 1MB당 +25ms(실측). AI 문서에 URL이 많아 켠다.
        breaks: opts.breaks,
        typographer: false, // 한국어에 스마트 따옴표는 이득이 없고 CPU만 쓴다.
        // ★ highlight 를 여기서 걸지 마라 — 거는 순간 hljs(22.6KB)가 초기 번들에 딸려 온다.
        //   코드가 있는 문서에서만 ensureHighlight(md) 로 붙인다(highlight.ts).
    });

    // ★ 반드시 덮어쓴다 — 기본값은 capacitor:// 를 통과시킨다.
    md.validateLink = isSafeUrl;

    md.use(unwrapPlugin(anchor), { permalink: false, slugify });
    md.use(unwrapPlugin(footnote));

    /*
     * ★★ enabled 를 **여기서 바꾸지 마라.** markdown-it-task-lists 는 옵션을
     *   모듈 전역에 담는다(index.js 6행 `var disableCheckboxes = true`).
     *   렌더할 때 그 전역을 읽으므로 **마지막 md.use() 가 이미 만들어 둔 인스턴스까지
     *   전부 바꿔 버린다.** 2026-08-06 실측:
     *       뷰어 인스턴스 생성 → 렌더: disabled ✓
     *       그 뒤 편집기 인스턴스 생성만 하고
     *       아까 그 뷰어 인스턴스로 다시 렌더: disabled 가 사라졌다
     *   뷰어에서 체크박스가 눌리면 사용자는 표시가 저장된 줄 알지만 아무 데도 안 남는다.
     *   (math.ts 의 `mathLoaded` 사고와 같은 종류 — '한 번만'을 잘못 둔 자리다.)
     *
     *   그래서 플러그인에는 **항상 같은 값**을 주고, 인스턴스별 차이는 아래에서 낸다.
     */
    md.use(unwrapPlugin(taskLists), { enabled: false, label: true });
    if (opts.taskListsEnabled) enableTaskCheckboxes(md);

    return md;
}

/**
 * 체크박스를 이 인스턴스에서만 누를 수 있게 만든다.
 * 플러그인이 만들어 둔 토큰을 뒤에서 손본다 — 전역을 건드리지 않는다.
 */
function enableTaskCheckboxes(md: MarkdownIt): void {
    md.core.ruler.push('marklet-task-lists-enable', (state) => {
        for (const token of state.tokens) {
            if (token.type === 'list_item_open') {
                const cls = token.attrGet('class') ?? '';
                if (cls.includes('task-list-item') && !cls.includes('enabled')) {
                    token.attrSet('class', `${cls} enabled`);
                }
                continue;
            }
            for (const child of token.children ?? []) {
                if (
                    child.type === 'html_inline' &&
                    child.content.includes('task-list-item-checkbox')
                ) {
                    child.content = child.content.replace(/\s*disabled(?:="[^"]*")?/g, '');
                }
            }
        }
        return true;
    });
}
