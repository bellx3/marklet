/**
 * 릴리스 산출물에 개발 서버 주소가 섞이지 않도록 검사
 *
 * `npm run dev:device`는 기기가 PC의 Vite 서버를 바라보도록 생성 설정에
 * `server.url`을 주입합니다. 그 상태로 릴리스를 빌드하면 localhost를 로드하는
 * 앱이 배포되어 실행 즉시 흰 화면이 됩니다.
 *
 * dev:device는 종료 시 설정을 되돌리지만, 비정상 종료로 남을 수 있어
 * 빌드·업로드 직전에 한 번 더 확인합니다.
 */

const fs = require('fs');
const path = require('path');

const GENERATED_CONFIG = path.resolve(
    __dirname,
    '..',
    '..',
    'android',
    'app',
    'src',
    'main',
    'assets',
    'capacitor.config.json',
);

/** 개발 서버 주소가 남아 있으면 메시지를 출력하고 프로세스를 종료합니다. */
function assertNoDevServer() {
    if (!fs.existsSync(GENERATED_CONFIG)) return;

    let config;
    try {
        config = JSON.parse(fs.readFileSync(GENERATED_CONFIG, 'utf8'));
    } catch {
        return; // 설정을 읽지 못하면 빌드 단계에서 걸립니다
    }

    const url = config.server?.url;
    if (!url) return;

    console.error('');
    console.error('❌ 생성된 Capacitor 설정에 개발 서버 주소가 남아 있습니다.');
    console.error(`   server.url = ${url}`);
    console.error('');
    console.error('   이대로 빌드하면 실행 즉시 흰 화면이 되는 앱이 만들어집니다.');
    console.error('   아래 명령으로 설정을 재생성한 뒤 다시 시도하세요:');
    console.error('');
    console.error('     npm run build:android');
    console.error('');
    process.exit(1);
}

module.exports = { assertNoDevServer, GENERATED_CONFIG };
