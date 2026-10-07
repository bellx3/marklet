'use strict';

/**
 * 메뉴 정의 — 순수 함수. electron 을 부르지 않아서 시험할 수 있다.
 *
 * ★ 메뉴는 '꼭 필요한 것'만 둔다. 사진 뷰어처럼 화면에는 문서만 보이고,
 *   메뉴는 Alt 를 누르거나 우클릭하면 나온다(main.cjs 의 autoHideMenuBar).
 *   항목을 늘리고 싶어지면 먼저 그게 정말 문서를 읽는 데 필요한지 물어라.
 */

const STRINGS = {
    ko: {
        file: '파일',
        open: '열기…',
        recent: '최근 문서',
        noRecent: '(없음)',
        clearRecent: '목록 지우기',
        reveal: '파일 위치 열기',
        copyPath: '경로 복사',
        print: '인쇄…',
        close: '닫기',
        view: '보기',
        toc: '목차',
        find: '찾기',
        source: '원문 보기 / 서식 보기',
        zoomIn: '확대',
        zoomOut: '축소',
        zoomReset: '원래 크기',
        theme: '테마',
        themeSystem: '시스템',
        themeLight: '밝게',
        themeDark: '어둡게',
        remote: '원격 이미지 불러오기',
        fullscreen: '전체 화면',
        help: '도움말',
        setDefault: '기본 앱으로 설정…',
        about: 'Marklet 정보',
        copy: '복사',
        selectAll: '모두 선택',
        save: '저장',
        edit: '편집',
        dlgSaveTitle: '변경 내용을 저장할까요?',
        dlgSave: '저장',
        dlgDontSave: '저장 안 함',
        dlgCancel: '취소',
        dlgConflictTitle: '파일이 다른 곳에서 바뀌었습니다',
        dlgConflictBody: '지금 저장하면 그 변경을 덮어씁니다.',
        dlgOverwrite: '덮어쓰기',
        dlgEncodingTitle: '이 인코딩으로 저장할 수 없는 글자가 있습니다',
        dlgEncodingBody:
            'UTF-8 로 저장하면 모든 글자를 보존합니다. 다른 프로그램에서 이 파일을 열 때 한글이 깨질 수 있습니다.',
        dlgSaveUtf8: 'UTF-8 로 저장',
    },
    en: {
        file: 'File',
        open: 'Open…',
        recent: 'Recent',
        noRecent: '(none)',
        clearRecent: 'Clear list',
        reveal: 'Show in folder',
        copyPath: 'Copy path',
        print: 'Print…',
        close: 'Close',
        view: 'View',
        toc: 'Outline',
        find: 'Find',
        source: 'Show source / rendered',
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        zoomReset: 'Actual size',
        theme: 'Theme',
        themeSystem: 'System',
        themeLight: 'Light',
        themeDark: 'Dark',
        remote: 'Load remote images',
        fullscreen: 'Full screen',
        help: 'Help',
        setDefault: 'Set as default app…',
        about: 'About Marklet',
        copy: 'Copy',
        selectAll: 'Select all',
        save: 'Save',
        edit: 'Edit',
        dlgSaveTitle: 'Save changes?',
        dlgSave: 'Save',
        dlgDontSave: "Don't save",
        dlgCancel: 'Cancel',
        dlgConflictTitle: 'The file was changed elsewhere',
        dlgConflictBody: 'Saving now will overwrite that change.',
        dlgOverwrite: 'Overwrite',
        dlgEncodingTitle: 'Some characters cannot be saved in this encoding',
        dlgEncodingBody:
            'Saving as UTF-8 keeps every character. Other programs may show garbled text for this file.',
        dlgSaveUtf8: 'Save as UTF-8',
    },
};

function pickStrings(locale) {
    return String(locale || '')
        .toLowerCase()
        .startsWith('ko')
        ? STRINGS.ko
        : STRINGS.en;
}

/**
 * @param ctx.t       pickStrings() 의 결과
 * @param ctx.state   { theme, remoteImages, recent: string[] }
 * @param ctx.hasDoc  지금 창에 문서가 열려 있는가 (문서가 있어야 뜻이 있는 항목은 끈다)
 * @param ctx.actions main.cjs 가 주는 동작들
 */
