//! Preflight Doctor for the project picker.
//!
//! The in-app Doctor talks to a running engine, so it cannot explain why the
//! engine or its proxy fails to start. This one runs the engine executable
//! with `--doctor`, which checks the runtime, ports, CA and a throwaway
//! mitmproxy listener, prints JSON and exits. It also returns the tail of the
//! last engine log, which holds the reason a project failed to open.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::State;

use crate::{api_port, engine_command, projects, proxy_port, ProjectSession};

/// The engine's own checks bound each step; this only stops a hung process.
const DOCTOR_TIMEOUT: Duration = Duration::from_secs(60);
/// Enough of the log to show a Python traceback in full.
const LOG_TAIL_LINES: usize = 60;

#[derive(Serialize)]
pub struct DoctorReport {
    /// The executable that was checked, if one was found at all.
    engine: Option<String>,
    /// The engine's JSON report, when it managed to produce one.
    report: Option<serde_json::Value>,
    /// Why there is no report: missing engine, crash, timeout, bad output.
    error: Option<String>,
    /// What the engine printed to stderr while running the checks.
    output: Option<String>,
    /// The end of the log from the last time a project started the engine.
    last_log: Option<String>,
}

/// Where the engine's stderr goes while a project is open. It is replaced
/// on every start, so it only ever holds the current or most recent session.
pub fn engine_log_path() -> Result<PathBuf, String> {
    Ok(projects::home()?.join("logs").join("engine.log"))
}

/// Open a fresh engine log, or fall back to discarding output.
pub fn engine_log() -> Stdio {
    let open = || -> std::io::Result<std::fs::File> {
        let path = engine_log_path().map_err(std::io::Error::other)?;
        if let Some(dir) = path.parent() {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
            builder.create(dir)?;
        }
        std::fs::File::create(path)
    };
    match open() {
        Ok(file) => Stdio::from(file),
        Err(err) => {
            log::warn!("engine log unavailable: {err}");
            Stdio::null()
        }
    }
}

/// The last `lines` lines of a text file, if it exists and is not empty.
pub fn tail(path: &std::path::Path, lines: usize) -> Option<String> {
    let text = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&text);
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    let joined = all[start..].join("\n");
    (!joined.trim().is_empty()).then_some(joined)
}

fn last_log() -> Option<String> {
    tail(&engine_log_path().ok()?, LOG_TAIL_LINES)
}

fn read_all(mut pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = pipe.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).into_owned()
    })
}

fn kill(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as i32, libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(crate::taskkill_args(child.id()))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
}

/// What a one-shot engine command printed, and how it ended.
pub struct OneShot {
    /// None when it was stopped for running past its time limit.
    pub status: Option<std::process::ExitStatus>,
    pub stdout: String,
    pub stderr: String,
}

/// Run the engine for a single command (`--doctor`, `--migration-status`)
/// and collect its output, stopping it if it runs past `timeout`.
pub fn run_once(mut command: Command, timeout: Duration) -> Result<OneShot, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Own process group, so a timeout also stops whatever a frozen
    // bootloader started underneath.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            libc::setpgid(0, 0);
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("failed to run engine: {err}"))?;
    let stdout = read_all(child.stdout.take().expect("piped stdout"));
    let stderr = read_all(child.stderr.take().expect("piped stderr"));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(100)),
            _ => {
                kill(&mut child);
                let _ = child.wait();
                break None;
            }
        }
    };
    Ok(OneShot {
        status,
        stdout: stdout.join().unwrap_or_default(),
        stderr: stderr.join().unwrap_or_default(),
    })
}

fn run(app: &tauri::AppHandle) -> DoctorReport {
    let mut report = DoctorReport {
        engine: None,
        report: None,
        error: None,
        output: None,
        last_log: last_log(),
    };
    let Some(mut command) = engine_command(app) else {
        report.error = Some("engine executable was not found".to_string());
        return report;
    };
    report.engine = Some(command.get_program().to_string_lossy().into_owned());
    command
        .arg("--doctor")
        .env("LANIUS_API_PORT", api_port().to_string())
        .env("LANIUS_PROXY_PORT", proxy_port().to_string());
    if let Ok(home) = projects::home() {
        command.env("LANIUS_DATA_DIR", home);
    }
    let shot = match run_once(command, DOCTOR_TIMEOUT) {
        Ok(shot) => shot,
        Err(err) => {
            report.error = Some(err);
            return report;
        }
    };
    report.output = (!shot.stderr.trim().is_empty()).then(|| {
        let lines: Vec<&str> = shot.stderr.lines().collect();
        lines[lines.len().saturating_sub(LOG_TAIL_LINES)..].join("\n")
    });

    match shot.status {
        None => {
            report.error = Some(format!("engine did not finish within {DOCTOR_TIMEOUT:?}"));
        }
        Some(status) => match serde_json::from_str::<serde_json::Value>(shot.stdout.trim()) {
            Ok(value) if status.success() => report.report = Some(value),
            _ => report.error = Some(format!("engine exited with {status} before reporting")),
        },
    }
    report
}

/// Check that the engine and its proxy can start, without a project.
#[tauri::command]
pub async fn run_doctor(
    app: tauri::AppHandle,
    session: State<'_, ProjectSession>,
) -> Result<DoctorReport, String> {
    // With a project open the engine already holds both ports, so every
    // port check would fail; the in-app Doctor covers that case.
    if session.0.lock().expect("project lock").is_some() {
        return Err("close the project before running the startup Doctor".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || run(&app))
        .await
        .map_err(|err| err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_the_last_lines() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("engine.log");
        std::fs::write(&path, "one\ntwo\nthree\n").expect("write");
        assert_eq!(tail(&path, 2).as_deref(), Some("two\nthree"));
        assert_eq!(tail(&path, 10).as_deref(), Some("one\ntwo\nthree"));
    }

    #[test]
    fn tail_of_a_missing_or_blank_log_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("engine.log");
        assert_eq!(tail(&path, 5), None);
        std::fs::write(&path, "\n  \n").expect("write");
        assert_eq!(tail(&path, 5), None);
    }
}
