//! Lanius desktop shell.
//!
//! Owns the window and the Python engine lifecycle: the engine runs as a
//! sidecar process (codex.md §4) and is shut down when the app exits.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tauri_plugin_updater::UpdaterExt;

#[cfg(any(target_os = "linux", test))]
mod linux_webkit;
mod projects;
mod screenshot;

#[derive(Default)]
pub struct ProjectSession(Mutex<Option<projects::Project>>);

const API_HOST: &str = "127.0.0.1";
const DEFAULT_API_PORT: u16 = 12954;
const DEFAULT_PROXY_PORT: u16 = 8080;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// Handle to the sidecar so we can stop it on exit.
#[derive(Default)]
pub struct EngineProcess(Mutex<Option<Child>>);

#[derive(Clone, Serialize)]
pub struct EngineInfo {
    pub api_url: String,
    pub api_token: String,
    pub proxy: String,
    pub managed: bool,
    /// The shell's own version, which is not necessarily the engine's:
    /// a development build can pair either with either.
    pub shell_version: String,
}

impl EngineInfo {
    /// The local endpoints, before it is known whether we started the
    /// engine ourselves.
    fn local() -> Self {
        Self {
            api_url: format!("http://{API_HOST}:{}", api_port()),
            api_token: api_token().to_string(),
            proxy: format!("{API_HOST}:{}", proxy_port()),
            managed: false,
            shell_version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

/// A capability shared only with the engine child and this desktop webview.
/// It is intentionally regenerated whenever the shell starts.
fn api_token() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(|| {
        if let Ok(value) = std::env::var("LANIUS_API_TOKEN") {
            let value = value.trim();
            if !value.is_empty()
                && value.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
                })
            {
                return value.to_string();
            }
            log::warn!("ignoring invalid LANIUS_API_TOKEN");
        }
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).expect("operating system randomness is unavailable");
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    })
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("{API_HOST}:{port}").parse().expect("valid addr"),
        Duration::from_millis(250),
    )
    .is_ok()
}

/// Locate the bundled engine binary, or fall back to the dev checkout.
/// A port from the environment, falling back to the default. An
/// unparseable value is ignored rather than taken as 0.
fn port_override(var: &str, default: u16) -> u16 {
    match std::env::var(var) {
        Ok(value) => match value.trim().parse::<u16>() {
            Ok(port) if port > 0 => port,
            _ => {
                log::warn!("{var} is not a valid port: {value:?}; using {default}");
                default
            }
        },
        Err(_) => default,
    }
}

#[derive(Deserialize, Serialize)]
struct DesktopSettings {
    #[serde(default = "default_api_port")]
    api_port: u16,
    #[serde(default)]
    lockdown_global: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            api_port: DEFAULT_API_PORT,
            lockdown_global: false,
        }
    }
}

fn default_api_port() -> u16 {
    DEFAULT_API_PORT
}

#[derive(Serialize)]
struct GlobalLockdown {
    enabled: bool,
    forced: bool,
}

fn desktop_settings_path() -> Result<PathBuf, String> {
    Ok(projects::home()?.join("desktop.json"))
}

