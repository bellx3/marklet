//! 설정(테마 · 확대 · 원격 이미지 · 최근 문서 · 창 크기). 옛 Electron 판의 state.json 과 같은 모양이라 그대로 이어받는다(main.rs).
//!
//! ★ 저장된 값을 믿지 않는다. 깨진 값 하나가 부팅을 막으면 사용자는 앱 데이터를 지우러 간다.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const ZOOM_LEVELS: [f64; 12] = [
    0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
];
pub const MAX_RECENT: usize = 10;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub struct Bounds {
    pub width: f64,
    pub height: f64,
    pub x: Option<f64>,
    pub y: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    pub zoom: f64,
    #[serde(rename = "remoteImages")]
    pub remote_images: bool,
    /// 마지막 창을 닫아도 앱을 잠시 살려 두어 다음 문서를 바로 띄운다(빠른 시작). 기본은 켬.
    #[serde(rename = "keepWarm")]
    pub keep_warm: bool,
    /// 읽기만 하는 문서는 WebView2 없이 네이티브로 끝까지 보여 준다(빠른 보기). 기본은 켬.
    #[serde(rename = "nativeView")]
    pub native_view: bool,
    pub recent: Vec<String>,
    pub bounds: Option<Bounds>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "system".into(),
            zoom: 1.0,
            remote_images: false,
            keep_warm: true,
            native_view: true,
            recent: Vec::new(),
            bounds: None,
        }
    }
}

impl Settings {
    /// JSON 에서 읽는다. 모르는 값 · 깨진 값은 기본값으로 대신한다.
    pub fn from_json(raw: &str) -> Settings {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
            return Settings::default();
        };
        let theme = match v.get("theme").and_then(|t| t.as_str()) {
            Some(t @ ("system" | "light" | "dark")) => t.to_string(),
            _ => "system".to_string(),
        };
        let zoom = v
            .get("zoom")
            .and_then(|z| z.as_f64())
            .filter(|z| ZOOM_LEVELS.iter().any(|l| (l - z).abs() < 1e-9))
            .unwrap_or(1.0);
        let recent = v
            .get("recent")
            .and_then(|r| r.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|p| p.as_str().map(str::to_string))
                    .take(MAX_RECENT)
                    .collect()
            })
            .unwrap_or_default();
        let bounds = v.get("bounds").and_then(|b| {
            let width = b.get("width")?.as_f64()?;
            let height = b.get("height")?.as_f64()?;
            if !(width.is_finite() && height.is_finite()) || width < 200.0 || height < 200.0 {
                return None;
            }
            Some(Bounds {
                width,
                height,
                x: b.get("x")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite()),
                y: b.get("y")
                    .and_then(|y| y.as_f64())
                    .filter(|y| y.is_finite()),
            })
        });
        Settings {
            theme,
            zoom,
            remote_images: v.get("remoteImages").and_then(|r| r.as_bool()) == Some(true),
            // 없거나 깨졌으면 켬(기본값). 끈 사람만 false 를 적어 둔다.
            keep_warm: v.get("keepWarm").and_then(|r| r.as_bool()) != Some(false),
            // 없거나 깨졌으면 켬(기본값). 끈 사람만 false 를 적어 둔다.
            native_view: v.get("nativeView").and_then(|r| r.as_bool()) != Some(false),
            recent,
            bounds,
        }
    }

    pub fn load(file: &Path, fallback: Option<&Path>) -> Settings {
        let read = |p: &Path| std::fs::read_to_string(p).ok();
        match read(file).or_else(|| fallback.and_then(read)) {
            Some(raw) => Settings::from_json(&raw),
            None => Settings::default(),
        }
    }

    pub fn save(&self, file: &Path) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        match serde_json::to_string(self) {
            Ok(s) => {
                if let Err(e) = std::fs::write(file, s) {
                    eprintln!("상태 저장 실패: {e}");
                }
            }
            Err(e) => eprintln!("상태 직렬화 실패: {e}"),
        }
    }

    pub fn remember_recent(&mut self, abs: &Path) {
        let s = abs.to_string_lossy().into_owned();
        self.recent.retain(|p| p != &s);
        self.recent.insert(0, s);
        self.recent.truncate(MAX_RECENT);
    }

    /// 확대 단계를 한 칸 옮긴다. dir: 1 = 확대, -1 = 축소, 0 = 원래 크기.
    pub fn step_zoom(&mut self, dir: i32) {
        let mut i = ZOOM_LEVELS
            .iter()
            .position(|l| (l - self.zoom).abs() < 1e-9)
            .unwrap_or(4);
        if dir == 0 {
            i = 4;
        } else if dir > 0 {
            i = (i + 1).min(ZOOM_LEVELS.len() - 1);
        } else {
            i = i.saturating_sub(1);
        }
        self.zoom = ZOOM_LEVELS[i];
    }
}