function buildMenuTemplate(ctx) {
    const { t, state, hasDoc, actions: a } = ctx;
    const base = (p) => p.split(/[\\/]/).pop();

    const recent = state.recent.length
        ? [
              ...state.recent.map((p) => ({
                  label: base(p),
                  sublabel: p,
                  click: () => a.openRecent(p),
              })),
              { type: 'separator' },
              { label: t.clearRecent, click: () => a.clearRecent() },
          ]
        : [{ label: t.noRecent, enabled: false }];

    return [
        {
            label: t.file,
            submenu: [
                { label: t.open, accelerator: 'CmdOrCtrl+O', click: () => a.open() },
                { label: t.recent, submenu: recent },
                {
                    label: t.save,
                    accelerator: 'CmdOrCtrl+S',
                    enabled: hasDoc,
                    click: () => a.command('save'),
                },
                { type: 'separator' },
                { label: t.reveal, enabled: hasDoc, click: () => a.reveal() },
                { label: t.copyPath, enabled: hasDoc, click: () => a.copyPath() },
                { type: 'separator' },
                {
                    label: t.print,
                    accelerator: 'CmdOrCtrl+P',
                    enabled: hasDoc,
                    click: () => a.command('print'),
                },
                { label: t.close, accelerator: 'CmdOrCtrl+W', click: () => a.closeWindow() },
            ],
        },
        {
            label: t.view,
            submenu: [
                {
                    label: t.edit,
                    accelerator: 'CmdOrCtrl+E',
                    enabled: hasDoc,
                    click: () => a.command('edit'),
                },
                { type: 'separator' },
                {
                    label: t.toc,
                    accelerator: 'CmdOrCtrl+T',
                    enabled: hasDoc,
                    click: () => a.command('toc'),
                },
                {
                    label: t.find,
                    accelerator: 'CmdOrCtrl+F',
                    enabled: hasDoc,
                    click: () => a.command('find'),
                },
                {
                    label: t.source,
                    accelerator: 'CmdOrCtrl+U',
                    enabled: hasDoc,
                    click: () => a.command('source'),
                },
                { type: 'separator' },
                { label: t.zoomIn, accelerator: 'CmdOrCtrl+Plus', click: () => a.zoom(1) },
                // '=' 키가 '+' 와 같은 자판이다. 화면에는 한 줄만 보이게 숨겨서 따로 둔다.
                {
                    label: t.zoomIn,
                    accelerator: 'CmdOrCtrl+=',
                    visible: false,
                    click: () => a.zoom(1),
                },
                { label: t.zoomOut, accelerator: 'CmdOrCtrl+-', click: () => a.zoom(-1) },
                { label: t.zoomReset, accelerator: 'CmdOrCtrl+0', click: () => a.zoom(0) },
                { type: 'separator' },
                {
                    label: t.theme,
                    submenu: [
                        ['system', t.themeSystem],
                        ['light', t.themeLight],
                        ['dark', t.themeDark],
                    ].map(([value, label]) => ({
                        label,
                        type: 'radio',
                        checked: state.theme === value,
                        click: () => a.setTheme(value),
                    })),
                },
                {
                    label: t.remote,
                    type: 'checkbox',
                    checked: !!state.remoteImages,
                    click: (item) => a.setRemoteImages(item.checked),
                },
                { type: 'separator' },
                { label: t.fullscreen, accelerator: 'F11', click: () => a.fullscreen() },
            ],
        },
        {
            label: t.help,
            submenu: [
                { label: t.setDefault, click: () => a.setDefault() },
                { label: t.about, click: () => a.about() },
            ],
        },
    ];
}

/** 우클릭 메뉴. 글자를 골랐으면 복사가 맨 앞에 온다. */
function buildContextTemplate(ctx) {
    const { t, hasDoc, hasSelection, actions: a } = ctx;
    const out = [];
    if (hasSelection) out.push({ label: t.copy, role: 'copy' });
    out.push({ label: t.selectAll, role: 'selectAll', enabled: hasDoc });
    out.push({ type: 'separator' });
    out.push({ label: t.edit, enabled: hasDoc, click: () => a.command('edit') });
    out.push({ label: t.toc, enabled: hasDoc, click: () => a.command('toc') });
    out.push({ label: t.find, enabled: hasDoc, click: () => a.command('find') });
    out.push({ label: t.source, enabled: hasDoc, click: () => a.command('source') });
    out.push({ type: 'separator' });
    out.push({ label: t.open, click: () => a.open() });
    out.push({ label: t.print, enabled: hasDoc, click: () => a.command('print') });
    return out;
}

module.exports = { buildMenuTemplate, buildContextTemplate, pickStrings, STRINGS };
