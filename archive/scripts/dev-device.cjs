#!/usr/bin/env node

/**
 * 실기기 라이브 리로드
 *
 * 코드를 저장하면 USB로 연결된 기기 화면이 즉시 갱신됩니다.
 * 파일 열기·공유처럼 실기기가 필요한 기능을 재빌드 없이 확인할 때 사용합니다.
 *
 * `npx cap run android -l`을 쓰지 않는 이유:
 * Capacitor CLI가 내부적으로 './gradlew'를 실행하는데, Windows(cmd.exe)에서는
 * 이 경로 형식과 확장자 없는 셸 스크립트를 실행하지 못해 실패합니다.
 * 또한 cap run은 개발 서버를 직접 띄우지 않고, host 기본값이 LAN IP라
 * localhost 바인딩인 Vite에 기기가 접근할 수 없습니다.
 * 그래서 같은 일을 gradlew.bat와 adb로 직접 수행합니다.
 *
 * 동작 순서
 *   1. Vite 개발 서버 기동
 *   2. adb reverse 로 기기의 localhost:3000 을 PC로 연결 (USB 경유)
 *   3. Capacitor 동기화 후, 생성된 설정에 개발 서버 주소 주입
 *   4. 디버그 APK 빌드·설치·실행
 *
 * 참고
 *   - 설치되는 앱은 `com.marklet.md.debug` 로 스토어 버전과 공존합니다.
 *   - 인앱 결제는 Play가 설치한 앱에서만 동작하므로 여기서는 확인할 수 없습니다.
 *   - 3번에서 수정하는 파일은 동기화 때마다 재생성되는 산출물이라 저장소에 영향이 없습니다.
 *
 * ★ 반드시 Ctrl+C 로 끝내라. 터미널 창을 닫으면 restoreConfig() 가 안 불려
 *   생성 설정에 server.url 이 남고, 그대로 릴리스를 빌드하면 흰 화면 앱이 나간다.
 *   그 상황을 막는 마지막 방어선이 scripts/lib/assert-no-dev-server.cjs 다.
 *
 * 사용법: npm run dev:device   (종료는 Ctrl+C)
 */

const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');
const PORT = 3000;
const DEV_URL = `http://localhost:${PORT}`;
// ★ 앞은 applicationId(suffix 포함), 뒤는 자바 클래스의 실제 패키지다.
//   applicationIdSuffix 는 자바 패키지를 바꾸지 않는다. 비대칭인 것이 정상이다.
const APP_ID = 'com.marklet.md.debug';
const MAIN_ACTIVITY = 'com.marklet.md.MainActivity';
const isWindows = process.platform === 'win32';

const generatedConfig = path.join(
    androidDir,
    'app',
    'src',
    'main',
    'assets',
    'capacitor.config.json',
);

/** adb 실행 파일 경로 찾기 (android/local.properties → 환경변수 → PATH) */
function resolveAdb() {
    const candidates = [];

    try {
        const localProps = fs.readFileSync(path.join(androidDir, 'local.properties'), 'utf8');
        const match = localProps.match(/^sdk\.dir=(.+)$/m);
        if (match) {
            const sdkDir = match[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
            candidates.push(path.join(sdkDir, 'platform-tools', isWindows ? 'adb.exe' : 'adb'));
        }
    } catch {
        // local.properties가 없으면 다음 후보로
    }

    for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
        if (env) candidates.push(path.join(env, 'platform-tools', isWindows ? 'adb.exe' : 'adb'));
    }

    return candidates.find((c) => fs.existsSync(c)) ?? 'adb';
}

const adb = resolveAdb();

/** 유효한 JDK 경로 (JAVA_HOME이 깨져 있으면 PATH의 java에서 역추적) */
function resolveJavaHome() {
    const usable = (home) =>
        home &&
        fs.existsSync(path.join(home, 'bin', isWindows ? 'java.exe' : 'java')) &&
        fs.existsSync(path.join(home, 'lib', 'jvm.cfg'));

    if (usable(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

    try {
        const javaBin = execFileSync(isWindows ? 'where' : 'which', ['java'], { encoding: 'utf8' })
            .split(/\r?\n/)
            .find(Boolean);
        const home = javaBin ? path.resolve(path.dirname(javaBin), '..') : null;
        if (usable(home)) return home;
    } catch {
        // 못 찾으면 그대로 진행
    }
    return process.env.JAVA_HOME;
}

function adbSync(args) {
    return spawnSync(adb, args, { encoding: 'utf8' });
}

/** USB로 연결된 실기기 시리얼 (에뮬레이터 제외) */
function findDevice() {
    const serials = (adbSync(['devices']).stdout ?? '')
        .split(/\r?\n/)
        .slice(1)
        .filter((line) => line.includes('\tdevice'))
        .map((line) => line.split('\t')[0])
        .filter((serial) => !serial.startsWith('emulator-'));

    return serials[0] ?? null;
}

/** 셸 경유 실행 (Windows의 .cmd/.bat 실행에 필요) */
function run(command, args, options = {}) {
    return spawn(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true,
        ...options,
    });
}

function runToCompletion(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: repoRoot,
        stdio: 'inherit',
        shell: true,
        ...options,
    });
    return result.status === 0;
}

