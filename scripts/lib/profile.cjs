'use strict';

/**
 * 점검 · 측정 스크립트가 쓰는 임시 프로필.
 *
 * 앱이 설정(`state.json` — 테마 · 최근 문서 · 창 크기)과 WebView2 데이터를 이 PC 의 진짜 폴더(%APPDATA% · %LOCALAPPDATA% 의 com.marklet.md.desktop)가
 * 아니라 임시 폴더에 쓰게 한다. 스크립트를 돌렸다고 내 설정이 지워지거나 최근 문서가 쌓이지 않는다.
 *  · MARKLET_DATA_DIR            — 앱의 설정 폴더(src-tauri/src/state.rs 의 data_dir_override)
 *  · WEBVIEW2_USER_DATA_FOLDER   — WebView2 의 데이터 폴더(WebView2 가 직접 읽는 환경변수)
 * 자식 프로세스는 이 환경을 물려받는다. 스크립트가 끝나면(exit) 폴더를 치운다.
 *
 * ★ 이미 떠 있는 진짜 Marklet 이 있으면 단일 인스턴스 규칙 때문에 시험 문서가 그쪽으로 넘어간다 — 점검 전에 끝내 둘 것.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function isolate(prefix = 'mk-profile') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
    process.env.MARKLET_DATA_DIR = dir;
    process.env.WEBVIEW2_USER_DATA_FOLDER = path.join(dir, 'webview');
    const cleanup = () => {
        // 방금 끝낸 앱의 WebView2 프로세스가 폴더를 잠깐 더 쥐고 있을 수 있다 — 몇 번 다시 해 본다.
        for (let i = 0; i < 10; i++) {
            try {
                fs.rmSync(dir, { recursive: true, force: true });
                return;
            } catch {
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
            }
        }
        /* 끝내 못 지우면 임시 폴더로 남는다 — OS 가 치운다 */
    };
    process.on('exit', cleanup);
    return { dir, cleanup, stateFile: path.join(dir, 'state.json') };
}

module.exports = { isolate };