fn read_desktop_settings() -> Result<DesktopSettings, String> {
    let path = desktop_settings_path()?;
    match std::fs::read(path) {
        Ok(data) => serde_json::from_slice(&data).map_err(|err| err.to_string()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(DesktopSettings::default()),
        Err(err) => Err(err.to_string()),
    }
}

fn save_desktop_settings(settings: &DesktopSettings) -> Result<(), String> {
    let path = desktop_settings_path()?;
    projects::ensure_private_dir(path.parent().ok_or("invalid settings path")?)?;
    let data = serde_json::to_vec_pretty(settings).map_err(|err| err.to_string())?;
    projects::write_private(&path, &data)
}

fn saved_api_port() -> Option<u16> {
    let settings = read_desktop_settings().ok()?;
    (settings.api_port > 0).then_some(settings.api_port)
}

fn save_api_port(port: u16) -> Result<(), String> {
    let mut settings = read_desktop_settings()?;
    settings.api_port = port;
    save_desktop_settings(&settings)
}

fn lockdown_forced() -> bool {
    std::env::var("LANIUS_LOCKDOWN").as_deref() == Ok("1")
}

fn global_lockdown() -> bool {
    lockdown_forced()
        || read_desktop_settings()
            .map(|settings| settings.lockdown_global)
            .unwrap_or(true)
}

/// The API port this run should use.
fn api_port() -> u16 {
    if std::env::var_os("LANIUS_API_PORT").is_some() {
        port_override("LANIUS_API_PORT", DEFAULT_API_PORT)
    } else {
        saved_api_port().unwrap_or(DEFAULT_API_PORT)
    }
}

/// The proxy port this run should use.
fn proxy_port() -> u16 {
    port_override("LANIUS_PROXY_PORT", DEFAULT_PROXY_PORT)
}

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

/// Arguments that terminate a process *tree* on Windows.
///
/// `/T` includes children, so helpers started by the frozen engine cannot
/// keep the proxy port bound after the shell exits. Defined for every platform
/// so the argument order stays under test on POSIX CI too.
#[cfg_attr(not(windows), allow(dead_code))]
fn taskkill_args(pid: u32) -> [String; 4] {
    [
        "/PID".to_string(),
        pid.to_string(),
        "/T".to_string(),
        "/F".to_string(),
    ]
}

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

fn start_engine(
    app: &tauri::AppHandle,
    state: &EngineProcess,
    data_dir: &std::path::Path,
) -> Result<(), String> {
    // Reusing another engine would silently put this project's traffic into
    // that engine's database. Make the port conflict visible instead.
    if port_open(api_port()) {
        return Err(format!("API port {} is already in use", api_port()));
    }

    let Some(mut command) = engine_command(app) else {
        return Err("engine executable was not found".to_string());
    };

    command
        .env("LANIUS_DATA_DIR", data_dir)
        // Ports are overridable: another tool may already hold 8080, and
        // hardcoding it would leave the app unable to start at all.
        .env("LANIUS_API_PORT", api_port().to_string())
        .env("LANIUS_API_TOKEN", api_token())
        .env("LANIUS_PROXY_PORT", proxy_port().to_string())
        .env(
            "LANIUS_LOCKDOWN_GLOBAL",
            if global_lockdown() { "1" } else { "0" },
        )
        // The engine watches us and exits if we die without cleanup
        // (SIGKILL, crash), so it can never orphan the proxy ports.
        .env("LANIUS_WATCH_PARENT", "1")
        // Explicit PID lets the engine watch the shell even if a frozen
        // bootloader starts another process between them.
        .env("LANIUS_SUPERVISOR_PID", std::process::id().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Plugin files are installed once per machine. Which plugins are
    // enabled remains a setting in each project's own database.
    if std::env::var_os("LANIUS_PLUGINS_DIR").is_none() {
        command.env("LANIUS_PLUGINS_DIR", projects::home()?.join("plugins"));
    }

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
            let pid = child.id();
            *state.0.lock().expect("engine lock") = Some(child);
            let deadline = Instant::now() + STARTUP_TIMEOUT;
            while Instant::now() < deadline {
                if port_open(api_port()) {
                    log::info!("engine ready on {}", api_port());
                    return Ok(());
                }
                if state
                    .0
                    .lock()
                    .expect("engine lock")
                    .as_mut()
                    .and_then(|c| c.try_wait().ok())
                    .flatten()
                    .is_some()
                {
                    stop_engine(state);
                    return Err(format!("engine process {pid} exited during startup"));
                }
                std::thread::sleep(Duration::from_millis(150));
            }
            stop_engine(state);
            Err(format!(
                "engine did not become ready within {STARTUP_TIMEOUT:?}"
            ))
        }
        Err(err) => Err(format!("failed to spawn engine: {err}")),
    }
}

