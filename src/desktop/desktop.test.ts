import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { localImageUrl } from './local-image';
import { isPlainTextName, normalizeNewlines } from './doc-kind';

/**
 * 데스크톱 셸의 순수 부분. main.cjs 자체는 electron 이 있어야 돌므로 여기서 못 부른다 —
 * 그래서 main.cjs 에서 **떼어 낼 수 있는 것**(메뉴 정의 · 글자 해독 · 그림 주소)을 따로 두었다.
 * 창 · IPC · 프로토콜은 실제 Electron 을 띄워서 확인했다.
 */
const require = createRequire(import.meta.url);
const { buildMenuTemplate, buildContextTemplate, pickStrings } = require('../../desktop/menu.cjs');
const {
    decodeText,
    encodeText,
    detectEol,
    applyEol,
    hasExt,
    DOC_EXTENSIONS,
    IMAGE_EXTENSIONS,
} = require('../../desktop/text.cjs');

type Item = {
    label?: string;
    sublabel?: string;
    type?: string;
    accelerator?: string;
    enabled?: boolean;
    visible?: boolean;
    checked?: boolean;
    submenu?: Item[];
    click?: (i: Item) => void;
};

function actionsSpy() {
    const names = [
        'open',
        'openRecent',
        'clearRecent',
        'reveal',
        'copyPath',
        'closeWindow',
        'command',
        'zoom',
        'setTheme',
        'setRemoteImages',
        'fullscreen',
        'setDefault',
        'about',
    ];
    return Object.fromEntries(names.map((n) => [n, vi.fn()])) as Record<
        string,
        ReturnType<typeof vi.fn>
    >;
}

function flat(items: Item[]): Item[] {
    return items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]);
}

function build(
    over: Partial<{ hasDoc: boolean; recent: string[]; theme: string; remote: boolean }> = {},
) {
    const actions = actionsSpy();
    const tpl: Item[] = buildMenuTemplate({
        t: pickStrings('ko-KR'),
        state: {
            theme: over.theme ?? 'system',
            remoteImages: over.remote ?? false,
            recent: over.recent ?? [],
        },
        hasDoc: over.hasDoc ?? true,
        actions,
    });
    return { tpl, actions, all: flat(tpl) };
}

const find = (all: Item[], label: string) => all.find((i) => i.label === label)!;