/** 개발 서버가 응답할 때까지 대기 */
async function waitForDevServer(timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return true;
        } catch {
            // 아직 기동 중
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
}

/** 주입 전 원본 설정. 종료 시 이 내용으로 되돌립니다. */
let originalConfig = null;

/** 생성된 Capacitor 설정에 개발 서버 주소를 주입 */
function injectDevServer() {
    originalConfig = fs.readFileSync(generatedConfig, 'utf8');
    const config = JSON.parse(originalConfig);

    config.server = {
        ...config.server,
        url: DEV_URL,
        cleartext: true, // 개발 서버가 http이므로 필요 (앱은 androidScheme: https)
    };

    fs.writeFileSync(generatedConfig, JSON.stringify(config, null, 2));
}

/**
 * 주입한 개발 서버 주소를 제거
 *
 * 남겨두면 이후 릴리스 빌드가 localhost를 로드하는 앱이 되어 흰 화면이 됩니다.
 */
function restoreConfig() {
    if (originalConfig === null) return;
    try {
        fs.writeFileSync(generatedConfig, originalConfig);
        console.log('↩️  Capacitor 설정을 되돌렸습니다.');
    } catch (err) {
        console.error('⚠️  설정 복원 실패. 릴리스 전에 `npm run build:android`를 실행하세요:', err);
    }
    originalConfig = null;
}

async function main() {
    const device = findDevice();
    if (!device) {
        console.error('❌ USB로 연결된 기기를 찾지 못했습니다. USB 디버깅을 확인하세요.');
        process.exit(1);
    }
    console.log(`📲 대상 기기: ${device}`);

    console.log('🚀 Vite 개발 서버를 시작합니다...');
    const vite = run('npm', ['run', 'dev']);

    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log('\n🧹 정리 중...');
        restoreConfig();
        adbSync(['-s', device, 'reverse', '--remove', `tcp:${PORT}`]);
        vite.kill();
    };

    process.on('SIGINT', shutdown);
    process.on('exit', shutdown);
    vite.on('exit', (code) => {
        if (!shuttingDown) {
            console.error(`❌ 개발 서버가 종료되었습니다 (code ${code})`);
            process.exit(code ?? 1);
        }
    });

    if (!(await waitForDevServer())) {
        console.error(`❌ 개발 서버가 ${DEV_URL} 에서 응답하지 않습니다.`);
        shutdown();
        process.exit(1);
    }
    console.log(`✅ 개발 서버 준비 완료 (${DEV_URL})`);

    // 기기의 localhost:3000 → PC의 개발 서버 (USB 경유, Wi-Fi 불필요)
    if (adbSync(['-s', device, 'reverse', `tcp:${PORT}`, `tcp:${PORT}`]).status !== 0) {
        console.error('❌ adb reverse 설정에 실패했습니다.');
        shutdown();
        process.exit(1);
    }
    console.log(`🔌 adb reverse 설정 완료 (기기 localhost:${PORT} → PC)`);

    console.log('🔄 Capacitor 동기화...');
    if (!runToCompletion('npm', ['run', 'sync:android'])) {
        shutdown();
        process.exit(1);
    }

    injectDevServer();
    console.log('⚙️  개발 서버 주소 주입 완료');

    console.log('🏗️  디버그 APK 빌드 (처음에는 시간이 걸립니다)...');
    const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
    if (
        !runToCompletion(`"${gradlew}"`, [':app:assembleDebug'], {
            cwd: androidDir,
            env: { ...process.env, JAVA_HOME: resolveJavaHome() },
        })
    ) {
        shutdown();
        process.exit(1);
    }

    const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    console.log('📦 설치 중...');
    if (!runToCompletion(`"${adb}"`, ['-s', device, 'install', '-r', `"${apk}"`])) {
        shutdown();
        process.exit(1);
    }

    adbSync(['-s', device, 'shell', 'am', 'start', '-n', `${APP_ID}/${MAIN_ACTIVITY}`]);

    console.log('');
    console.log('✅ 라이브 리로드 실행 중');
    console.log('   코드를 저장하면 기기 화면이 즉시 갱신됩니다.');
    console.log('   로그: npm run logcat -- --focus');
    console.log('   종료: Ctrl+C');
    console.log('');

    // Vite가 살아있는 동안 유지
    await new Promise(() => {});
}

main();
