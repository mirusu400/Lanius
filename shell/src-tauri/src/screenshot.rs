//! Snapshot the Lanius webview and put its image on the macOS clipboard.

#[tauri::command]
pub async fn capture_current_window(window: tauri::WebviewWindow) -> Result<(), String> {
    log::info!("window capture requested");
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2_app_kit::{NSImage, NSPasteboard, NSPasteboardTypeTIFF};
        use objc2_foundation::NSError;
        use objc2_web_kit::WKWebView;
        use std::sync::mpsc::sync_channel;
        use std::time::Duration;

        let (sender, receiver) = sync_channel(1);
        window
            .with_webview(move |webview| {
                // WKWebView and AppKit must be accessed on the UI thread.
                let native = unsafe { &*webview.inner().cast::<WKWebView>() };
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    log::info!("webview snapshot completed");
                    let result = (|| {
                        if !error.is_null() {
                            return Err(format!("webview snapshot failed: {}", unsafe { &*error }));
                        }
                        let image = unsafe { image.as_ref() }
                            .ok_or_else(|| "webview snapshot returned no image".to_string())?;
                        let data = image
                            .TIFFRepresentation()
                            .ok_or_else(|| "could not encode the screenshot".to_string())?;
                        let pasteboard = NSPasteboard::generalPasteboard();
                        pasteboard.clearContents();
                        if !pasteboard.setData_forType(Some(&data), unsafe { NSPasteboardTypeTIFF })
                        {
                            return Err(
                                "could not copy the screenshot to the clipboard".to_string()
                            );
                        }
                        Ok(())
                    })();
                    let _ = sender.send(result);
                });
                unsafe {
                    native.takeSnapshotWithConfiguration_completionHandler(None, &completion);
                }
            })
            .map_err(|err| err.to_string())?;

        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(Duration::from_secs(10)))
            .await
            .map_err(|err| err.to_string())?
            .map_err(|err| err.to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Err("window capture is currently available on macOS only".to_string())
    }
}
