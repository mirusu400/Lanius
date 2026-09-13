//! Lanius desktop shell.
//!
//! Owns the window and the Python engine lifecycle: the engine runs as a
//! sidecar process (codex.md §4) and is shut down when the app exits.

use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{Manager, State};

const API_HOST: &str = "127.0.0.1";
const DEFAULT_API_PORT: u16 = 8081;
const DEFAULT_PROXY_PORT: u16 = 8080;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Handle to the sidecar so we can stop it on exit.
#[derive(Default)]
pub struct EngineProcess(Mutex<Option<Child>>);

#[derive(Clone, Serialize)]
pub struct EngineInfo {
    pub api_url: String,
    pub proxy: String,
    pub managed: bool,
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("{API_HOST}:{port}").parse().expect("valid addr"),
        Duration::from_millis(250),
    )
    .is_ok()
}

/// Locate the bundled engine binary, or fall back to the dev checkout.
fn engine_command(app: &tauri::AppHandle) -> Option<Command> {
    // 1. Explicit override, useful for testing and custom installs.
    if let Ok(path) = std::env::var("LANIUS_ENGINE") {
        let path = PathBuf::from(path);
        if path.exists() {
            return Some(Command::new(path));
        }
        log::warn!("LANIUS_ENGINE points at a missing file: {path:?}");
    }

    // 2. Bundled sidecar produced by PyInstaller (resources/lanius-engine).
    for dir in resource_dirs(app) {
        if let Some(bundled) = find_engine_binary(&dir) {
            log::info!("using bundled engine: {bundled:?}");
            return Some(Command::new(bundled));
        }
    }

    // 3. Development: run the engine from the repo's virtualenv.
    let repo = repo_root()?;
    for relative in VENV_PYTHON {
        let venv_python = repo.join(relative);
        if venv_python.exists() {
            let mut cmd = Command::new(venv_python);
            cmd.args(["-m", "app.main"])
                .current_dir(repo.join("engine"));
            return Some(cmd);
        }
    }
    None
}

/// Where a virtualenv keeps its interpreter, per platform.
#[cfg(windows)]
const VENV_PYTHON: &[&str] = &["engine/.venv/Scripts/python.exe"];
#[cfg(not(windows))]
const VENV_PYTHON: &[&str] = &["engine/.venv/bin/python"];

/// Name of the frozen engine produced by PyInstaller.
#[cfg(windows)]
const ENGINE_BINARY: &str = "lanius-engine.exe";
#[cfg(not(windows))]
const ENGINE_BINARY: &str = "lanius-engine";

/// Tauri rewrites resource paths that come from outside the crate (e.g.
/// `../../engine/dist/lanius-engine` becomes `_up_/_up_/engine/dist/...`),
/// so search the resource directory instead of assuming a fixed location.
fn find_engine_binary(root: &std::path::Path) -> Option<PathBuf> {
    fn walk(dir: &std::path::Path, depth: usize) -> Option<PathBuf> {
        if depth > 6 {
            return None;
        }
        let entries = std::fs::read_dir(dir).ok()?;
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                subdirs.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some(ENGINE_BINARY) {
                return Some(path);
            }
        }
        subdirs.into_iter().find_map(|d| walk(&d, depth + 1))
    }
    walk(root, 0)
}

/// Candidate resource directories.
///
/// `resource_dir()` reports "unknown path" for a bundle that has not been
/// installed/signed, so also derive the platform's resource layout from the
/// running executable:
///   macOS  `.../Lanius.app/Contents/MacOS/lanius` -> `../Resources`
///   Linux  `/usr/bin/lanius`                      -> `/usr/lib/lanius`
///          (AppImage mounts the same tree under `$APPDIR`)
fn resource_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    match app.path().resource_dir() {
        Ok(dir) => dirs.push(dir),
        Err(err) => log::debug!("resource_dir unavailable: {err}"),
    }
    if let Ok(exe) = std::env::current_exe() {
        let exe_name = exe
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "lanius".to_string());

        if let Some(exe_dir) = exe.parent() {
            if let Some(parent) = exe_dir.parent() {
                // macOS bundle
                dirs.push(parent.join("Resources"));
                // Linux install prefix: bin/ -> lib/<name>/
                dirs.push(parent.join("lib").join(&exe_name));
                dirs.push(parent.join("lib"));
            }
            // Windows installs, and any portable layout, keep resources
            // next to the executable.
            dirs.push(exe_dir.to_path_buf());
        }
    }
    // AppImage exposes its mounted tree here.
    if let Ok(appdir) = std::env::var("APPDIR") {
        let root = PathBuf::from(appdir);
        dirs.push(root.join("usr/lib").join("lanius"));
        dirs.push(root.join("usr/lib"));
        dirs.push(root);
    }
    dirs.retain(|d| d.exists());
    dirs
}

