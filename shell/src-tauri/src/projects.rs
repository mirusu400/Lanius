//! Project directories. Each engine run gets exactly one data directory.

use serde::{Deserialize, Serialize};
use std::fs;
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
        return Ok(Project {
            id: id.to_string(),
            name: "Previous work".to_string(),
            temporary: false,
            db_path: db,
            last_opened: 0,
        });
    }
    let dir = project_dir(root, id)?;
    let contents = fs::read(dir.join("project.json")).map_err(|e| e.to_string())?;
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
    let mut items = Vec::new();
    if root.join("lanius.sqlite").is_file() {
        items.push(read_project(root, "legacy")?);
    }
    let dir = root.join("projects");
    if dir.is_dir() {
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
    fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    for attempt in 0..10 {
        let id = format!("{:x}-{:x}-{:x}", now(), std::process::id(), attempt);
        let dir = base.join(&id);
        if fs::create_dir(&dir).is_ok() {
            let meta = Meta {
                name: name.to_string(),
                created_at: now(),
                last_opened: now(),
            };
            fs::write(
                dir.join("project.json"),
                serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
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
        fs::write(
            path,
            serde_json::to_vec_pretty(&meta).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
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
        if fs::create_dir(&dir).is_ok() {
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
        fs::remove_dir_all(root).unwrap();
    }
}
