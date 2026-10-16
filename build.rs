fn main() {
    let mut attributes = tauri_build::Attributes::new();
    // A captura via Npcap precisa de administrador. Só no build de release, para
    // `cargo run` continuar funcionando num terminal comum.
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        attributes = attributes.windows_attributes(
            tauri_build::WindowsAttributes::new().app_manifest(include_str!("admin.manifest")),
        );
    }
    tauri_build::try_build(attributes).expect("falha no tauri-build");
}
