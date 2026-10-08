//! 시작 시간 추적(연구용). 환경변수 `MARKLET_TRACE=<파일>` 이 있을 때만 `에폭ms 이름` 한 줄씩 덧붙인다.
//! 없으면 환경변수를 한 번 읽는 것이 전부다(비용 없음). scripts/bench-startup.cjs --trace 가 쓴다.

use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn mark(label: &str) {
    let Some(path) = FILE.get_or_init(|| std::env::var_os("MARKLET_TRACE").map(PathBuf::from))
    else {
        return;
    };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as f64 / 1000.0)
        .unwrap_or(0.0);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "{ms:.1} {label}");
    }
}
