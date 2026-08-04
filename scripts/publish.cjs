#!/usr/bin/env node

/**
 * Play Console 업로드 스크립트
 *
 * 서명된 AAB를 빌드해 지정한 트랙에 업로드합니다.
 * Gradle Play Publisher(GPP)를 사용하며, 서비스 계정 키가 있어야 동작합니다.
 *
 * ★ 서비스 계정에 프로덕션 권한을 주지 않았다면 `production` 은 실제로 실패한다.
 *   그게 의도다 — 03_출시_절차서.md 1-7절, 8장 함정 5.
 *
 * 사용법:
 *   node scripts/publish.cjs internal      # 내부 테스트 트랙
 *   node scripts/publish.cjs production    # 프로덕션
 */

const { spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { assertNoDevServer } = require('./lib/assert-no-dev-server.cjs');

const repoRoot = path.resolve(__dirname, '..');
const androidDir = path.join(repoRoot, 'android');
const credentialsPath = path.join(androidDir, 'play-service-account.json');
const isWindows = process.platform === 'win32';

const VALID_TRACKS = ['internal', 'alpha', 'beta', 'production'];

/** 해당 경로가 실제로 동작하는 JDK인지 확인 */
function isUsableJdk(home) {
    if (!home) return false;
    const javaBin = path.join(home, 'bin', isWindows ? 'java.exe' : 'java');
    const jvmCfg = path.join(home, 'lib', 'jvm.cfg');
    return fs.existsSync(javaBin) && fs.existsSync(jvmCfg);
}

/** PATH에 있는 java로부터 JDK 홈 경로를 역추적 */
function jdkFromPath() {
    try {
        const probe = isWindows ? 'where' : 'which';
        const javaBin = execFileSync(probe, ['java'], { encoding: 'utf8' })
            .split(/\r?\n/)
            .find(Boolean);
        return javaBin ? path.resolve(path.dirname(javaBin), '..') : null;
    } catch {
        return null;
    }
}

function resolveJdk() {
    if (isUsableJdk(process.env.JAVA_HOME)) return process.env.JAVA_HOME;

    const fallback = jdkFromPath();
    if (isUsableJdk(fallback)) {
        console.log(`ℹ️  JAVA_HOME이 유효하지 않아 PATH의 JDK를 사용합니다: ${fallback}`);
        return fallback;
    }

    console.error('❌ 사용 가능한 JDK를 찾지 못했습니다.');
    process.exit(1);
}

/** 프로덕션 배포 전 확인 (되돌리기 어려운 작업) */
function confirmProduction(version) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(
            `\n⚠️  v${version}를 프로덕션에 배포합니다. 실제 사용자에게 즉시 공개됩니다.\n   계속하려면 'yes'를 입력하세요: `,
            (answer) => {
                rl.close();
                resolve(answer.trim().toLowerCase() === 'yes');
            },
        );
    });
}

async function main() {
    assertNoDevServer();

    const track = process.argv[2];

    if (!VALID_TRACKS.includes(track)) {
        console.error(`❌ 트랙을 지정하세요. 사용 가능: ${VALID_TRACKS.join(', ')}`);
        console.error('   예) node scripts/publish.cjs internal');
        process.exit(1);
    }

    if (!fs.existsSync(credentialsPath)) {
        console.error('❌ 서비스 계정 키가 없습니다:', credentialsPath);
        console.error('   발급 방법은 .docs/설계문서/03_출시_절차서.md 1-6·1-7절을 참고하세요.');
        process.exit(1);
    }

    if (!fs.existsSync(path.join(androidDir, 'keystore.properties'))) {
        console.error(
            '❌ keystore.properties가 없어 AAB가 서명되지 않습니다. 업로드할 수 없습니다.',
        );
        process.exit(1);
    }

    const version = require(path.join(repoRoot, 'package.json')).version;

    if (track === 'production' && !(await confirmProduction(version))) {
        console.log('취소했습니다.');
        process.exit(0);
    }

    const javaHome = resolveJdk();
    const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');

    console.log(`🚀 v${version} → ${track} 트랙 업로드 중...`);

    const result = spawnSync(`"${gradlew}"`, [':app:publishReleaseBundle', '--track', track], {
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

    console.log('');
    console.log(`✅ v${version}를 ${track} 트랙에 업로드했습니다.`);
    console.log('   Play Console에서 검토 상태를 확인하세요.');
}

main();