fn stop_engine(state: &EngineProcess) {
    if let Some(mut child) = state.0.lock().expect("engine lock").take() {
        log::info!("stopping engine");
        // SIGTERM lets the engine shut down cleanly. Ensure any child in
        // its process group is gone before another project uses the ports.
        #[cfg(unix)]
        unsafe {
            let group = child.id() as i32;
            libc::killpg(group, libc::SIGTERM);
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                let _ = child.try_wait();
                if libc::killpg(group, 0) != 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            libc::killpg(group, libc::SIGKILL);
        }
        // On Windows, kill the whole tree in case the engine started helpers.
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(taskkill_args(child.id()))
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
            end_project(
                &handle.state::<EngineProcess>(),
                &handle.state::<ProjectSession>(),
            );
            std::process::exit(0);
        }
    });
}

/// Where the frontend should talk to the engine.
#[tauri::command]
fn engine_info(state: State<'_, EngineProcess>) -> EngineInfo {
    EngineInfo {
        managed: state.0.lock().expect("engine lock").is_some(),
        ..EngineInfo::local()
    }
}

#[tauri::command]
fn engine_running() -> bool {
    port_open(api_port())
}

const LOCKDOWN_BLOCKED: &str = "LOCKDOWN_MODE_BLOCKED";
/// Still a refusal, and still matched by the UI's prefix check, but it says
/// the engine never answered rather than blaming a setting the user did not
/// make. A restarting engine is the common cause.
const UNCONFIRMED: &str =
    "LOCKDOWN_MODE_BLOCKED: the engine did not confirm whether this project is locked";

#[tauri::command]
fn get_global_lockdown() -> Result<GlobalLockdown, String> {
    // Report the value the engine will actually be started with, including
    // the locked reading of a settings file that cannot be parsed. Returning
    // an error here would disable the checkbox and leave no way out.
    Ok(GlobalLockdown {
        enabled: global_lockdown(),
        forced: lockdown_forced(),
    })
}

#[tauri::command]
async fn set_global_lockdown(
    enabled: bool,
    app: tauri::AppHandle,
) -> Result<GlobalLockdown, String> {
    tauri::async_runtime::spawn_blocking(move || change_global_lockdown(enabled, &app))
        .await
        .map_err(|err| err.to_string())?
}

#[tauri::command]
async fn restart_project_engine(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = app.state::<EngineProcess>();
        let session = app.state::<ProjectSession>();
        let active = session.0.lock().expect("project lock");
        let project = active.as_ref().ok_or("no project is open")?;
        let dir = project
            .db_path
            .parent()
            .ok_or("invalid project directory")?;
        stop_engine(&engine);
        start_engine(&app, &engine, dir)
    })
    .await
    .map_err(|err| err.to_string())?
}

fn change_global_lockdown(enabled: bool, app: &tauri::AppHandle) -> Result<GlobalLockdown, String> {
    if lockdown_forced() && !enabled {
        return Err("LANIUS_LOCKDOWN forces Lockdown Mode on".to_string());
    }
    // A settings file that cannot be parsed reads as locked. Start from the
    // defaults so the user's own toggle can rewrite it, which is the only way
    // back out of that state.
    let was = global_lockdown();
    let mut settings = read_desktop_settings().unwrap_or_default();
    if was == enabled && settings.lockdown_global == enabled {
        return get_global_lockdown();
    }
    let old = settings.lockdown_global;
    let engine = app.state::<EngineProcess>();
    let session = app.state::<ProjectSession>();
    let active = session.0.lock().expect("project lock");
    settings.lockdown_global = enabled;
    save_desktop_settings(&settings)?;
    if let Some(project) = active.as_ref() {
        stop_engine(&engine);
        let dir = project
            .db_path
            .parent()
            .ok_or("invalid project directory")?;
        if let Err(err) = start_engine(app, &engine, dir) {
            settings.lockdown_global = old;
            let rollback =
                save_desktop_settings(&settings).and_then(|_| start_engine(app, &engine, dir));
            return Err(match rollback {
                Ok(()) => {
                    format!("could not change Lockdown Mode: {err}; previous setting restored")
                }
                Err(rollback_err) => {
                    format!("could not change Lockdown Mode: {err}; restore failed: {rollback_err}")
                }
            });
        }
    }
    get_global_lockdown()
}

