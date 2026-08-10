use std::{env, path::PathBuf};

pub fn discover_socket() -> PathBuf {
    discover_socket_from(
        env::var_os("HERDR_SOCKET_PATH"),
        env::var_os("XDG_CONFIG_HOME"),
        env::var_os("HOME"),
    )
}

pub fn discover_socket_from(
    override_path: Option<std::ffi::OsString>,
    xdg: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> PathBuf {
    if let Some(path) = override_path.filter(|p| !p.is_empty()) {
        return PathBuf::from(path);
    }
    let base = xdg
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            home.filter(|p| !p.is_empty())
                .map(|p| PathBuf::from(p).join(".config"))
        })
        .unwrap_or_else(|| PathBuf::from(".config"));
    base.join("herdr/herdr.sock")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_precedence() {
        assert_eq!(
            discover_socket_from(
                Some("/override".into()),
                Some("/xdg".into()),
                Some("/home".into())
            ),
            PathBuf::from("/override")
        );
        assert_eq!(
            discover_socket_from(None, Some("/xdg".into()), Some("/home".into())),
            PathBuf::from("/xdg/herdr/herdr.sock")
        );
        assert_eq!(
            discover_socket_from(None, None, Some("/home".into())),
            PathBuf::from("/home/.config/herdr/herdr.sock")
        );
    }
}
