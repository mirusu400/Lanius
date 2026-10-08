//! Save a project to the path chosen in a native Save As dialog.

use std::io::{Read, Write};
use std::path::Path;
use std::time::Duration;

use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExportKind {
    Json,
    Database,
}

impl ExportKind {
    fn endpoint(self, include_flows: bool) -> String {
        match self {
            Self::Json => format!("/api/project/export?include_flows={include_flows}"),
            Self::Database => "/api/project/backup".to_string(),
        }
    }

    fn filter(self) -> (&'static str, &'static [&'static str]) {
        match self {
            Self::Json => ("Lanius project", &["json"]),
            Self::Database => ("SQLite database", &["sqlite"]),
        }
    }
}

#[tauri::command]
pub async fn save_project_file(
    window: tauri::WebviewWindow,
    kind: ExportKind,
    include_flows: bool,
    default_name: String,
    title: String,
) -> Result<Option<String>, String> {
    let port = crate::api_port();
    let token = crate::api_token().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let (label, extensions) = kind.filter();
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_file_name(default_name)
            .add_filter(label, extensions)
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        save_to_path(&path, port, &token, kind, include_flows)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn save_to_path(
    path: &Path,
    port: u16,
    token: &str,
    kind: ExportKind,
    include_flows: bool,
) -> Result<(), String> {
    // This can connect only to the authenticated local engine. Never honor
    // system proxies or redirects: neither may turn an export into egress.
    // The updater enables reqwest's rustls-no-provider feature globally.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(format!(
            "http://{}:{port}{}",
            crate::API_HOST,
            kind.endpoint(include_flows)
        ))
        .bearer_auth(token)
        .send()
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let mut body = String::new();
        let _ = response.take(8192).read_to_string(&mut body);
        let detail = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value.get("detail")?.as_str().map(str::to_string));
        return Err(detail.unwrap_or_else(|| format!("Project export failed: {status}")));
    }

    // Stream large SQLite snapshots without passing all bytes through the UI.
    // Commit only a complete file, so failed exports preserve an older backup.
    let parent = path
        .parent()
        .ok_or("The selected path has no parent directory")?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|error| error.to_string())?;
    std::io::copy(&mut response, temporary.as_file_mut()).map_err(|error| error.to_string())?;
    temporary.flush().map_err(|error| error.to_string())?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    temporary.persist(path).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn server(reply: Vec<u8>) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let read = stream.read(&mut buffer).unwrap();
                assert!(read > 0);
                request.extend_from_slice(&buffer[..read]);
            }
            stream.write_all(&reply).unwrap();
            String::from_utf8(request).unwrap()
        });
        (port, handle)
    }

    #[test]
    fn saves_json_and_binary_database_to_the_chosen_path() {
        for (kind, body, endpoint) in [
            (
                ExportKind::Json,
                b"{\"format\":\"lanius-project\"}".to_vec(),
                "/api/project/export?include_flows=false",
            ),
            (
                ExportKind::Database,
                b"SQLite format 3\0\xff\x80".to_vec(),
                "/api/project/backup",
            ),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("selected-file");
            std::fs::write(&path, "old backup").unwrap();
            let mut reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            reply.extend_from_slice(&body);
            let (port, handle) = server(reply);
            save_to_path(&path, port, "test-capability", kind, false).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), body);
            let request = handle.join().unwrap();
            assert!(request.starts_with(&format!("GET {endpoint} HTTP/1.1")));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer test-capability\r\n"));
        }
    }

    #[test]
    fn server_refusal_preserves_existing_backup_and_explains_the_error() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        std::fs::write(&path, "keep this").unwrap();
        let body = "{\"detail\":\"Use a complete database backup\"}";
        let reply = format!("HTTP/1.1 413 Content Too Large\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let (port, handle) = server(reply.into_bytes());
        let error = save_to_path(&path, port, "test", ExportKind::Json, true).unwrap_err();
        assert_eq!(error, "Use a complete database backup");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "keep this");
        handle.join().unwrap();
    }

    #[test]
    fn incomplete_download_preserves_existing_backup_and_removes_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.sqlite");
        std::fs::write(&path, "keep this").unwrap();
        let (port, handle) = server(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nshort".to_vec(),
        );
        assert!(save_to_path(&path, port, "test", ExportKind::Database, true).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), "keep this");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        handle.join().unwrap();
    }

    #[test]
    fn redirect_never_connects_to_another_destination() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.sqlite");
        let destination = TcpListener::bind("127.0.0.1:0").unwrap();
        destination.set_nonblocking(true).unwrap();
        let reply = format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{}/other\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", destination.local_addr().unwrap().port());
        let (port, handle) = server(reply.into_bytes());
        assert!(save_to_path(&path, port, "test", ExportKind::Database, true).is_err());
        assert!(!path.exists());
        assert_eq!(
            destination.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        handle.join().unwrap();
    }
}