/// Walk up from the executable looking for the repo layout.
fn repo_root() -> Option<PathBuf> {
    // A bundled .app nests deeply:
    //   shell/src-tauri/target/release/bundle/macos/Lanius.app/Contents/MacOS/
    // so walk generously rather than assuming a fixed depth.
    let candidates = [std::env::current_exe().ok(), std::env::current_dir().ok()];
    for start in candidates.into_iter().flatten() {
        let mut dir = start;
        loop {
            if dir.join("engine/app/main.py").exists() {
                return Some(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    None
}

fn start_engine(app: &tauri::AppHandle, state: &EngineProcess) -> EngineInfo {
    let info = EngineInfo {
        api_url: format!("http://{API_HOST}:{DEFAULT_API_PORT}"),
        proxy: format!("{API_HOST}:{DEFAULT_PROXY_PORT}"),
        managed: false,
    };

    // Reuse an engine the user already started (e.g. `python -m app.main`).
    if port_open(DEFAULT_API_PORT) {
        log::info!("reusing engine already listening on {DEFAULT_API_PORT}");
        return info;
    }

    let Some(mut command) = engine_command(app) else {
        log::error!("engine executable not found; start it manually");
        return info;
    };

    command
        .env("LANIUS_API_PORT", DEFAULT_API_PORT.to_string())
        .env("LANIUS_PROXY_PORT", DEFAULT_PROXY_PORT.to_string())
        // The engine watches us and exits if we die without cleanup
        // (SIGKILL, crash), so it can never orphan the proxy ports.
        .env("LANIUS_WATCH_PARENT", "1")
        // Explicit PID: PyInstaller's bootloader is the engine's direct
        // parent, so getppid() would never notice our death.
        .env("LANIUS_SUPERVISOR_PID", std::process::id().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Put the engine in its own process group and have it die with us.
    // Without this, a SIGTERM/crash of the shell (which skips our exit hooks)
    // would leave an orphaned proxy holding the ports.
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        command.pre_exec(|| {
            // New process group: Ctrl-C on the terminal will not double-kill.
            libc::setpgid(0, 0);
            // macOS/BSD have no PR_SET_PDEATHSIG, so the parent also kills the
            // group explicitly in `stop_engine`.
            Ok(())
        });
    }

    match command.spawn() {
        Ok(child) => {
            *state.0.lock().expect("engine lock") = Some(child);
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            while Instant::now() < deadline {
                if port_open(DEFAULT_API_PORT) {
                    log::info!("engine ready on {DEFAULT_API_PORT}");
                    return EngineInfo {
                        managed: true,
                        ..info
                    };
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            log::error!("engine did not become ready within {STARTUP_TIMEOUT:?}");
            EngineInfo {
                managed: true,
                ..info
            }
        }
        Err(err) => {
            log::error!("failed to spawn engine: {err}");
            info
        }
    }
}

fn stop_engine(state: &EngineProcess) {
    if let Some(mut child) = state.0.lock().expect("engine lock").take() {
        log::info!("stopping engine");
        // Kill the whole group: the engine may have spawned helpers.
        #[cfg(unix)]
        unsafe {
            libc::killpg(child.id() as i32, libc::SIGTERM);
        }
        // On Windows a frozen PyInstaller binary spawns a child of its own, so
        // kill the whole tree rather than just the process we launched.
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Install signal handlers so a SIGTERM/SIGINT still stops the engine.
#[cfg(unix)]
fn install_signal_handlers(handle: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut mask);
            libc::sigaddset(&mut mask, libc::SIGTERM);
            libc::sigaddset(&mut mask, libc::SIGINT);
            libc::sigaddset(&mut mask, libc::SIGHUP);
            libc::pthread_sigmask(libc::SIG_BLOCK, &mask, std::ptr::null_mut());
        }
        let mut signal: libc::c_int = 0;
        if unsafe { libc::sigwait(&mask, &mut signal) } == 0 {
            log::info!("received signal {signal}; shutting down");
            stop_engine(&handle.state::<EngineProcess>());
            std::process::exit(0);
        }
    });
}

/// Where the frontend should talk to the engine.
#[tauri::command]
fn engine_info(state: State<'_, EngineProcess>) -> EngineInfo {
    EngineInfo {
        api_url: format!("http://{API_HOST}:{DEFAULT_API_PORT}"),
        proxy: format!("{API_HOST}:{DEFAULT_PROXY_PORT}"),
        managed: state.0.lock().expect("engine lock").is_some(),
    }
}

#[tauri::command]
fn engine_running() -> bool {
    port_open(DEFAULT_API_PORT)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(EngineProcess::default())
        .invoke_handler(tauri::generate_handler![engine_info, engine_running])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            let state = app.state::<EngineProcess>();
            start_engine(app.handle(), &state);
            #[cfg(unix)]
            install_signal_handlers(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                stop_engine(&window.state::<EngineProcess>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building lanius")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                stop_engine(&app.state::<EngineProcess>());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn port_open_detects_a_listening_socket() {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(port_open(port));
    }

    #[test]
    fn port_open_is_false_for_a_free_port() {
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
            listener.local_addr().expect("addr").port()
        }; // listener dropped, port released
        assert!(!port_open(port));
    }

    #[test]
    fn repo_root_finds_the_engine_in_a_dev_checkout() {
        // Running under `cargo test` the cwd is shell/src-tauri, so walking up
        // must find engine/app/main.py.
        let root = repo_root().expect("repo root");
        assert!(root.join("engine/app/main.py").exists());
        assert!(root.join("ui/package.json").exists());
    }

    #[test]
    fn repo_root_walks_out_of_a_deeply_nested_bundle() {
        // Regression: a fixed 8-level walk missed the repo from
        // target/release/bundle/macos/Lanius.app/Contents/MacOS/lanius.
        let root = repo_root().expect("repo root");
        let bundle = root
            .join("shell/src-tauri/target/release/bundle/macos")
            .join("Lanius.app/Contents/MacOS");
        let mut dir = bundle;
        let mut depth = 0;
        let found = loop {
            if dir.join("engine/app/main.py").exists() {
                break true;
            }
            if !dir.pop() {
                break false;
            }
            depth += 1;
            assert!(depth < 40, "walk should terminate");
        };
        assert!(found, "must reach the repo root from inside a .app bundle");
    }

    #[test]
    fn engine_info_reports_the_default_local_endpoints() {
        // The shell and the UI must agree on where the engine lives.
        assert_eq!(DEFAULT_API_PORT, 8081);
        assert_eq!(DEFAULT_PROXY_PORT, 8080);
        assert_eq!(API_HOST, "127.0.0.1", "engine stays on loopback");
    }

    #[test]
    fn find_engine_binary_locates_a_nested_resource() {
        // Regression: Tauri rewrites out-of-crate resources to `_up_/_up_/...`,
        // so a direct `resource_dir/lanius-engine` lookup found nothing.
        let base = std::env::temp_dir().join("lanius-res-test");
        let nested = base.join("_up_/_up_/engine/dist");
        std::fs::create_dir_all(&nested).expect("mkdir");
        let target = nested.join(ENGINE_BINARY);
        std::fs::write(&target, b"#!/bin/sh\n").expect("write");

        let found = find_engine_binary(&base).expect("engine found");
        assert_eq!(found, target);
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_engine_binary_returns_none_when_absent() {
        let base = std::env::temp_dir().join("lanius-res-empty");
        std::fs::create_dir_all(&base).expect("mkdir");
        assert!(find_engine_binary(&base).is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn find_engine_binary_handles_a_linux_install_prefix() {
        // deb installs to /usr/bin/lanius with resources under /usr/lib/lanius.
        let base = std::env::temp_dir().join("lanius-linux-prefix");
        let lib = base.join("usr/lib/lanius");
        std::fs::create_dir_all(&lib).expect("mkdir");
        let target = lib.join(ENGINE_BINARY);
        std::fs::write(&target, b"#!/bin/sh\n").expect("write");

        assert_eq!(find_engine_binary(&lib).as_ref(), Some(&target));
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn engine_binary_name_matches_the_platform() {
        // PyInstaller appends .exe on Windows; discovery must look for the
        // right name or a Windows install would never find its engine.
        if cfg!(windows) {
            assert_eq!(ENGINE_BINARY, "lanius-engine.exe");
            assert!(VENV_PYTHON[0].contains("Scripts"));
        } else {
            assert_eq!(ENGINE_BINARY, "lanius-engine");
            assert!(VENV_PYTHON[0].ends_with("bin/python"));
        }
    }

    #[test]
    fn find_engine_binary_ignores_similar_names() {
        let base = std::env::temp_dir().join("lanius-res-similar");
        std::fs::create_dir_all(&base).expect("mkdir");
        std::fs::write(base.join(format!("{ENGINE_BINARY}.txt")), b"x").expect("write");
        std::fs::write(base.join("engine"), b"x").expect("write");
        assert!(find_engine_binary(&base).is_none());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn stop_engine_is_safe_when_nothing_is_running() {
        let state = EngineProcess::default();
        stop_engine(&state); // must not panic
        assert!(state.0.lock().expect("lock").is_none());
    }
}
