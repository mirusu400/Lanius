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
    /// Data lives in a folder the user chose, outside the Lanius data folder.
    pub external: bool,
}

#[derive(Deserialize, Serialize)]
struct Meta {
    name: String,
    created_at: u64,
    last_opened: u64,
    /// Data directory chosen at creation; None keeps it beside this file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    location: Option<PathBuf>,
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

pub(crate) fn read_project(root: &Path, id: &str) -> Result<Project, String> {
    read_entry(root, id, true)
}

fn read_entry(root: &Path, id: &str, require_present: bool) -> Result<Project, String> {
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
            external: false,
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
    let contents = fs::read(metadata_path).map_err(|e| e.to_string())?;
    let meta: Meta = serde_json::from_slice(&contents).map_err(|e| e.to_string())?;
    let external = meta.location.is_some();
    let data_dir = match meta.location {
        Some(location) => {
            // An external folder can be on a drive that is not mounted now.
            // Keep the project listed, but never let the engine recreate it
            // empty: opening needs the folder to be there.
            match fs::symlink_metadata(&location) {
                Ok(found) if found.file_type().is_dir() => set_mode(&location, 0o700)?,
                Ok(_) => return Err("unsafe project directory".to_string()),
                Err(_) if !require_present => {}
                Err(_) => {
                    return Err(format!(
                        "project folder was not found: {}",
                        location.display()
                    ))
                }
            }
            location
        }
        None => dir,
    };
    let db_path = data_dir.join("lanius.sqlite");
    if data_dir.is_dir() {
        protect_database(&db_path)?;
    }
    Ok(Project {
        id: id.to_string(),
        name: meta.name,
        temporary: false,
        db_path,
        last_opened: meta.last_opened,
        external,
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
            if let Ok(project) = read_entry(root, &id, false) {
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

/// A trimmed project name that no other project uses.
fn valid_name<'a>(root: &Path, name: &'a str, except: Option<&str>) -> Result<&'a str, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("project name must be 1–80 printable characters".to_string());
    }
    if list(root)?
        .iter()
        .any(|p| Some(p.id.as_str()) != except && p.name.eq_ignore_ascii_case(name))
    {
        return Err("a project with that name already exists".to_string());
    }
    Ok(name)
}

fn read_meta(path: &Path) -> Result<Meta, String> {
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

/// Rename a project. Only the listed name changes; a chosen folder keeps
/// the name it was created with.
pub fn rename(root: &Path, id: &str, name: &str) -> Result<Project, String> {
    if id == "legacy" {
        return Err("the previous project cannot be renamed".to_string());
    }
    let name = valid_name(root, name, Some(id))?;
    let path = project_dir(root, id)?.join("project.json");
    // Validates the directory and metadata before anything is written.
    read_entry(root, id, false)?;
    let mut meta = read_meta(&path)?;
    meta.name = name.to_string();
    write_private(
        &path,
        &serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
    )?;
    read_entry(root, id, false)
}

/// Remove a project from the list. Its data is deleted when it lives in the
/// Lanius data folder; a folder the user chose is left exactly as it is.
pub fn delete(root: &Path, id: &str) -> Result<(), String> {
    if id == "legacy" {
        return Err("the previous project cannot be deleted here".to_string());
    }
    let dir = project_dir(root, id)?;
    read_entry(root, id, false)?;
    fs::remove_dir_all(&dir).map_err(|e| format!("could not delete the project: {e}"))
}

/// Folder name for a project created in a user-chosen location. Characters
/// that Windows refuses in file names are replaced so the same name works on
/// every platform.
fn folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_end_matches(['.', ' ']).trim();
    if cleaned.is_empty() || cleaned.chars().all(|c| c == '.' || c == '_') {
        "Lanius project".to_string()
    } else {
        cleaned.to_string()
    }
}

/// Create a project. With `parent`, its data lives in a new folder named
/// after the project inside that directory; the registry entry under `root`
/// only points there.
pub fn create(root: &Path, name: &str, parent: Option<&Path>) -> Result<Project, String> {
    let name = valid_name(root, name, None)?;
    let location = match parent {
        Some(parent) => {
            if !parent.is_absolute() {
                return Err("project location must be an absolute path".to_string());
            }
            let parent = fs::canonicalize(parent)
                .map_err(|e| format!("project location is unavailable: {e}"))?;
            if !parent.is_dir() {
                return Err("project location must be a folder".to_string());
            }
            let location = parent.join(folder_name(name));
            create_private_dir(&location).map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    format!("a folder already exists at {}", location.display())
                } else {
                    format!("could not create {}: {e}", location.display())
                }
            })?;
            Some(location)
        }
        None => None,
    };
    let result = register(root, name, location.clone());
    if result.is_err() {
        if let Some(location) = &location {
            let _ = fs::remove_dir(location);
        }
    }
    result
}