pub fn state_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("state.json")
}

/// 시험 · 도구용: 환경변수 `MARKLET_DATA_DIR` 가 있으면 설정 폴더를 거기로 돌린다 — 점검 스크립트가 사용자의 진짜 설정(테마 · 최근 문서)을
/// 건드리지 않게 하려는 것이다. 이때는 옛 Electron 판의 설정도 이어받지 않는다(깨끗한 상태에서 시작한다).
pub fn data_dir_override() -> Option<PathBuf> {
    std::env::var_os("MARKLET_DATA_DIR")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn broken_values_fall_back_to_defaults() {
        let s = Settings::from_json("not json");
        assert_eq!(
            (s.theme.as_str(), s.zoom, s.remote_images),
            ("system", 1.0, false)
        );
        let s = Settings::from_json(
            r#"{"theme":"neon","zoom":7,"remoteImages":"yes","recent":[1,"a.md"],"bounds":{"width":10}}"#,
        );
        assert_eq!(
            (s.theme.as_str(), s.zoom, s.remote_images),
            ("system", 1.0, false)
        );
        assert_eq!(s.recent, vec!["a.md".to_string()]);
        assert!(s.bounds.is_none());
    }

    #[test]
    fn electron_state_file_is_read_as_is() {
        let s = Settings::from_json(
            r#"{"theme":"dark","zoom":1.25,"remoteImages":true,"recent":["D:\\a.md"],"bounds":{"x":10,"y":20,"width":980,"height":900}}"#,
        );
        assert_eq!(
            (s.theme.as_str(), s.zoom, s.remote_images),
            ("dark", 1.25, true)
        );
        assert_eq!(s.recent, vec!["D:\\a.md".to_string()]);
        assert_eq!(s.bounds.unwrap().width, 980.0);
    }

    #[test]
    fn keep_warm_defaults_on_and_only_an_explicit_false_turns_it_off() {
        assert!(Settings::default().keep_warm);
        assert!(Settings::from_json("{}").keep_warm);
        assert!(Settings::from_json(r#"{"keepWarm":"no"}"#).keep_warm);
        assert!(!Settings::from_json(r#"{"keepWarm":false}"#).keep_warm);
        // 저장했다 다시 읽어도 그대로
        let raw = serde_json::to_string(&Settings {
            keep_warm: false,
            ..Settings::default()
        })
        .unwrap();
        assert!(!Settings::from_json(&raw).keep_warm);
    }

    #[test]
    fn native_view_defaults_on_and_only_an_explicit_false_turns_it_off() {
        assert!(Settings::default().native_view);
        assert!(Settings::from_json("{}").native_view);
        assert!(Settings::from_json(r#"{"nativeView":"no"}"#).native_view);
        assert!(!Settings::from_json(r#"{"nativeView":false}"#).native_view);
    }

    #[test]
    fn zoom_steps_clamp_and_reset() {
        let mut s = Settings::default();
        for _ in 0..20 {
            s.step_zoom(1);
        }
        assert_eq!(s.zoom, 3.0);
        s.step_zoom(0);
        assert_eq!(s.zoom, 1.0);
        for _ in 0..20 {
            s.step_zoom(-1);
        }
        assert_eq!(s.zoom, 0.5);
    }

    #[test]
    fn recent_is_unique_and_capped() {
        let mut s = Settings::default();
        for i in 0..15 {
            s.remember_recent(Path::new(&format!("C:\\d\\{i}.md")));
        }
        s.remember_recent(Path::new("C:\\d\\3.md"));
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0], "C:\\d\\3.md");
        assert_eq!(s.recent.iter().filter(|p| p.ends_with("\\3.md")).count(), 1);
    }

    #[test]
    fn data_dir_can_be_redirected_for_tests_and_empty_means_no() {
        std::env::remove_var("MARKLET_DATA_DIR");
        assert!(data_dir_override().is_none());
        std::env::set_var("MARKLET_DATA_DIR", "");
        assert!(data_dir_override().is_none(), "빈 값은 무시한다");
        std::env::set_var("MARKLET_DATA_DIR", "D:\\tmp\\marklet-test");
        assert_eq!(
            data_dir_override(),
            Some(PathBuf::from("D:\\tmp\\marklet-test"))
        );
        std::env::remove_var("MARKLET_DATA_DIR");
    }
}