/// Fail closed if the active engine cannot confirm that its project is unlocked.
fn require_product_egress() -> Result<(), String> {
    if global_lockdown() {
        return Err(LOCKDOWN_BLOCKED.to_string());
    }
    project_egress_allowed().map_err(|_| UNCONFIRMED.to_string())?
}

/// Ask the running engine whether the open project is locked.
///
/// `Err` means the answer never arrived, which is not the same as a locked
/// project; both refuse, but only one of them is the user's own setting.
fn project_egress_allowed() -> Result<Result<(), String>, ()> {
    let address = format!("{API_HOST}:{}", api_port());
    let socket = address.parse().map_err(|_| ())?;
    let mut stream =
        TcpStream::connect_timeout(&socket, Duration::from_millis(500)).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(500)))
        .map_err(|_| ())?;
    let request = format!(
        "GET /api/lockdown HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
        api_token()
    );
    stream.write_all(request.as_bytes()).map_err(|_| ())?;
    let mut response = Vec::new();
    stream
        .take(4096)
        .read_to_end(&mut response)
        .map_err(|_| ())?;
    let response = String::from_utf8(response).map_err(|_| ())?;
    let (headers, body) = response.split_once("\r\n\r\n").ok_or(())?;
    if !headers.starts_with("HTTP/1.1 200 ") {
        return Err(());
    }
    let status: serde_json::Value = serde_json::from_str(body).map_err(|_| ())?;
    match status.get("effective").and_then(serde_json::Value::as_bool) {
        Some(false) => Ok(Ok(())),
        Some(true) => Ok(Err(LOCKDOWN_BLOCKED.to_string())),
        None => Err(()),
    }
}

/// `require_product_egress` blocks on a local socket; keep it off the async
/// runtime's worker threads.
async fn check_product_egress() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(require_product_egress)
        .await
        .map_err(|_| LOCKDOWN_BLOCKED.to_string())?
}

/// Keep checking while the native updater owns a network connection. Dropping
/// its future stops a check or download when either checkbox turns on.
async fn monitored_product_egress<T, F>(operation: F) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, String>>,
{
    check_product_egress().await?;
    tokio::pin!(operation);
    loop {
        tokio::select! {
            // Once the operation has finished its packets are gone; refusing
            // the result then would only leave an installed update unapplied.
            result = &mut operation => return result,
            _ = tokio::time::sleep(Duration::from_millis(250)) => {
                check_product_egress().await?;
            }
        }
    }
}

/// Change the local API/MCP port and restart the active project's engine.
#[tauri::command]
async fn set_api_port(port: u16, app: tauri::AppHandle) -> Result<EngineInfo, String> {
    tauri::async_runtime::spawn_blocking(move || change_api_port(port, &app))
        .await
        .map_err(|err| err.to_string())?
}