describe('메뉴 — 꼭 필요한 것만', () => {
    it('최상위는 파일 · 보기 · 도움말 셋뿐이다', () => {
        expect(build().tpl.map((m) => m.label)).toEqual(['파일', '보기', '도움말']);
    });

    it.each([
        ['열기…', 'CmdOrCtrl+O'],
        ['저장', 'CmdOrCtrl+S'],
        ['편집', 'CmdOrCtrl+E'],
        ['인쇄…', 'CmdOrCtrl+P'],
        ['닫기', 'CmdOrCtrl+W'],
        ['목차', 'CmdOrCtrl+T'],
        ['찾기', 'CmdOrCtrl+F'],
        ['원문 보기 / 서식 보기', 'CmdOrCtrl+U'],
        ['축소', 'CmdOrCtrl+-'],
        ['원래 크기', 'CmdOrCtrl+0'],
        ['전체 화면', 'F11'],
    ])('%s 는 %s 로 닿는다', (label, accel) => {
        expect(find(build().all, label).accelerator).toBe(accel);
    });

    it('확대는 + 와 = 두 자판에 걸린다 (= 쪽은 화면에서 숨긴다)', () => {
        const zoomIns = build().all.filter((i) => i.label === '확대');
        expect(zoomIns.map((i) => i.accelerator).sort()).toEqual(['CmdOrCtrl+=', 'CmdOrCtrl+Plus']);
        expect(zoomIns.filter((i) => i.visible === false)).toHaveLength(1);
    });

    it('★ 문서가 없으면 문서에 걸린 항목은 꺼진다 — 열기·확대·전체 화면은 그대로', () => {
        const { all } = build({ hasDoc: false });
        for (const l of [
            '목차',
            '찾기',
            '원문 보기 / 서식 보기',
            '인쇄…',
            '파일 위치 열기',
            '경로 복사',
            '저장',
            '편집',
        ]) {
            expect(find(all, l).enabled, l).toBe(false);
        }
        for (const l of ['열기…', '닫기', '축소', '원래 크기', '전체 화면']) {
            expect(find(all, l).enabled, l).not.toBe(false);
        }
    });

    it('항목을 누르면 맞는 동작이 불린다', () => {
        const { all, actions } = build();
        find(all, '열기…').click!({});
        find(all, '목차').click!({});
        find(all, '찾기').click!({});
        find(all, '원문 보기 / 서식 보기').click!({});
        find(all, '인쇄…').click!({});
        find(all, 'PDF로 내보내기…').click!({});
        find(all, '원래 크기').click!({});
        find(all, '기본 앱으로 설정…').click!({});
        expect(actions.open).toHaveBeenCalledTimes(1);
        find(all, '저장').click!({});
        find(all, '편집').click!({});
        expect(actions.command.mock.calls.map((c) => c[0])).toEqual([
            'toc',
            'find',
            'source',
            'print',
            'pdf',
            'save',
            'edit',
        ]);
        expect(actions.zoom).toHaveBeenCalledWith(0);
        expect(actions.setDefault).toHaveBeenCalled();
    });

    it('테마는 라디오이고 지금 값이 체크돼 있다', () => {
        const { all, actions } = build({ theme: 'dark' });
        const radios = find(all, '테마').submenu!;
        expect(radios.map((r) => [r.label, r.checked])).toEqual([
            ['시스템', false],
            ['밝게', false],
            ['어둡게', true],
        ]);
        radios[1].click!({});
        expect(actions.setTheme).toHaveBeenCalledWith('light');
    });

    it('원격 이미지는 체크박스이고 누른 값을 그대로 넘긴다', () => {
        const { all, actions } = build({ remote: false });
        const item = find(all, '원격 이미지 불러오기');
        expect(item.type).toBe('checkbox');
        expect(item.checked).toBe(false);
        item.click!({ checked: true });
        expect(actions.setRemoteImages).toHaveBeenCalledWith(true);
    });

    it('최근 문서: 없으면 꺼진 (없음), 있으면 파일 이름과 지우기', () => {
        expect(find(build().all, '(없음)').enabled).toBe(false);

        const { all, actions } = build({ recent: ['D:\\문서\\a.md', 'D:\\문서\\b.md'] });
        const a = find(all, 'a.md');
        expect(a.sublabel).toBe('D:\\문서\\a.md');
        a.click!({});
        expect(actions.openRecent).toHaveBeenCalledWith('D:\\문서\\a.md');
        find(all, '목록 지우기').click!({});
        expect(actions.clearRecent).toHaveBeenCalled();
    });

    it('영어 기기에는 영어로 나온다', () => {
        const tpl: Item[] = buildMenuTemplate({
            t: pickStrings('en-US'),
            state: { theme: 'system', remoteImages: false, recent: [] },
            hasDoc: true,
            actions: actionsSpy(),
        });
        expect(tpl.map((m) => m.label)).toEqual(['File', 'View', 'Help']);
    });
});

describe('우클릭 메뉴', () => {
    const ctx = (hasSelection: boolean, hasDoc = true) => ({
        t: pickStrings('ko'),
        hasDoc,
        hasSelection,
        actions: actionsSpy(),
    });

    it('글자를 골랐을 때만 복사가 있다', () => {
        expect((buildContextTemplate(ctx(true)) as Item[])[0].label).toBe('복사');
        expect((buildContextTemplate(ctx(false)) as Item[]).some((i) => i.label === '복사')).toBe(
            false,
        );
    });

    it('목차 · 찾기 · 열기 · 인쇄가 닿는다', () => {
        const labels = (buildContextTemplate(ctx(false)) as Item[]).map((i) => i.label);
        for (const l of ['목차', '찾기', '열기…', '인쇄…']) expect(labels).toContain(l);
    });
});

