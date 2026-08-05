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

    /*
     * ⚠️ **--rerun-tasks 를 빼지 마라.**
     *
     * publishReleaseBundle 은 AAB 가 안 바뀌면 UP-TO-DATE 로 건너뛴다. 그런데
     * 업로드가 **실패한** 뒤에도 그 판단이 남아서, 다시 돌리면 아무것도 안
     * 올리고 BUILD SUCCESSFUL 을 뱉는다. 실제로 그렇게 세 번을 "성공"으로
     * 보고받고 트랙은 비어 있었다.
     */
    const result = spawnSync(
        `"${gradlew}"`,
        [':app:publishReleaseBundle', '--track', track, '--rerun-tasks'],
        {
            cwd: androidDir,
            env: { ...process.env, JAVA_HOME: javaHome },
            stdio: 'inherit',
            shell: true,
        },
    );

    if (result.error) {
        console.error('❌ gradlew 실행 실패:', result.error.message);
        process.exit(1);
    }

    if (result.status !== 0) {
        process.exit(result.status ?? 1);
    }

    /*
     * Gradle 이 0으로 끝나도 **트랙에 들어갔는지는 별개**다. 위의 UP-TO-DATE
     * 건이 그랬다. 올라간 것을 눈으로 확인하고 나서 성공이라고 말한다.
     */
    const landed = await verifyTrack(track, version);
    if (!landed) {
        console.error('');
        console.error(`❌ gradlew 는 성공했지만 ${track} 트랙에서 v${version}를 찾지 못했습니다.`);
        console.error('   Play Console에서 직접 확인하세요.');
        process.exit(1);
    }

    console.log('');
    console.log(`✅ v${version}를 ${track} 트랙에 올렸습니다. (상태: ${landed.status})`);
    if (landed.status === 'draft') {
        console.log('   아직 초안입니다. Play Console에서 "검토를 위해 Google에 버전 전송"을');
        console.log('   눌러야 테스터에게 배포됩니다.');
    }
}

/** 트랙을 실제로 읽어 그 버전이 들어갔는지 본다 */
async function verifyTrack(track, version) {
    const crypto = require('crypto');
    const creds = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
    const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
    const pkg = require(path.join(repoRoot, 'capacitor.config.json')).appId;
    const b64 = (s) => Buffer.from(s).toString('base64url');

    const now = Math.floor(Date.now() / 1000);
    const h = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const cl = b64(
        JSON.stringify({
            iss: creds.client_email,
            scope: 'https://www.googleapis.com/auth/androidpublisher',
            aud: 'https://oauth2.googleapis.com/token',
            exp: now + 3600,
            iat: now,
        }),
    );
    const sig = crypto.createSign('RSA-SHA256').update(`${h}.${cl}`).sign(creds.private_key).toString('base64url');
    const tok = await (
        await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
                assertion: `${h}.${cl}.${sig}`,
            }),
        })
    ).json();
    if (!tok.access_token) return null;

    const call = async (p, o = {}) => {
        const r = await fetch(API + p, { ...o, headers: { Authorization: `Bearer ${tok.access_token}` } });
        const x = await r.text();
        try {
            return x ? JSON.parse(x) : {};
        } catch {
            return {};
        }
    };

    const id = (await call(`/applications/${pkg}/edits`, { method: 'POST' })).id;
    if (!id) return null;
    try {
        const t = await call(`/applications/${pkg}/edits/${id}/tracks/${track}`);
        for (const rel of t.releases ?? []) {
            if ((rel.versionCodes ?? []).length && (!rel.name || rel.name.includes(version))) return rel;
        }
        return null;
    } finally {
        await call(`/applications/${pkg}/edits/${id}`, { method: 'DELETE' });
    }
}

main();