fn change_api_port(port: u16, app: &tauri::AppHandle) -> Result<EngineInfo, String> {
    let engine = app.state::<EngineProcess>();
    let session = app.state::<ProjectSession>();
    if port == 0 {
        return Err("port must be between 1 and 65535".to_string());
    }
    if std::env::var_os("LANIUS_API_PORT").is_some() {
        return Err(
            "LANIUS_API_PORT overrides the port; remove it before changing Settings".to_string(),
        );
    }
    let old_port = api_port();
    if port == old_port {
        return Ok(engine_info(engine));
    }
    if port_open(port) {
        return Err(format!("port {port} is already in use"));
    }
    // Keep project switches out of the middle of a port change.
    let active = session.0.lock().expect("project lock");
    let project = active.clone();
    if project.is_some() {
        stop_engine(&engine);
    }
    if let Err(err) = save_api_port(port) {
        if let Some(project) = &project {
            if let Some(dir) = project.db_path.parent() {
                let _ = start_engine(app, &engine, dir);
            }
        }
        return Err(err);
    }
    if let Some(project) = &project {
        let dir = project
            .db_path
            .parent()
            .ok_or("invalid project directory")?;
        if let Err(err) = start_engine(app, &engine, dir) {
            let rollback = save_api_port(old_port).and_then(|_| start_engine(app, &engine, dir));
            return Err(match rollback {
                Ok(()) => format!("could not use port {port}: {err}; previous port restored"),
                Err(rollback_err) => {
                    format!("could not use port {port}: {err}; restore failed: {rollback_err}")
                }
            });
        }
    }
    Ok(engine_info(engine))
}

fn begin_project(
    app: &tauri::AppHandle,
    engine: &EngineProcess,
    session: &ProjectSession,
    project: projects::Project,
) -> Result<projects::Project, String> {
    let mut active = session.0.lock().expect("project lock");
    if active.is_some() {
        return Err("a project is already open".to_string());
    }
    let data_dir = project
        .db_path
        .parent()
        .ok_or("invalid project directory")?;
    if let Err(err) = start_engine(app, engine, data_dir) {
        if project.temporary {
            let _ = std::fs::remove_dir_all(data_dir);
        }
        return Err(err);
    }
    *active = Some(project.clone());
    Ok(project)
}

#[tauri::command]
fn list_projects() -> Result<Vec<projects::Project>, String> {
    projects::list(&projects::home()?)
}

#[tauri::command]
fn current_project(session: State<'_, ProjectSession>) -> Option<projects::Project> {
    session.0.lock().expect("project lock").clone()
}

#[tauri::command]
fn create_project(
    name: String,
    app: tauri::AppHandle,
    engine: State<'_, EngineProcess>,
    session: State<'_, ProjectSession>,
) -> Result<projects::Project, String> {
    let project = projects::create(&projects::home()?, &name)?;
    begin_project(&app, &engine, &session, project)
}

#[tauri::command]
fn open_project(
    id: String,
    app: tauri::AppHandle,
    engine: State<'_, EngineProcess>,
    session: State<'_, ProjectSession>,
) -> Result<projects::Project, String> {
    let project = projects::open(&projects::home()?, &id)?;
    begin_project(&app, &engine, &session, project)
}

#[tauri::command]
fn start_temp_project(
    app: tauri::AppHandle,
    engine: State<'_, EngineProcess>,
    session: State<'_, ProjectSession>,
) -> Result<projects::Project, String> {
    begin_project(&app, &engine, &session, projects::temporary()?)
}

fn end_project(engine: &EngineProcess, session: &ProjectSession) {
    let mut active = session.0.lock().expect("project lock");
    stop_engine(engine);
    if let Some(project) = active.take() {
        if project.temporary {
            if let Some(dir) = project.db_path.parent() {
                if let Err(err) = std::fs::remove_dir_all(dir) {
                    log::warn!("could not remove temporary project: {err}");
                }
            }
        }
    }
}

#[tauri::command]
fn close_project(engine: State<'_, EngineProcess>, session: State<'_, ProjectSession>) {
    end_project(&engine, &session);
}

/// Match the window chrome to the theme the page is using.
///
/// The page repaints itself from a CSS custom property, but the title
/// bar and the window frame are drawn by the OS and do not know about
/// it, so picking the light theme left a dark bar above a light app.
///
/// `None` hands the window back to the system, which is what "follow the
/// system" has to mean: the window then keeps following later changes on
/// its own.
#[tauri::command]
fn set_window_theme(window: tauri::Window, theme: Option<String>) -> Result<(), String> {
    window
        .set_theme(parse_theme(theme.as_deref()))
        .map_err(|e| e.to_string())
}

