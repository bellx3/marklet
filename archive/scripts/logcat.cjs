#!/usr/bin/env node

/**
 * 앱 전용 logcat 뷰어
 *
 * 기기 전체 로그는 (특히 삼성 기기에서) 시스템 로그가 대부분이라 읽기 어렵습니다.
 * 이 스크립트는 앱 프로세스의 로그만 보여주고, 앱이 재시작되어 PID가 바뀌면
 * 자동으로 다시 붙습니다.
 *
 * 사용법:
 *   npm run logcat                     앱 프로세스 전체 로그
 *   npm run logcat -- --focus          결제·크래시 관련 로그만
 *   npm run logcat -- --grep "패턴"    임의 패턴만
 *
 * 참고: 릴리스 빌드에서는 웹(console.log) 로그가 나오지 않습니다.
 *       Capacitor의 loggingBehavior 기본값이 debug이기 때문입니다.
 *       웹 로그가 필요하면 디버그 빌드를 사용하세요.
 *
 * ★ 인텐트(어떤 MIME 으로 들어왔는지)를 보려면 이 스크립트가 아니라 events 버퍼를 봐라.
 *   삼성 기기는 ActivityTaskManager / am_intent 로그가 꺼져 있다:
 *     adb logcat -d -b events | grep wm_create_activity
 *   자세한 절차는 02_기술_설계서.md 5-7-4절.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// 디버그 빌드는 applicationIdSuffix로 패키지명이 분리되어 있습니다.
// 실행 중인 쪽을 자동으로 찾되, 디버그 빌드를 우선합니다(로그가 더 많음).
const APP_IDS = ['com.marklet.md.debug', 'com.marklet.md'];
const isWindows = process.platform === 'win32';

/**
 * focus 모드에서 통과시킬 로그 "태그" 목록.
 *
 * 메시지 내용이 아니라 태그로 거릅니다. 내용으로 거르면 삼성 기기의 렌더링 로그
 * (`I/View ... CapacitorWebView ...`)까지 통과해 버립니다.
 */
const FOCUS_TAGS = [
    /^Capacitor(\/|$)/i, // Capacitor, Capacitor/Console(웹 console.log), Capacitor/Plugin/...
    /^MdFile$/, // 자체 네이티브 플러그인 (02_기술_설계서.md 5-2절)
    /Billing/i, // BillingClient 등 결제
    /Purchase/i, // cordova-plugin-purchase
    /^AndroidRuntime$/, // 크래시
    /^System\.err$/, // 스택 트레이스
];

/** 태그가 일반적이어도 내용이 우리 것이면 통과 */
const FOCUS_MESSAGE = /☕|후원|팁|captureIntent/;

/** `-v brief` 형식: `I/Tag    ( 1234): message` */
const LOGCAT_LINE = /^([VDIWEF])\/(.+?)\(\s*\d+\):\s?(.*)$/;

function passesFocus(line) {
    const match = LOGCAT_LINE.exec(line);
    if (!match) return false; // "--------- beginning of main" 같은 구분선은 숨김

    const tag = match[2].trim();
    const message = match[3];

    return FOCUS_TAGS.some((re) => re.test(tag)) || FOCUS_MESSAGE.test(message);
}

/** adb 실행 파일 경로 찾기 */
function resolveAdb() {
    const candidates = [];

    // 1. android/local.properties의 sdk.dir
    try {
        const localProps = fs.readFileSync(
            path.resolve(__dirname, '..', 'android', 'local.properties'),
            'utf8',
        );
        const match = localProps.match(/^sdk\.dir=(.+)$/m);
        if (match) {
            // properties 파일은 백슬래시와 콜론을 이스케이프합니다
            const sdkDir = match[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
            candidates.push(path.join(sdkDir, 'platform-tools', isWindows ? 'adb.exe' : 'adb'));
        }
    } catch {
        // local.properties가 없으면 다음 후보로
    }

    // 2. 환경변수
    for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
        if (env) {
            candidates.push(path.join(env, 'platform-tools', isWindows ? 'adb.exe' : 'adb'));
        }
    }

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    // 3. PATH에 있기를 기대
    return 'adb';
}

const adb = resolveAdb();

function adbSync(args) {
    try {
        return execFileSync(adb, args, { encoding: 'utf8' }).trim();
    } catch {
        return '';
    }
}

/** 앱이 뜰 때까지 기다렸다가 { appId, pid } 반환 */
async function waitForApp() {
    let announced = false;

    for (;;) {
        for (const appId of APP_IDS) {
            const pid = adbSync(['shell', 'pidof', '-s', appId]);
            if (pid) return { appId, pid };
        }

        if (!announced) {
            console.log(`⏳ 앱 실행을 기다리는 중... (${APP_IDS.join(' 또는 ')})`);
            announced = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

function parseArgs() {
    const argv = process.argv.slice(2);
    const grepIndex = argv.indexOf('--grep');
    return {
        focus: argv.includes('--focus'),
        grep: grepIndex >= 0 && argv[grepIndex + 1] ? new RegExp(argv[grepIndex + 1], 'i') : null,
    };
}

async function main() {
    const { focus, grep } = parseArgs();

    const devices = adbSync(['devices'])
        .split(/\r?\n/)
        .slice(1)
        .filter((line) => line.includes('\tdevice'));

    if (devices.length === 0) {
        console.error('❌ 연결된 기기가 없습니다. USB 디버깅을 확인하세요.');
        process.exit(1);
    }

    // grep이 있으면 내용으로, focus면 태그 기준으로, 둘 다 없으면 앱 로그 전체
    const accepts = grep ? (line) => grep.test(line) : focus ? passesFocus : null;

    if (grep) console.log(`🔎 패턴 필터: ${grep}`);
    else if (focus) console.log('🔎 focus 모드 — 결제·크래시 로그만 표시');

    // 이전에 쌓인 로그를 버려 현재 세션만 봅니다
    adbSync(['logcat', '-c']);

    for (;;) {
        const { appId, pid } = await waitForApp();
        console.log(`\n📱 ${appId} (pid ${pid}) 로그 — Ctrl+C로 종료\n`);

        await new Promise((resolve) => {
            const child = spawn(adb, ['logcat', '--pid', pid, '-v', 'brief'], {
                stdio: ['ignore', 'pipe', 'inherit'],
            });

            let buffer = '';
            child.stdout.on('data', (chunk) => {
                buffer += chunk.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() ?? '';

                for (const line of lines) {
                    if (!accepts || accepts(line)) console.log(line);
                }
            });

            child.on('close', resolve);
        });

        console.log('\n🔄 앱 프로세스가 종료되었습니다. 재시작을 기다립니다...\n');
    }
}

main();
