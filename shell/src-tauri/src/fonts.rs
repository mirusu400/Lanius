//! Installed font families, for the font pickers in Appearance.
//!
//! A webview has no portable way to list local fonts: `queryLocalFonts`
//! exists only in Chromium, and neither WKWebView nor WebKitGTK offer it.
//! Reading the system font directories here gives every platform the
//! same list. Only names leave this module; nothing is loaded into the
//! webview and nothing touches the network.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct FontFamily {
    family: String,
    /// True when every face of the family is fixed-width, so the editor
    /// picker can offer those first.
    monospaced: bool,
}

/// Scanning parses the header of every installed font, which takes a
/// noticeable moment on a machine with many of them. Fonts installed
/// while Lanius is running appear after a restart.
static FAMILIES: OnceLock<Vec<FontFamily>> = OnceLock::new();

fn scan() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families: BTreeMap<String, (String, bool)> = BTreeMap::new();
    for face in db.faces() {
        // The first name is the English one when the font has one, which
        // is the name CSS matches most reliably.
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        let name = name.trim();
        // Names starting with a dot are private system faces on macOS.
        if name.is_empty() || name.starts_with('.') {
            continue;
        }
        let entry = families
            .entry(name.to_lowercase())
            .or_insert_with(|| (name.to_string(), true));
        entry.1 &= face.monospaced;
    }
    families
        .into_values()
        .map(|(family, monospaced)| FontFamily { family, monospaced })
        .collect()
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<FontFamily>, String> {
    tauri::async_runtime::spawn_blocking(|| FAMILIES.get_or_init(scan).clone())
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_unique_public_families() {
        let families = scan();
        let mut seen = std::collections::HashSet::new();
        for font in &families {
            assert!(!font.family.starts_with('.'));
            assert!(seen.insert(font.family.to_lowercase()));
        }
    }
}