describe('글자 해독', () => {
    it('UTF-8 은 그대로 읽는다', () => {
        const r = decodeText(Buffer.from('# 제목\n본문', 'utf8'));
        expect(r).toEqual({ text: '# 제목\n본문', encoding: 'UTF-8', bom: false });
    });

    it('★ BOM 은 글자가 아니다 — 남기면 첫 줄 제목이 제목으로 안 읽힌다', () => {
        const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# 제목', 'utf8')]);
        expect(decodeText(buf).text).toBe('# 제목');
    });

    it('★ CP949(EUC-KR) 파일은 깨진 글자가 아니라 한글로 읽는다', () => {
        // '한글' 의 CP949 바이트
        const r = decodeText(Buffer.from([0xc7, 0xd1, 0xb1, 0xdb]));
        expect(r.encoding).toBe('EUC-KR');
        expect(r.text).toBe('한글');
    });

    it('확장자 판정은 대소문자를 가리지 않고, 목록 밖은 거른다', () => {
        for (const f of ['a.md', 'A.MD', 'x.markdown', 'y.mdown', 'z.mkd', 'n.txt', 'N.TXT']) {
            expect(hasExt(f, DOC_EXTENSIONS), f).toBe(true);
        }
        for (const f of ['a.exe', 'a.bat', 'a.md.exe', 'md', 'a.']) {
            expect(hasExt(f, DOC_EXTENSIONS), f).toBe(false);
        }
        expect(hasExt('x.PNG', IMAGE_EXTENSIONS)).toBe(true);
        // ★ 문서가 가리킬 수 있는 것은 그림뿐이다. 실행 파일·스크립트·웹 문서는 내주지 않는다.
        for (const f of ['x.exe', 'x.html', 'x.js', 'x.txt']) {
            // .txt 는 문서이지 그림이 아니다
            expect(hasExt(f, IMAGE_EXTENSIONS), f).toBe(false);
        }
    });
});

describe('상대 경로 그림 주소', () => {
    const dir = 'C:\\Users\\a\\docs';
    const dec = (u: string | null) =>
        u ? decodeURIComponent(u.replace('marklet-local://f/', '')) : null;

    it('문서 폴더 기준으로 푼다', () => {
        expect(dec(localImageUrl('img/a.png', dir))).toBe('C:/Users/a/docs/img/a.png');
        expect(dec(localImageUrl('./a.png', dir))).toBe('C:/Users/a/docs/a.png');
    });

    it('.. 로 위 폴더도 간다', () => {
        expect(dec(localImageUrl('../assets/a.png', dir))).toBe('C:/Users/a/assets/a.png');
    });

    it('한글 · 공백이 든 이름도 풀린다', () => {
        expect(dec(localImageUrl('그림/내 사진.png', dir))).toBe(
            'C:/Users/a/docs/그림/내 사진.png',
        );
        expect(dec(localImageUrl('%EA%B7%B8%EB%A6%BC/a%20b.png', dir))).toBe(
            'C:/Users/a/docs/그림/a b.png',
        );
    });

    it('★ 원격 · data · 절대 경로는 건드리지 않는다', () => {
        for (const s of ['https://x/a.png', 'data:image/png;base64,AAAA', '/a.png', '//h/a.png']) {
            expect(localImageUrl(s, dir), s).toBeNull();
        }
    });

    it('빈 값이면 아무것도 하지 않는다', () => {
        expect(localImageUrl('', dir)).toBeNull();
        expect(localImageUrl('a.png', '')).toBeNull();
    });
});

