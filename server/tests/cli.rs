use std::{
    io::{BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::net::UnixListener,
    process::{Command, Output},
};

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_herdr-mise"))
}

fn stdout(output: &Output) -> String {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout.clone()).unwrap()
}

#[test]
fn help_and_version_are_side_effect_free() {
    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("must-not-connect.sock");
    let socket = UnixListener::bind(&socket_path).unwrap();
    let port = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port_number = port.local_addr().unwrap().port().to_string();

    for (argument, expected) in [
        ("--help", "Usage: herdr-mise [OPTION]".to_string()),
        (
            "--version",
            format!("herdr-mise {}\n", env!("CARGO_PKG_VERSION")),
        ),
    ] {
        let mut command = binary();
        let output = command
            .arg(argument)
            .env("HERDR_SOCKET_PATH", &socket_path)
            .env(
                "HERDR_MISE_PORT",
                if argument == "--help" {
                    "invalid"
                } else {
                    &port_number
                },
            )
            .env("HERDR_MISE_EXTRA_ORIGINS", "not-an-origin")
            .output()
            .unwrap();
        let output = stdout(&output);
        if argument == "--help" {
            assert!(output.starts_with(&expected));
            assert!(output.contains("--diagnostic"));
        } else {
            assert_eq!(output, expected);
        }
    }

    socket.set_nonblocking(true).unwrap();
    assert_eq!(
        socket.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    drop(port);
}

#[test]
fn diagnostic_uses_real_socket_transport_and_redacts_its_path() {
    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("private-herdr.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut stream = BufReader::new(stream);
        let mut request = String::new();
        stream.read_line(&mut request).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&request).unwrap()["method"],
            "session.snapshot"
        );
        stream
            .get_mut()
            .write_all(include_bytes!("fixtures/snapshot-working.json"))
            .unwrap();
        stream.get_mut().write_all(b"\n").unwrap();
    });

    let output = stdout(
        &binary()
            .arg("--diagnostic")
            .env("HERDR_SOCKET_PATH", &socket_path)
            .env("HERDR_MISE_PORT", "9123")
            .output()
            .unwrap(),
    );
    server.join().unwrap();

    assert_eq!(
        output,
        format!(
            "version={}\nsupported_protocols=17,19,20\nsource_status=connected\nhttp_address=http://127.0.0.1:9123\n",
            env!("CARGO_PKG_VERSION")
        )
    );
    assert!(!output.contains(socket_path.to_string_lossy().as_ref()));
    assert!(!output.contains("t-1"));
}

#[test]
fn diagnostic_reports_unavailable_source_but_rejects_invalid_port() {
    let directory = tempfile::tempdir().unwrap();
    let socket_path = directory.path().join("missing-private.sock");
    let output = binary()
        .arg("--diagnostic")
        .env("HERDR_SOCKET_PATH", &socket_path)
        .env("HERDR_MISE_PORT", "9456")
        .output()
        .unwrap();
    let output = stdout(&output);
    assert!(output.contains("source_status=unavailableSocket\n"));
    assert!(output.contains("http_address=http://127.0.0.1:9456\n"));
    assert!(!output.contains(socket_path.to_string_lossy().as_ref()));

    let invalid = binary()
        .arg("--diagnostic")
        .env("HERDR_SOCKET_PATH", &socket_path)
        .env("HERDR_MISE_PORT", "80")
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("HERDR_MISE_PORT"));
    assert!(invalid.stdout.is_empty());
}
