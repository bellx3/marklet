import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import { isSafeUrl } from './sanitize';
import { highlightCode } from './highlight';

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
        highlight: highlightCode,
    });

    // ★ 반드시 덮어쓴다 — 기본값은 capacitor:// 를 통과시킨다.
    md.validateLink = isSafeUrl;

    md.use(unwrapPlugin(anchor), { permalink: false, slugify });
    md.use(unwrapPlugin(footnote));
    md.use(unwrapPlugin(taskLists), { enabled: opts.taskListsEnabled ?? false, label: true });

    return md;
}
