use std::{fs, path::PathBuf};

use toml::Value;

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("server crate must live directly below the repository root")
        .to_path_buf()
}

fn read_toml(path: PathBuf) -> Value {
    let source = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("failed to read {}: {error}", path.display()));
    toml::from_str(&source)
        .unwrap_or_else(|error| panic!("failed to parse {}: {error}", path.display()))
}

fn string_array(value: &Value, path: &str) -> Vec<String> {
    value[path]
        .as_array()
        .unwrap_or_else(|| panic!("{path} must be an array"))
        .iter()
        .map(|item| {
            item.as_str()
                .unwrap_or_else(|| panic!("{path} must contain only strings"))
                .to_owned()
        })
        .collect()
}

#[test]
fn plugin_manifest_matches_the_cargo_binary_pane_and_action_contract() {
    let root = repository_root();
    let manifest = read_toml(root.join("herdr-plugin.toml"));
    let server_manifest = read_toml(root.join("server/Cargo.toml"));
    let installer =
        fs::read_to_string(root.join("install.sh")).expect("install.sh must be readable");

    let binary_name = server_manifest["bin"]
        .as_array()
        .and_then(|bins| bins.first())
        .and_then(|bin| bin["name"].as_str())
        .expect("server/Cargo.toml must define a named [[bin]]");

    let plugin_id = manifest["id"].as_str().expect("plugin id is required");
    let version = server_manifest["package"]["version"]
        .as_str()
        .expect("server/Cargo.toml package version is required");
    assert_eq!(plugin_id, "mise.kitchen");
    assert_eq!(manifest["name"].as_str(), Some("Mise"));
    assert_eq!(manifest["version"].as_str(), Some(version));
    assert_eq!(
        installer
            .lines()
            .find_map(|line| line.strip_prefix("HERDR_MISE_VERSION=")),
        Some(version)
    );
    assert_eq!(manifest["min_herdr_version"].as_str(), Some("0.7.0"));
    assert_eq!(
        manifest["description"].as_str(),
        Some("Your coding agents as line cooks — kitchen status in a pane")
    );
    assert_eq!(string_array(&manifest, "platforms"), ["linux", "macos"]);

    let builds = manifest["build"].as_array().expect("[[build]] is required");
    assert_eq!(builds.len(), 1, "exactly one [[build]] is required");
    assert_eq!(
        string_array(&builds[0], "command"),
        ["sh", "install.sh", "--plugin"]
    );
    assert_eq!(string_array(&builds[0], "platforms"), ["linux", "macos"]);

    let panes = manifest["panes"].as_array().expect("[[panes]] is required");
    assert_eq!(panes.len(), 1, "exactly one [[panes]] is required");
    let pane = &panes[0];
    let pane_id = pane["id"].as_str().expect("pane id is required");
    assert_eq!(pane_id, "kitchen");
    assert_eq!(pane["title"].as_str(), Some("Mise Kitchen"));
    assert_eq!(pane["placement"].as_str(), Some("split"));
    assert_eq!(
        string_array(pane, "command"),
        [
            format!("./target/herdr-plugin/herdr-mise/current/bin/{binary_name}"),
            "--tui".to_owned()
        ]
    );

    let actions = manifest["actions"]
        .as_array()
        .expect("[[actions]] is required");
    assert_eq!(actions.len(), 1, "exactly one [[actions]] is required");
    let action = &actions[0];
    assert_eq!(action["id"].as_str(), Some("open"));
    assert_eq!(action["title"].as_str(), Some("Open Mise Kitchen"));
    assert_eq!(string_array(action, "contexts"), ["workspace"]);

    let action_command = string_array(action, "command");
    assert_eq!(action_command.len(), 3);
    assert_eq!(action_command[..2], ["sh", "-c"]);
    let script = &action_command[2];
    let expected_script = format!(
        "$HERDR_BIN_PATH plugin pane open --plugin {plugin_id} --entrypoint {pane_id} \
         --placement split --direction right --focus"
    );
    assert_eq!(script, &expected_script);
    assert!(script.contains("$HERDR_BIN_PATH plugin pane open"));
    assert!(script.contains(&format!("--plugin {plugin_id}")));
    assert!(script.contains(&format!("--entrypoint {pane_id}")));
    assert!(script.contains("--placement split"));
    assert!(script.contains("--direction right"));
    assert!(script.contains("--focus"));
}