/// `None` means "follow the system", which is also what anything
/// unrecognised means: a window stuck on the wrong theme is worse than
/// one that defers to the OS.
fn parse_theme(theme: Option<&str>) -> Option<tauri::Theme> {
    match theme {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,
    }
}

/// How far the download has got.
///
/// Polled rather than pushed: the interface already asks the engine for
/// things on a timer, and an event channel would be one more moving
/// part to keep working across Tauri versions for a bar that is on
/// screen for a few seconds.
#[derive(Default)]
pub struct UpdateProgress {
    downloaded: AtomicU64,
    /// Zero until the server says how large the download is, which some
    /// do not.
    total: AtomicU64,
}

/// What a newer build says about itself.
#[derive(Clone, Serialize)]
pub struct UpdateOffer {
    pub version: String,
    pub current_version: String,
    pub date: Option<String>,
    pub notes: Option<String>,
}

#[derive(Clone, Serialize)]
pub struct UpdateProgressReport {
    pub downloaded: u64,
    /// None while the size is unknown, so the interface can show a bar
    /// without a percentage rather than a wrong one.
    pub total: Option<u64>,
}

/// Is there a signed build to install, according to the shell?
///
/// This is the engine's question asked again by the half that can act on
/// the answer: the engine compares commits and hands out a link, while
/// the updater checks the signed manifest it is allowed to install from.
/// A build with no updater configured says so, and the interface falls
/// back to the download link.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<Option<UpdateOffer>, String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let found =
        monitored_product_egress(async { updater.check().await.map_err(|err| err.to_string()) })
            .await?;
    Ok(found.map(|update| UpdateOffer {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        date: update.date.map(|date| date.to_string()),
        notes: update.body.clone(),
    }))
}

/// Download the new build, install it, and come back up on it.
///
/// The engine is stopped first: it holds the project database open and
/// the proxy port, and an installer replacing the bundle underneath a
/// running sidecar is how a half-written database happens.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|err| err.to_string())?;
    let update =
        monitored_product_egress(async { updater.check().await.map_err(|err| err.to_string()) })
            .await?
            .ok_or("there is no newer build to install")?;

    let progress = app.state::<Arc<UpdateProgress>>().inner().clone();
    progress.downloaded.store(0, Ordering::Relaxed);
    progress.total.store(0, Ordering::Relaxed);

    let counter = progress.clone();
    monitored_product_egress(async {
        update
            .download_and_install(
                move |chunk, total| {
                    counter
                        .downloaded
                        .fetch_add(chunk as u64, Ordering::Relaxed);
                    if let Some(total) = total {
                        counter.total.store(total, Ordering::Relaxed);
                    }
                },
                || {},
            )
            .await
            .map_err(|err| err.to_string())
    })
    .await?;

    end_project(
        &app.state::<EngineProcess>(),
        &app.state::<ProjectSession>(),
    );
    // Windows hands over to the installer, which closes the app itself,
    // so this line is only reached on the platforms that do not.
    app.restart();
}

