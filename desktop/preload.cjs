'use strict';

/**
 * 렌더러에 내미는 좁은 창구. 이 밖의 것은 렌더러가 건드릴 수 없다.
 *
 * ★ 렌더러는 마크다운(= 어디서 왔는지 모르는 입력)을 그리는 곳이다.
 *   sandbox + contextIsolation 이라 노드 API 가 없고, 여기 노출한 함수만 부를 수 있다.
 *   '임의 경로를 읽어 달라' 같은 함수를 여기에 더하지 마라.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('marklet', {
    ready: () => ipcRenderer.send('renderer-ready'),
    onDocument: (cb) => ipcRenderer.on('document', (_e, d) => cb(d)),
    onCommand: (cb) => ipcRenderer.on('command', (_e, c) => cb(c)),
    /** 끌어다 놓은 파일. 경로는 사용자가 직접 고른 것이다. */
    openPath: (file) => ipcRenderer.send('open-path', webUtils.getPathForFile(file)),
    /** 문서 안의 상대 링크(다른 .md) */
    openLink: (href) => ipcRenderer.send('open-link', String(href)),
    zoom: (dir) => ipcRenderer.send('zoom', dir),
    setTheme: (theme) => ipcRenderer.send('set-theme', String(theme)),
    showMenu: () => ipcRenderer.send('show-menu'),
});
