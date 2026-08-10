use std::{
    env, fs,
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).expect("create embedded asset directory");
    for entry in WalkDir::new(source)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        let relative = entry
            .path()
            .strip_prefix(source)
            .expect("asset relative path");
        let target = destination.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).expect("create asset parent");
        }
        fs::copy(entry.path(), target).expect("copy embedded asset");
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=HERDR_MISE_DIST_DIR");
    println!("cargo:rerun-if-changed=static");
    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let configured = env::var_os("HERDR_MISE_DIST_DIR").map(PathBuf::from);
    let client_dist = manifest.join("../client/dist");
    println!("cargo:rerun-if-changed={}", client_dist.display());
    let source = configured.as_deref().unwrap_or(&client_dist);
    let fallback = manifest.join("static");
    let (source, asset_mode): (&Path, &str) = if source.join("index.html").is_file() {
        (source, "production")
    } else {
        (&fallback, "fallback")
    };
    if !source.join("index.html").is_file() {
        panic!("embedded assets require index.html");
    }
    if configured.is_some() {
        println!("cargo:rerun-if-changed={}", source.display());
    }
    // Compile-time test contract only: production code must not branch on this mode.
    println!("cargo:rustc-env=HERDR_MISE_ASSET_MODE={asset_mode}");
    let destination = PathBuf::from(env::var_os("OUT_DIR").expect("out dir")).join("embedded-dist");
    if destination.exists() {
        fs::remove_dir_all(&destination).expect("clear embedded assets");
    }
    copy_tree(source, &destination);
}
