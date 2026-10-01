//! Project directories. Each engine run gets exactly one data directory.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub temporary: bool,
    pub db_path: PathBuf,
    pub last_opened: u64,
}

#[derive(Deserialize, Serialize)]
struct Meta {
    name: String,
    created_at: u64,
    last_opened: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).map_err(|e| e.to_string())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<(), String> {
    // Windows files inherit the current user's profile ACL. Avoid replacing
    // it with a hand-built DACL that could accidentally remove SYSTEM access.
    Ok(())
}

pub(crate) fn ensure_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    set_mode(path, 0o700)
}

fn create_private_dir(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    let mut builder = fs::DirBuilder::new();
    #[cfg(not(unix))]
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(data).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn protect_database(path: &Path) -> Result<(), String> {
    let with_suffix = |suffix: &str| {
        let mut value = path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    };
    for candidate in [path.to_path_buf(), with_suffix("-wal"), with_suffix("-shm")] {
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_file() => set_mode(&candidate, 0o600)?,
            Ok(_) => return Err(format!("unsafe project file: {}", candidate.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn home() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("LANIUS_DATA_DIR") {
        return Ok(PathBuf::from(dir));
    }
    #[cfg(windows)]
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"));
    #[cfg(not(windows))]
    let home = std::env::var_os("HOME");
    home.map(|home| PathBuf::from(home).join(".lanius"))
        .ok_or_else(|| "home directory is unavailable".to_string())
}

fn project_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        return Err("invalid project id".to_string());
    }
    Ok(root.join("projects").join(id))
}

fn read_project(root: &Path, id: &str) -> Result<Project, String> {
    if id == "legacy" {
        let db = root.join("lanius.sqlite");
        if !db.is_file() {
            return Err("previous project was not found".to_string());
        }
        protect_database(&db)?;
        return Ok(Project {
            id: id.to_string(),
            name: "Previous work".to_string(),
            temporary: false,
            db_path: db,
            last_opened: 0,
        });
    }
    let dir = project_dir(root, id)?;
    let directory = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
    if !directory.file_type().is_dir() {
        return Err("unsafe project directory".to_string());
    }
    set_mode(&dir, 0o700)?;
    let metadata_path = dir.join("project.json");
    let metadata = fs::symlink_metadata(&metadata_path).map_err(|e| e.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("unsafe project metadata".to_string());
    }
    set_mode(&metadata_path, 0o600)?;
    protect_database(&dir.join("lanius.sqlite"))?;
    let contents = fs::read(metadata_path).map_err(|e| e.to_string())?;
    let meta: Meta = serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
    Ok(Project {
        id: id.to_string(),
        name: meta.name,
        temporary: false,
        db_path: dir.join("lanius.sqlite"),
        last_opened: meta.last_opened,
    })
}

pub fn list(root: &Path) -> Result<Vec<Project>, String> {
    ensure_private_dir(root)?;
    let mut items = Vec::new();
    if root.join("lanius.sqlite").is_file() {
        items.push(read_project(root, "legacy")?);
    }
    let dir = root.join("projects");
    if dir.is_dir() {
        ensure_private_dir(&dir)?;
        for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if let Ok(project) = read_project(root, &id) {
                items.push(project);
            }
        }
    }
    items.sort_by(|a, b| {
        b.last_opened
            .cmp(&a.last_opened)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(items)
}

pub fn create(root: &Path, name: &str) -> Result<Project, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("project name must be 1–80 printable characters".to_string());
    }
    if list(root)?
        .iter()
        .any(|p| p.name.eq_ignore_ascii_case(name))
    {
        return Err("a project with that name already exists".to_string());
    }
    let base = root.join("projects");
    ensure_private_dir(root)?;
    ensure_private_dir(&base)?;
    for attempt in 0..10 {
        let id = format!("{:x}-{:x}-{:x}", now(), std::process::id(), attempt);
        let dir = base.join(&id);
        if create_private_dir(&dir).is_ok() {
            let meta = Meta {
                name: name.to_string(),
                created_at: now(),
                last_opened: now(),
            };
            write_private(
                &dir.join("project.json"),
                &serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
            )?;
            return read_project(root, &id);
        }
    }
    Err("could not allocate a project directory".to_string())
}

pub fn open(root: &Path, id: &str) -> Result<Project, String> {
    let mut project = read_project(root, id)?;
    if id != "legacy" {
        let path = project_dir(root, id)?.join("project.json");
        let mut meta: Meta = serde_json::from_slice(&fs::read(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        meta.last_opened = now();
        write_private(
            &path,
            &serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
        )?;
        project.last_opened = meta.last_opened;
    }
    Ok(project)
}

pub fn temporary() -> Result<Project, String> {
    for attempt in 0..10 {
        let dir = std::env::temp_dir().join(format!(
            "lanius-temp-{}-{}-{attempt}",
            std::process::id(),
            now()
        ));
        if create_private_dir(&dir).is_ok() {
            return Ok(Project {
                id: "temp".to_string(),
                name: "Temporary project".to_string(),
                temporary: true,
                db_path: dir.join("lanius.sqlite"),
                last_opened: now(),
            });
        }
    }
    Err("could not create a temporary project".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_are_isolated_and_legacy_is_preserved() {
        let root = std::env::temp_dir().join(format!("lanius-project-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("lanius.sqlite"), b"old data").unwrap();
        let first = create(&root, "Alpha").unwrap();
        let second = create(&root, "Beta").unwrap();
        assert_ne!(first.db_path, second.db_path);
        assert_eq!(list(&root).unwrap().len(), 3);
        assert_eq!(open(&root, &first.id).unwrap().name, "Alpha");
        assert_eq!(fs::read(root.join("lanius.sqlite")).unwrap(), b"old data");
        assert!(open(&root, "../outside").is_err());
        assert!(open(&root, "deadbeef").is_err());
        assert!(!root.join("projects/deadbeef").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&root), 0o700);
            assert_eq!(mode(&root.join("projects")), 0o700);
            assert_eq!(mode(first.db_path.parent().unwrap()), 0o700);
            assert_eq!(
                mode(&first.db_path.parent().unwrap().join("project.json")),
                0o600
            );
            assert_eq!(mode(&root.join("lanius.sqlite")), 0o600);
        }
        fs::remove_dir_all(root).unwrap();
    }
}
