//! WebKitGTK startup workaround for the VMware SVGA renderer.

use std::path::Path;

#[cfg(target_os = "linux")]
const DMABUF_DISABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

fn has_vmware_drm_device(root: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(root) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(number) = name.strip_prefix("card") else {
            return false;
        };
        if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
            return false;
        }
        std::fs::read_to_string(entry.path().join("device/vendor"))
            .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case("0x15ad"))
    })
}

fn needs_dmabuf_workaround(
    user_setting_present: bool,
    webkit_version: (u32, u32),
    vmware_drm_device: bool,
) -> bool {
    !user_setting_present && webkit_version == (2, 50) && vmware_drm_device
}

#[cfg(target_os = "linux")]
pub fn configure_before_webview() {
    if std::env::var_os(DMABUF_DISABLE).is_some() {
        return;
    }

    // The reported hang is in WebKitGTK 2.50 on VMware SVGA. Newer WebKit
    // releases handle this switch differently, so only apply it where the
    // workaround is confirmed. Read the loaded library's version rather than
    // the version used by the build runner.
    let version = unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
        )
    };
    if needs_dmabuf_workaround(
        false,
        version,
        has_vmware_drm_device(Path::new("/sys/class/drm")),
    ) {
        // This runs before Tauri starts GTK/WebKit or creates any threads.
        unsafe { std::env::set_var(DMABUF_DISABLE, "1") };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_vmware_on_webkit_250_is_changed() {
        assert!(needs_dmabuf_workaround(false, (2, 50), true));
        assert!(!needs_dmabuf_workaround(true, (2, 50), true));
        assert!(!needs_dmabuf_workaround(false, (2, 50), false));
        assert!(!needs_dmabuf_workaround(false, (2, 52), true));
    }

    #[test]
    fn reads_vmware_vendor_from_drm_cards_only() {
        let root = std::env::temp_dir().join(format!(
            "lanius-vmware-drm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("time")
                .as_nanos()
        ));
        let card = root.join("card1/device");
        let render = root.join("renderD128/device");
        std::fs::create_dir_all(&card).expect("create card");
        std::fs::create_dir_all(&render).expect("create render node");
        std::fs::write(render.join("vendor"), "0x15ad\n").expect("write render vendor");
        std::fs::write(card.join("vendor"), "0x8086\n").expect("write card vendor");
        assert!(!has_vmware_drm_device(&root));
        std::fs::write(card.join("vendor"), "0x15ad\n").expect("write vmware vendor");
        assert!(has_vmware_drm_device(&root));
        std::fs::remove_dir_all(root).expect("remove fixture");
    }
}
