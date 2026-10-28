//! Save a public CA certificate through the native Save As dialog.

use std::path::Path;

use serde::Deserialize;
use tauri_plugin_dialog::DialogExt;

/// The allowlist is deliberately closed: the mitmproxy CA private key has no
/// variant here and therefore cannot be requested through this command.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CertificateFormat {
    Pem,
    Cer,
    P12,
}

impl CertificateFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Pem => "pem",
            Self::Cer => "cer",
            Self::P12 => "p12",
        }
    }

    fn endpoint(self) -> String {
        format!("/api/ca/{}", self.extension())
    }
}

#[tauri::command]
pub async fn save_ca_certificate(
    window: tauri::WebviewWindow,
    format: CertificateFormat,
    title: String,
) -> Result<Option<String>, String> {
    let port = crate::api_port();
    let token = crate::api_token().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        let extension = format.extension();
        let selected = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title)
            .set_file_name(format!("mitmproxy-ca-cert.{extension}"))
            .add_filter("CA certificate", &[extension])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        save_to_path(&path, port, &token, format)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|error| error.to_string())?
}

fn save_to_path(
    path: &Path,
    port: u16,
    token: &str,
    format: CertificateFormat,
) -> Result<(), String> {
    crate::project_export::save_engine_file(
        path,
        port,
        token,
        &format.endpoint(),
        "CA certificate download",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn server(reply: Vec<u8>) -> (u16, std::thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(std::time::Duration::from_secs(3)))
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
    fn saves_each_public_certificate_format_from_the_authenticated_endpoint() {
        for (format, endpoint, body) in [
            (
                CertificateFormat::Pem,
                "/api/ca/pem",
                b"-----BEGIN CERTIFICATE-----".as_slice(),
            ),
            (CertificateFormat::Cer, "/api/ca/cer", &[0x30, 0x82, 0xff]),
            (CertificateFormat::P12, "/api/ca/p12", &[0x30, 0x82, 0x80]),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("chosen-certificate");
            let mut reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            reply.extend_from_slice(body);
            let (port, handle) = server(reply);

            save_to_path(&path, port, "test-capability", format).unwrap();

            assert_eq!(std::fs::read(path).unwrap(), body);
            let request = handle.join().unwrap();
            assert!(request.starts_with(&format!("GET {endpoint} HTTP/1.1")));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer test-capability\r\n"));
        }
    }

    #[test]
    fn command_format_cannot_name_the_private_key_or_an_arbitrary_path() {
        for (json, extension) in [
            (r#""pem""#, "pem"),
            (r#""cer""#, "cer"),
            (r#""p12""#, "p12"),
        ] {
            let format: CertificateFormat = serde_json::from_str(json).unwrap();
            assert_eq!(format.extension(), extension);
        }
        for value in ["mitmproxy-ca.pem", "../key", "key", "crt"] {
            assert!(serde_json::from_str::<CertificateFormat>(&format!(r#""{value}""#)).is_err());
        }
    }

    #[test]
    fn refusal_preserves_an_existing_certificate() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("ca.pem");
        std::fs::write(&path, "keep this").unwrap();
        let body = r#"{"detail":"CA not generated yet; start the proxy once"}"#;
        let reply = format!(
            "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (port, handle) = server(reply.into_bytes());

        let error =
            save_to_path(&path, port, "test-capability", CertificateFormat::Pem).unwrap_err();

        assert_eq!(error, "CA not generated yet; start the proxy once");
        assert_eq!(std::fs::read_to_string(path).unwrap(), "keep this");
        handle.join().unwrap();
    }
}
