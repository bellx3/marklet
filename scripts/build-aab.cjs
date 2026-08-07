#!/usr/bin/env node

/**
 * 릴리스 AAB 빌드 스크립트
 *
 * Android Studio 없이 CLI만으로 서명된 AAB를 생성합니다.
 *
 * JAVA_HOME이 Android Studio 번들 JDK(jbr)를 가리키는 경우, 스튜디오 업데이트 중에는
 * 그 경로가 사라져 gradlew 런처가 아예 뜨지 못합니다. 이를 피하기 위해 유효한 JDK를
 * 직접 찾아 자식 프로세스에만 JAVA_HOME을 지정합니다. (시스템 환경변수는 건드리지 않음)
 *
 * ★ 2026-08-03 현재 이 PC의 JAVA_HOME 이 실제로 그 상태다(lib/jvm.cfg 없음).
 *   이 스크립트는 스스로 PATH 의 JDK 21 로 폴백하므로 동작한다. 하지만 gradlew 를
 *   직접 부르는 경우는 보호받지 못한다 — 02_기술_설계서.md 1-1절 참조.
 *
 * 사용법: npm run build:aab
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { assertNoDevServer } = require('./lib/assert-no-dev-server.cjs');
const { assertWebAssetsFresh } = require('./lib/assert-web-assets-fresh.cjs');
const { buildWebAndSync } = require('./lib/build-web.cjs');

const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');
const isWindows = process.platform === 'win32';

/** 해당 경로가 실제로 동작하는 JDK인지 확인 */
function isUsableJdk(home) {
    if (!home) return false;
    const javaBin = path.join(home, 'bin', isWindows ? 'java.exe' : 'java');
    // jvm.cfg가 없으면 런타임이 반쯤 지워진 상태(스튜디오 업데이트 중)입니다.
    const jvmCfg = path.join(home, 'lib', 'jvm.cfg');
    return fs.existsSync(javaBin) && fs.existsSync(jvmCfg);
}

/** PATH에 있는 java로부터 JDK 홈 경로를 역추적 */
function jdkFromPath() {
    try {
        const probe = isWindows ? 'where' : 'which';
        const out = execFileSync(probe, ['java'], { encoding: 'utf8' });
        const javaBin = out.split(/\r?\n/).find(Boolean);
        if (!javaBin) return null;
        // <home>/bin/java -> <home>
        return path.resolve(path.dirname(javaBin), '..');
    } catch {
        return null;
    }
}

function resolveJdk() {
    if (isUsableJdk(process.env.JAVA_HOME)) {
        return process.env.JAVA_HOME;
    }

    const fallback = jdkFromPath();
    if (isUsableJdk(fallback)) {
        console.log(`ℹ️  JAVA_HOME이 유효하지 않아 PATH의 JDK를 사용합니다: ${fallback}`);
        return fallback;
    }

    console.error('❌ 사용 가능한 JDK를 찾지 못했습니다.');
    console.error('   JAVA_HOME을 JDK 21 경로로 지정하거나, java를 PATH에 추가하세요.');
    process.exit(1);
}

function main() {
    assertNoDevServer();

    const javaHome = resolveJdk();
    const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');

    if (!fs.existsSync(gradlew)) {
        console.error('❌ gradlew를 찾을 수 없습니다:', gradlew);
        process.exit(1);
    }

    if (!fs.existsSync(path.join(androidDir, 'keystore.properties'))) {
        console.warn(
            '⚠️  keystore.properties가 없습니다. AAB가 서명되지 않아 업로드할 수 없습니다.',
        );
        console.warn('   android/keystore.properties.example을 복사해 값을 채우세요.');
    }

    /*
     * ★★★ gradle 은 웹을 만들지 않는다. 여기서 만들어 넣지 않으면 **마지막으로 손수
     *   npm run build 를 돌린 시점의 웹**이 그대로 AAB 에 들어간다(2026-08-07 실제 사고 —
     *   assert-web-assets-fresh.cjs 주석). 만들고, 그러고도 검사한다.
     */
    buildWebAndSync();
    assertWebAssetsFresh();

    console.log('🏗️  릴리스 AAB 빌드 중...');
    // Windows의 .bat는 Node 20+에서 shell 없이는 실행되지 않으므로 shell 경유로 실행합니다.
    // 경로에 공백이 있을 수 있어 실행 파일은 따옴표로 감쌉니다.
    const result = spawnSync(`"${gradlew}"`, [':app:bundleRelease'], {
        cwd: androidDir,
        env: { ...process.env, JAVA_HOME: javaHome },
        stdio: 'inherit',
        shell: true,
    });

    if (result.error) {
        console.error('❌ gradlew 실행 실패:', result.error.message);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    const aab = path.join(
        androidDir,
        'app',
        'build',
        'outputs',
        'bundle',
        'release',
        'app-release.aab',
    );

    if (!fs.existsSync(aab)) {
        console.error('❌ 빌드는 끝났지만 AAB를 찾을 수 없습니다:', aab);
        process.exit(1);
    }

    const version = require(path.join(repoRoot, 'package.json')).version;
    const sizeMb = (fs.statSync(aab).size / 1024 / 1024).toFixed(1);

    console.log('');
    console.log(`✅ 빌드 완료 — v${version} (${sizeMb} MB)`);
    console.log(`   ${aab}`);
}

main();
