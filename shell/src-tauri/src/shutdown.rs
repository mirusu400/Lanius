//! Coordinate native close requests with the webview's final workspace save.

pub const QUIT_MENU_ID: &str = "lanius-quit";

pub fn menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    let quit_text = PredefinedMenuItem::quit(app, None)?.text()?;
    // The default macOS Quit item calls NSApplication.terminate directly,
    // bypassing the runtime's cancellable ExitRequested event. Replace that
    // item in the default menu while retaining native editing/window items.
    for item in menu.items()? {
        if let MenuItemKind::Submenu(submenu) = item {
            for (index, child) in submenu.items()?.into_iter().enumerate() {
                if let MenuItemKind::Predefined(predefined) = child {
                    if predefined.text()? == quit_text {
                        let quit = MenuItem::with_id(
                            app,
                            QUIT_MENU_ID,
                            &quit_text,
                            true,
                            Some("CmdOrCtrl+Q"),
                        )?;
                        submenu.remove_at(index)?;
                        submenu.insert(&quit, index)?;
                    }
                }
            }
        }
    }
    Ok(menu)
}

#[derive(Default)]
pub struct Shutdown {
    ui_ready: bool,
    requested: bool,
    finishing: bool,
    pub approved: bool,
}

impl Shutdown {
    /// A request made during startup is delivered when the UI registers.
    pub fn request(&mut self) -> bool {
        if self.requested {
            return false;
        }
        self.requested = true;
        self.ui_ready
    }

    pub fn ready(&mut self) -> bool {
        self.ui_ready = true;
        self.requested && !self.finishing
    }

    pub fn cancel(&mut self) -> Result<(), String> {
        if self.finishing {
            return Err("the engine is already shutting down".to_string());
        }
        self.requested = false;
        Ok(())
    }

    pub fn begin_finish(&mut self) -> Result<(), String> {
        if !self.requested || self.finishing {
            return Err("no pending close request".to_string());
        }
        self.finishing = true;
        Ok(())
    }

    pub fn finish_failed(&mut self) {
        self.finishing = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_during_startup_waits_for_the_ui() {
        let mut shutdown = Shutdown::default();
        assert!(!shutdown.request());
        assert!(!shutdown.approved);
        assert!(shutdown.ready());
        assert!(!shutdown.request());
    }

    #[test]
    fn repeated_requests_do_not_start_multiple_saves() {
        let mut shutdown = Shutdown::default();
        assert!(!shutdown.ready());
        assert!(shutdown.request());
        assert!(!shutdown.request());
        shutdown.cancel().unwrap();
        assert!(shutdown.request());
    }

    #[test]
    fn cleanup_only_starts_once_after_a_close_request() {
        let mut shutdown = Shutdown::default();
        assert!(shutdown.begin_finish().is_err());
        shutdown.request();
        shutdown.begin_finish().unwrap();
        assert!(shutdown.begin_finish().is_err());
        assert!(shutdown.cancel().is_err());
        assert!(!shutdown.ready());
        assert!(!shutdown.approved);
        shutdown.finish_failed();
        shutdown.begin_finish().unwrap();
    }
}
