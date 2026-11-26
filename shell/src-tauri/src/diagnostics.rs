//! Error reports from the shell, and saving the engine's diagnostic bundle.
//!
//! The engine owns the reports directory and the bundle format. The shell
//! adds what only it can see, a panic, as a report in the same directory
//! and the same JSON shape, so one bundle carries both halves.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::projects;

/// Shared with the engine through `LANIUS_LOG_DIR`.
pub fn log_dir() -> Result<PathBuf, String> {
    Ok(projects::home()?.join("logs"))
}

/// Where `tauri_plugin_log` writes the shell's own log.
pub fn shell_log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_log_dir().ok()?;
    Some(dir.join(format!("{}.log", app.package_info().name)))
}

/// Record panics before the default hook prints them.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| text.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let location = info
            .location()
            .map(|location| format!("{}:{}", location.file(), location.line()));
        let trace = std::backtrace::Backtrace::force_capture().to_string();
        let thread = std::thread::current().name().map(str::to_string);
        if let Ok(dir) = log_dir() {
            if let Err(error) = write_report(&dir, &message, location, &trace, thread) {
                log::warn!("could not write a panic report: {error}");
            }
        }
        previous(info);
    }));
}

fn write_report(
    log_dir: &Path,
    message: &str,
    location: Option<String>,
    trace: &str,
    thread: Option<String>,
) -> std::io::Result<PathBuf> {
    let reports = log_dir.join("reports");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&reports)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let mut bytes = [0_u8; 6];
    let _ = getrandom::fill(&mut bytes);
    let id: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    let report = serde_json::json!({
        "id": id,
        "source": "shell",
        "time": rfc3339(now.as_secs()),
        "version": env!("CARGO_PKG_VERSION"),
        "kind": "panic",
        "message": message,
        "traceback": trace,
        "context": { "location": location, "thread": thread },
    });
    // Same naming as the engine: a fixed-width nanosecond clock sorts by age.
    let path = reports.join(format!("{:020}-shell-{id}.json", now.as_nanos()));
    std::fs::write(&path, report.to_string())?;
    Ok(path)
}

/// UTC `YYYY-MM-DDTHH:MM:SS+00:00` without pulling in a date crate.
fn rfc3339(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}+00:00",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60
    )
}

fn bundle_endpoint() -> String {
    format!(
        "/api/diagnostics/bundle?shell={}",
        env!("CARGO_PKG_VERSION")
    )
}

/// Native Save As for the diagnostic bundle. Nothing is uploaded: the user
/// attaches the file to an issue themselves.
#[tauri::command]
pub async fn save_diagnostics_bundle(
    window: tauri::WebviewWindow,
    default_name: String,
    title: String,
) -> Result<Option<String>, String> {
    let port = crate::api_port();
    let token = crate::api_token().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_file_name(default_name)
            .add_filter("Diagnostic bundle", &["zip"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        crate::project_export::save_engine_file(
            &path,
            port,
            &token,
            &bundle_endpoint(),
            "Diagnostic bundle",
        )?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_utc_timestamps() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00+00:00");
        assert_eq!(rfc3339(1_795_660_800), "2026-11-26T02:40:00+00:00");
        assert_eq!(rfc3339(951_782_400 + 3_661), "2000-02-29T01:01:01+00:00");
    }

    #[test]
    fn panic_reports_match_the_engine_format() {
        let directory = tempfile::tempdir().unwrap();
        let path = write_report(
            directory.path(),
            "index out of bounds",
            Some("src/lib.rs:10".to_string()),
            "frame 0",
            Some("main".to_string()),
        )
        .unwrap();
        assert_eq!(path.parent().unwrap(), directory.path().join("reports"));
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert_eq!(name.split('-').next().unwrap().len(), 20);
        assert!(name.contains("-shell-"));
        let report: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for key in [
            "id",
            "source",
            "time",
            "version",
            "kind",
            "message",
            "traceback",
            "context",
        ] {
            assert!(report.get(key).is_some(), "missing {key}");
        }
        assert_eq!(report["source"], "shell");
        assert_eq!(report["context"]["location"], "src/lib.rs:10");
    }

    #[test]
    fn bundle_endpoint_passes_a_version_the_engine_accepts() {
        let endpoint = bundle_endpoint();
        let version = endpoint.rsplit('=').next().unwrap();
        assert!(version
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._+-".contains(c)));
    }
}
