#!/usr/bin/env python3
import os
import sys
import shutil
import subprocess
from PIL import Image
import base64

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS_DIR = os.path.join(ROOT_DIR, "shell", "src-tauri", "icons")
UI_PUBLIC_DIR = os.path.join(ROOT_DIR, "ui", "public")
DOCS_ICONS_DIR = os.path.join(ROOT_DIR, "docs", "icons")

def apply_icon(source_png_path):
    if not os.path.exists(source_png_path):
        print(f"Error: Source icon not found at {source_png_path}")
        sys.exit(1)
        
    print(f"Applying app icon from: {source_png_path}")
    base_img = Image.open(source_png_path).convert("RGBA")
    
    # 1. Save 512x512 icon.png
    icon_512 = base_img.resize((512, 512), Image.Resampling.LANCZOS)
    icon_512.save(os.path.join(ICONS_DIR, "icon.png"), "PNG")
    print("  -> Updated shell/src-tauri/icons/icon.png (512x512)")
    
    # 2. Save all required Tauri PNG sizes
    sizes = {
        "32x32.png": (32, 32),
        "128x128.png": (128, 128),
        "128x128@2x.png": (256, 256),
        "Square30x30Logo.png": (30, 30),
        "Square44x44Logo.png": (44, 44),
        "Square71x71Logo.png": (71, 71),
        "Square89x89Logo.png": (89, 89),
        "Square107x107Logo.png": (107, 107),
        "Square142x142Logo.png": (142, 142),
        "Square150x150Logo.png": (150, 150),
        "Square284x284Logo.png": (284, 284),
        "Square310x310Logo.png": (310, 310),
        "StoreLogo.png": (50, 50),
    }
    for filename, dim in sizes.items():
        resized = base_img.resize(dim, Image.Resampling.LANCZOS)
        resized.save(os.path.join(ICONS_DIR, filename), "PNG")
    print("  -> Updated all standard Tauri PNG tiles")
    
    # 3. Generate icon.ico (Windows)
    ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    base_img.save(
        os.path.join(ICONS_DIR, "icon.ico"),
        format="ICO",
        sizes=ico_sizes
    )
    print("  -> Generated shell/src-tauri/icons/icon.ico")
    
    # 4. Generate icon.icns (macOS) via iconutil
    iconset_dir = os.path.join(ICONS_DIR, "app.iconset")
    if os.path.exists(iconset_dir):
        shutil.rmtree(iconset_dir)
    os.makedirs(iconset_dir, exist_ok=True)
    
    icns_specs = [
        ("icon_16x16.png", (16, 16)),
        ("icon_16x16@2x.png", (32, 32)),
        ("icon_32x32.png", (32, 32)),
        ("icon_32x32@2x.png", (64, 64)),
        ("icon_128x128.png", (128, 128)),
        ("icon_128x128@2x.png", (256, 256)),
        ("icon_256x256.png", (256, 256)),
        ("icon_256x256@2x.png", (512, 512)),
        ("icon_512x512.png", (512, 512)),
        ("icon_512x512@2x.png", (1024, 1024)),
    ]
    for name, dim in icns_specs:
        im_tile = base_img.resize(dim, Image.Resampling.LANCZOS)
        im_tile.save(os.path.join(iconset_dir, name), "PNG")
        
    icns_target = os.path.join(ICONS_DIR, "icon.icns")
    res = subprocess.run(["iconutil", "-c", "icns", iconset_dir, "-o", icns_target], capture_output=True, text=True)
    if res.returncode == 0:
        print("  -> Generated shell/src-tauri/icons/icon.icns (native macOS)")
    else:
        print(f"  -> iconutil warning: {res.stderr}")
    shutil.rmtree(iconset_dir)
    
    # 5. Update ui/public/favicon.svg
    buffered = open(os.path.join(ICONS_DIR, "128x128@2x.png"), "rb").read()
    b64_str = base64.b64encode(buffered).decode("utf-8")
    favicon_svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <image href="data:image/png;base64,{b64_str}" width="256" height="256" />
</svg>'''
    with open(os.path.join(UI_PUBLIC_DIR, "favicon.svg"), "w", encoding="utf-8") as f:
        f.write(favicon_svg)
    print("  -> Updated ui/public/favicon.svg")
    
    print("\n[Done] App icons successfully packaged and applied!")

if __name__ == "__main__":
    if len(sys.argv) > 1:
        target = sys.argv[1]
        if not os.path.isabs(target):
            target = os.path.join(DOCS_ICONS_DIR, target)
    else:
        # Default to 01 Classic Puffin Sky
        target = os.path.join(DOCS_ICONS_DIR, "pd_puffin_01_sky.png")
    apply_icon(target)