fn register(root: &Path, name: &str, location: Option<PathBuf>) -> Result<Project, String> {
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
                location,
            };
            let written = serde_json::to_vec_pretty(&meta)
                .map_err(|e| e.to_string())
                .and_then(|data| write_private(&dir.join("project.json"), &data));
            if let Err(err) = written {
                let _ = fs::remove_dir_all(&dir);
                return Err(err);
            }
            return read_project(root, &id);
        }
    }
    Err("could not allocate a project directory".to_string())
}

pub fn open(root: &Path, id: &str) -> Result<Project, String> {
    let mut project = read_project(root, id)?;
    if id != "legacy" {
        let path = project_dir(root, id)?.join("project.json");
        let mut meta = read_meta(&path)?;
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
                external: false,
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
        let first = create(&root, "Alpha", None).unwrap();
        let second = create(&root, "Beta", None).unwrap();
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

    #[test]
    fn projects_can_live_in_a_chosen_folder() {
        let root =
            std::env::temp_dir().join(format!("lanius-location-test-{}", std::process::id()));
        let outside = root.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        let home = root.join("home");
        let project = create(&home, "Client: A/B", Some(&outside)).unwrap();
        let expected = fs::canonicalize(&outside).unwrap().join("Client_ A_B");
        assert_eq!(project.db_path, expected.join("lanius.sqlite"));
        assert!(expected.is_dir());
        assert_eq!(open(&home, &project.id).unwrap().db_path, project.db_path);

        // The folder is never reused, so another project cannot share it.
        assert!(create(&home, "client: a/b ", Some(&outside)).is_err());
        assert!(create(&home, "Other", Some(Path::new("relative"))).is_err());
        assert!(create(&home, "Other", Some(&root.join("missing"))).is_err());
        assert_eq!(list(&home).unwrap().len(), 1);

        // A folder on an unmounted drive stays listed but does not open.
        fs::remove_dir_all(&expected).unwrap();
        assert_eq!(list(&home).unwrap().len(), 1);
        assert!(open(&home, &project.id).is_err());
        assert!(!expected.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projects_can_be_renamed_and_deleted() {
        let root = std::env::temp_dir().join(format!("lanius-manage-test-{}", std::process::id()));
        let home = root.join("home");
        let outside = root.join("elsewhere");
        fs::create_dir_all(&outside).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(home.join("lanius.sqlite"), b"old data").unwrap();
        let alpha = create(&home, "Alpha", None).unwrap();
        let beta = create(&home, "Beta", Some(&outside)).unwrap();
        assert!(!alpha.external);
        assert!(beta.external);

        assert_eq!(rename(&home, &alpha.id, " Gamma ").unwrap().name, "Gamma");
        // Changing only the case of its own name is not a clash.
        assert_eq!(rename(&home, &alpha.id, "GAMMA").unwrap().name, "GAMMA");
        assert!(rename(&home, &alpha.id, "beta").is_err());
        assert!(rename(&home, &alpha.id, "").is_err());
        assert!(rename(&home, "legacy", "Other").is_err());
        assert!(rename(&home, "../outside", "Other").is_err());

        // A chosen folder survives; only the registry entry goes.
        let beta_data = beta.db_path.parent().unwrap().to_path_buf();
        delete(&home, &beta.id).unwrap();
        assert!(beta_data.is_dir());
        delete(&home, &alpha.id).unwrap();
        assert!(!alpha.db_path.parent().unwrap().exists());
        assert!(delete(&home, "legacy").is_err());
        assert!(delete(&home, "deadbeef").is_err());
        assert_eq!(fs::read(home.join("lanius.sqlite")).unwrap(), b"old data");
        assert_eq!(list(&home).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn folder_names_are_portable() {
        assert_eq!(folder_name("a<b>c"), "a_b_c");
        assert_eq!(folder_name("name. "), "name");
        assert_eq!(folder_name(".."), "Lanius project");
        assert_eq!(folder_name("??"), "Lanius project");
    }
}
