//! Save the bundled cookie transfer extension through the native Save As dialog.
//!
//! The webview cannot start a download from a blob link, so the desktop app
//! streams the archive from the local engine into the chosen file instead.

use tauri_plugin_dialog::DialogExt;

/// The endpoint is fixed: this command can only save the bundled extension.
const ENDPOINT: &str = "/api/browser/cookies/extension";
const FILE_NAME: &str = "lanius-cookie-transfer.zip";

#[tauri::command]
pub async fn save_cookie_exporter(
    window: tauri::WebviewWindow,
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
            .set_file_name(FILE_NAME)
            .add_filter("ZIP archive", &["zip"])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        crate::project_export::save_engine_file(
            &path,
            port,
            &token,
            ENDPOINT,
            "Cookie extension download",
        )?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}
