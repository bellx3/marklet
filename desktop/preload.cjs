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
    run: (name) => ipcRenderer.send('run', String(name)),
    /** 저장하지 않은 편집이 있는지 — 창 제목의 ● 와 닫을 때의 확인이 이걸 따른다 */
    setDirty: (dirty) => ipcRenderer.send('dirty', dirty === true),
    /** 'preview' = 미리보기 창, 'pdf' = 저장 대화상자. 렌더러는 PDF 바이트를 만지지 않는다. */
    print: (mode) => ipcRenderer.invoke('print', mode === 'pdf' ? 'pdf' : 'preview'),
    save: (content) => ipcRenderer.invoke('save', String(content)),
});