describe('저장 — 열린 그대로 되돌려 쓴다', () => {
    it('★ UTF-8 · BOM 유무를 보존한다', () => {
        const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('가', 'utf8')]);
        const d = decodeText(withBom);
        expect(d).toMatchObject({ text: '가', encoding: 'UTF-8', bom: true });
        expect(encodeText(d.text, d.encoding, d.bom).equals(withBom)).toBe(true);

        const plain = Buffer.from('가', 'utf8');
        const p = decodeText(plain);
        expect(p.bom).toBe(false);
        expect(encodeText(p.text, p.encoding, p.bom).equals(plain)).toBe(true);
    });

    it('★ EUC-KR(CP949) 파일은 EUC-KR 로 되돌려 쓴다 — 읽고 바로 쓰면 같은 바이트다', () => {
        // '한글 테스트 가나다 abc 123' 을 CP949 바이트로 직접 적었다
        const original = Buffer.from([
            0xc7, 0xd1, 0xb1, 0xdb, 0x20, 0xc5, 0xd7, 0xbd, 0xba, 0xc6, 0xae, 0x20, 0xb0, 0xa1,
            0xb3, 0xaa, 0xb4, 0xd9, 0x20, 0x61, 0x62, 0x63, 0x20, 0x31, 0x32, 0x33,
        ]);
        const d = decodeText(original);
        expect(d.encoding).toBe('EUC-KR');
        expect(d.text).toBe('한글 테스트 가나다 abc 123');
        expect(encodeText(d.text, d.encoding, d.bom).equals(original)).toBe(true);
    });

    it('★ 고친 글도 EUC-KR 로 쓴다 — 한글을 더해도 깨지지 않는다', () => {
        const buf = encodeText('안녕하세요 수정', 'EUC-KR', false);
        expect(buf).not.toBeNull();
        expect(decodeText(buf).text).toBe('안녕하세요 수정');
    });

    it('★ EUC-KR 로 못 쓰는 글자(이모지)가 들어오면 몰래 깨뜨리지 않고 null 을 돌려준다', () => {
        expect(encodeText('안녕 😀', 'EUC-KR', false)).toBeNull();
    });

    it('UTF-16 파일(메모장의 유니코드)도 읽고 같은 형식으로 쓴다', () => {
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('가a', 'utf16le')]);
        const d = decodeText(le);
        expect(d).toMatchObject({ text: '가a', encoding: 'UTF-16LE' });
        expect(encodeText(d.text, d.encoding, d.bom).equals(le)).toBe(true);

        const be = Buffer.concat([
            Buffer.from([0xfe, 0xff]),
            Buffer.from('가a', 'utf16le').swap16(),
        ]);
        const b = decodeText(be);
        expect(b).toMatchObject({ text: '가a', encoding: 'UTF-16BE' });
        expect(encodeText(b.text, b.encoding, b.bom).equals(be)).toBe(true);
    });

    it('★ 줄바꿈 방식(CRLF/LF)을 알아보고 그대로 되돌린다', () => {
        expect(detectEol('a\r\nb\r\nc')).toBe('\r\n');
        expect(detectEol('a\nb\nc')).toBe('\n');
        expect(detectEol('한 줄')).toBe('\n');
        // 섞여 있으면 많은 쪽
        expect(detectEol('a\r\nb\r\nc\nd')).toBe('\r\n');
        expect(detectEol('a\r\nb\nc\nd')).toBe('\n');

        // 화면(LF)에서 고친 글이 파일의 줄바꿈으로 돌아간다
        expect(applyEol('a\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
        expect(applyEol('a\nb', '\n')).toBe('a\nb');
        // 이미 CRLF 가 섞여 들어와도 이중으로 늘지 않는다
        expect(applyEol('a\r\nb\nc', '\r\n')).toBe('a\r\nb\r\nc');
    });

    it('★ 읽고 → 아무것도 안 고치고 → 쓰면 바이트가 그대로다 (CRLF + BOM + 한글)', () => {
        const original = Buffer.from('\uFEFF# 제목\r\n\r\n본문 한 줄\r\n', 'utf8');
        const d = decodeText(original);
        const eol = detectEol(d.text);
        const screen = normalizeNewlines(d.text); // 편집기가 돌려주는 모양(LF)
        const out = encodeText(applyEol(screen, eol), d.encoding, d.bom);
        expect(out.equals(original)).toBe(true);
    });
});

describe('문서 종류', () => {
    it('.txt 만 서식 없이 본다', () => {
        for (const n of ['a.txt', 'A.TXT', '메모.txt']) expect(isPlainTextName(n), n).toBe(true);
        for (const n of ['a.md', 'a.markdown', 'txt', 'a.txt.md', 'a.text']) {
            expect(isPlainTextName(n), n).toBe(false);
        }
    });

    it('★ 줄바꿈 통일 — 파일(CRLF)과 편집기(LF)를 비교해도 수정됨이 되지 않는다', () => {
        expect(normalizeNewlines('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
        expect(normalizeNewlines('a\r\nb')).toBe(normalizeNewlines('a\nb'));
    });
});
