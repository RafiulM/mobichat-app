fn main() {
    #[cfg(not(feature = "cli"))]
    tauri_build::build();

    // On macOS, embed the Info.plist into the binary's __TEXT,__info_plist section.
    // This allows macOS TCC (privacy framework) to find NSMicrophoneUsageDescription
    // even when the binary is run directly (e.g. cargo tauri dev) without a .app bundle.
    #[cfg(target_os = "macos")]
    {
        let plist_path = std::path::Path::new("Info.plist")
            .canonicalize()
            .expect("Info.plist not found in src-tauri/");
        println!(
            "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
            plist_path.display()
        );
    }
}