/// How far `update_install` has got, for the bar on screen.
#[tauri::command]
fn update_progress(progress: State<'_, Arc<UpdateProgress>>) -> UpdateProgressReport {
    let total = progress.total.load(Ordering::Relaxed);
    UpdateProgressReport {
        downloaded: progress.downloaded.load(Ordering::Relaxed),
        total: (total > 0).then_some(total),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_webkit::configure_before_webview();

    tauri::Builder::default()
        .manage(EngineProcess::default())
        .manage(ProjectSession::default())
        .manage(Arc::new(UpdateProgress::default()))
        .invoke_handler(tauri::generate_handler![
            engine_info,
            engine_running,
            get_global_lockdown,
            set_global_lockdown,
            restart_project_engine,
            set_api_port,
            set_window_theme,
            list_projects,
            current_project,
            create_project,
            open_project,
            start_temp_project,
            close_project,
            screenshot::capture_current_window,
            update_check,
            update_install,
            update_progress
        ])
        .setup(|app| {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
            // A build made without a signing key has no updater endpoint,
            // and that is a working build: it still says a newer one
            // exists and links to it. So a missing updater is a note in
            // the log, not a refusal to start.
            if let Err(err) = app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
            {
                log::warn!("no updater in this build: {err}");
            }
            #[cfg(unix)]
            install_signal_handlers(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                end_project(
                    &window.state::<EngineProcess>(),
                    &window.state::<ProjectSession>(),
                );
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building lanius")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                end_project(
                    &app.state::<EngineProcess>(),
                    &app.state::<ProjectSession>(),
                );
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn theme_names_map_to_window_themes() {
        assert_eq!(parse_theme(Some("dark")), Some(tauri::Theme::Dark));
        assert_eq!(parse_theme(Some("light")), Some(tauri::Theme::Light));
    }

    #[test]
    fn following_the_system_leaves_the_window_to_the_system() {
        // Resolving it here would pin the window to whatever the system
        // was at that moment and stop it following later changes.
        assert_eq!(parse_theme(None), None);
        assert_eq!(parse_theme(Some("system")), None);
    }

    #[test]
    fn an_unknown_theme_defers_rather_than_guessing() {
        assert_eq!(parse_theme(Some("solarized")), None);
    }

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
        assert_eq!(DEFAULT_API_PORT, 12954);
        assert_eq!(DEFAULT_PROXY_PORT, 8080);
        assert_eq!(API_HOST, "127.0.0.1", "engine stays on loopback");
    }

    #[test]
    fn engine_info_carries_the_shell_version() {
        // So a bug report can say which shell it came from, which is not
        // necessarily the same build as the engine beside it.
        let info = EngineInfo::local();
        assert_eq!(info.shell_version, env!("CARGO_PKG_VERSION"));
        assert!(!info.shell_version.is_empty());
    }

    #[test]
    fn find_engine_binary_locates_a_nested_resource() {
        // Regression: Tauri rewrites out-of-crate resources to `_up_/_up_/...`,
        // so a direct `resource_dir/lanius-engine` lookup found nothing.
        let base = std::env::temp_dir().join("lanius-res-test");
        let nested = base.join("_up_/_up_/engine/dist/lanius-engine");
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
        let target = lib.join("lanius-engine").join(ENGINE_BINARY);
        std::fs::create_dir_all(target.parent().expect("engine dir")).expect("mkdir engine");
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

    #[test]
    fn taskkill_targets_the_whole_process_tree() {
        // /T is the part that matters: the frozen engine re-executes itself,
        // so killing only the spawned pid would leave the proxy port bound.
        let args = taskkill_args(4321);
        assert_eq!(args, ["/PID", "4321", "/T", "/F"]);
    }

    #[test]
    fn port_override_reads_the_environment() {
        // Another proxy tool may already hold 8080, so the app must not be
        // pinned to it.
        let var = "LANIUS_TEST_PORT_OVERRIDE";
        unsafe { std::env::set_var(var, "9999") };
        assert_eq!(port_override(var, 8080), 9999);
        unsafe { std::env::remove_var(var) };
        assert_eq!(port_override(var, 8080), 8080);
    }

    #[test]
    fn port_override_ignores_nonsense() {
        // A bad value must fall back, not become port 0.
        let var = "LANIUS_TEST_PORT_BAD";
        for bad in ["", "0", "abc", "70000", "-1"] {
            unsafe { std::env::set_var(var, bad) };
            assert_eq!(port_override(var, 8080), 8080, "input {bad:?}");
        }
        unsafe { std::env::remove_var(var) };
    }
}
