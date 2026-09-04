# Herdr Mise installation and distribution plan

## Objective

Reduce installation friction by making Herdr's plugin installer the primary
path, adding a standalone installer for unsupported workflows, and publishing a
Homebrew tap.

End-state installation methods:

```sh
# Recommended for Herdr users
herdr plugin install funsaized/herdr-mise

# Standalone binary
curl -fsSL https://raw.githubusercontent.com/funsaized/herdr-mise/main/install.sh | sh

# Homebrew and Linuxbrew
brew install funsaized/tap/herdr-mise
```

All three methods must consume the existing prebuilt GitHub release artifacts.
End users must not need Node, npm, Cargo, or a Rust toolchain.

## Current state

Herdr Mise already has:

- A valid plugin manifest at `herdr-plugin.toml`.
- Plugin ID `mise.kitchen`.
- The GitHub topic `herdr-plugin`.
- Automatic eligibility for Herdr's community marketplace.
- Signed and notarized macOS release binaries.
- Release archives and SHA-256 sidecars for:
  - `aarch64-apple-darwin`
  - `x86_64-apple-darwin`
  - `x86_64-unknown-linux-gnu`
- Existing artifact verification in `scripts/verify-public-artifact.sh`.
- A release workflow in `.github/workflows/release.yml`.

The current plugin build command is:

```toml
[[build]]
command = ["cargo", "build", "--release"]
```

This creates two user-facing problems:

1. Plugin installation requires a Rust toolchain.
2. It does not build `client/dist`, so `server/build.rs` embeds the fallback
   page rather than the production browser client.

The current README avoids this by requiring users to install npm dependencies,
build the client and Rust binary, and then run `herdr plugin link .`. That is
appropriate for contributors, not users.

### Terminology

Herdr Mise can be described as:

> A community plugin installed through Herdr's official plugin system.

It must not be described as an "official Herdr project" or as endorsed by
Herdr. Herdr's marketplace is an automatic, unreviewed community index, and
`README.md:113-117` explicitly declares the project independent.

## Distribution decisions

1. **Primary:** `herdr plugin install funsaized/herdr-mise`
2. **Secondary:** standalone verified installer to `~/.local/bin`
3. **Package manager:** upstream-maintained Homebrew tap
4. **Fallback:** manual GitHub release archive
5. **Not planned:** npm, crates.io, apt, RPM, Snap, Flatpak, AUR, or Nix

The project ships a native Rust executable, so npm is not an appropriate
distribution registry. Publishing there would add a Node prerequisite and a
post-install binary downloader without improving the user experience.

Per-distribution Linux repositories are excluded because they would introduce
repository signing, metadata publication, distro compatibility, and multiple
package formats. Linuxbrew and the standalone installer cover the existing
Linux x86_64 artifact with substantially less maintenance.

## Phase 1: Toolchain-free Herdr plugin installation

### Goal

Make this work on a clean supported machine without Node or Rust:

```sh
herdr plugin install funsaized/herdr-mise
herdr plugin action invoke open --plugin mise.kitchen
```

Herdr may still require Git because its plugin installer clones GitHub
repositories.

### Implementation

#### 1. Add a release installer

Add a self-contained POSIX shell installer at `install.sh`.

It must:

1. Use `set -eu`.
2. Detect the platform using `uname -s` and `uname -m`.
3. Map only the supported combinations:

   | System | Architecture | Release target             |
   | ------ | ------------ | -------------------------- |
   | Darwin | arm64        | `aarch64-apple-darwin`     |
   | Darwin | x86_64       | `x86_64-apple-darwin`      |
   | Linux  | x86_64       | `x86_64-unknown-linux-gnu` |

4. Reject Windows, Linux ARM, musl-only systems, and unknown architectures with
   a clear error.
5. Use the exact stable version declared by the installer and plugin manifest.
6. Construct the existing release URLs:

   ```text
   https://github.com/funsaized/herdr-mise/releases/download/v<VERSION>/herdr-mise-v<VERSION>-<TARGET>.tar.gz
   https://github.com/funsaized/herdr-mise/releases/download/v<VERSION>/herdr-mise-v<VERSION>-<TARGET>.tar.gz.sha256
   ```

7. Download over HTTPS using `curl` with failure reporting, redirect following,
   retry behavior, and user curl configuration disabled.
8. Verify that the sidecar names the downloaded archive.
9. Verify that the recorded SHA-256 is exactly 64 lowercase hexadecimal
   characters.
10. Verify the archive using `sha256sum` on Linux or `shasum -a 256` on macOS.
11. Inspect the archive before extraction and require exactly:
    - `herdr-mise`
    - `LICENSE`
    - `THIRD_PARTY_NOTICES.txt`
12. Extract into a temporary directory before installation.
13. Verify that `herdr-mise` is executable.
14. Install atomically into a versioned directory.
15. Preserve the downloaded macOS binary rather than rebuilding it, retaining
    its Developer ID signature and notarization.
16. Clean temporary files on success, failure, or interruption.
17. Never use `sudo`.
18. Never execute downloaded shell code.
19. Never resolve an unpinned "latest" binary at runtime.

Use the security and archive-validation behavior already established in
`scripts/verify-public-artifact.sh`. Do not introduce a second, weaker download
path. Refactor or share the existing behavior only where doing so keeps
`install.sh` self-contained.

#### 2. Add plugin installation mode

Support:

```sh
sh install.sh --plugin
```

Plugin mode must install under the managed checkout, for example:

```text
target/herdr-plugin/herdr-mise/<version>/bin/herdr-mise
target/herdr-plugin/herdr-mise/current
```

It must not modify the user's `PATH` or files outside the managed plugin
checkout.

#### 3. Update the plugin manifest

Modify `herdr-plugin.toml`:

- Replace the Cargo build command with:

  ```toml
  [[build]]
  command = ["sh", "install.sh", "--plugin"]
  platforms = ["linux", "macos"]
  ```

- Point the pane command at the verified managed binary:

  ```toml
  command = ["./target/herdr-plugin/herdr-mise/current/bin/herdr-mise", "--tui"]
  ```

- Preserve:
  - Plugin ID `mise.kitchen`
  - Pane ID `kitchen`
  - Action ID `open`
  - Minimum Herdr version
  - Linux/macOS platform declarations
  - Existing split-pane behavior

Herdr shows build commands before executing them. The manifest must keep the
installer visible in that preview.

#### 4. Update the manifest contract test

Modify `server/tests/plugin_manifest_contract.rs`.

The test must verify:

- The build command invokes `install.sh --plugin`.
- The pane command points to the installed release binary.
- Plugin ID, pane ID, action ID, and platform declarations remain unchanged.
- `herdr-plugin.toml` version matches `server/Cargo.toml`.
- The installer's selected release version matches the plugin version.
- The action continues to call Herdr through `HERDR_BIN_PATH`.

Avoid continuing to hardcode version `0.1.0` independently in multiple
assertions when the value can be read from the Cargo and plugin manifests.

#### 5. Add installer tests

Add `scripts/install.test.mjs`.

The root `npm test` command already executes `scripts/*.test.mjs`; no new test
runner is required.

Cover:

- macOS arm64 target selection.
- macOS x86_64 target selection.
- Linux x86_64 target selection.
- Rejection of unsupported systems.
- Rejection of HTTP artifact URLs.
- Rejection of malformed checksums.
- Rejection when the sidecar names another file.
- Rejection of a checksum mismatch.
- Rejection of unexpected archive contents.
- Successful plugin-mode installation into an isolated directory.
- Atomic replacement of the `current` symlink.
- No writes outside the supplied test root.
- No invocation of Cargo, npm, or Node by the installer itself.

Use local fixture archives and fake commands or test-only URL allowances. Tests
must not depend on downloading the public release.

#### 6. Update documentation

Modify `README.md` so the primary quick start becomes:

```sh
brew install herdr
herdr plugin install funsaized/herdr-mise
herdr plugin action invoke open --plugin mise.kitchen
```

Retain the source build and `plugin link` instructions under contributor
development, not user installation.

Modify `docs/operations.md` to document:

- Plugin installation
- Plugin invocation
- Plugin logs
- Reinstallation as the Herdr v1 update mechanism
- Plugin uninstall
- Supported platforms
- Required commands: Herdr, Git, curl, tar, and a SHA-256 utility
- Failure behavior for unsupported platforms
- The manual archive path as a fallback

Preserve the independent-community-project disclaimer.

### Phase 1 verification

Run:

```sh
node --test scripts/install.test.mjs scripts/public-artifact.test.mjs
cargo test --locked --test plugin_manifest_contract
npm test
```

Run end-to-end installation on macOS arm64, macOS x86_64, and Linux x86_64
glibc. For each target:

1. Remove Node and Cargo from the test `PATH`.
2. Run `herdr plugin install funsaized/herdr-mise`.
3. Confirm installation succeeds.
4. Invoke the plugin action.
5. Confirm the TUI renders.
6. Confirm the browser service serves a hashed Vite JavaScript asset rather
   than the fallback page.
7. Confirm demo mode works without a Herdr socket.
8. Confirm live mode connects through `HERDR_SOCKET_PATH`.
9. On macOS, run `codesign --verify --deep --strict` against the installed
   binary.
10. Uninstall and confirm the managed checkout is removed.

### Phase 1 acceptance criteria

- A Herdr user installs Mise with one Herdr command.
- Installation requires no Node, npm, Cargo, or Rust.
- The production browser client is embedded.
- The native TUI opens through the declared plugin action.
- Archive verification occurs before extraction.
- Unsupported platforms fail clearly.
- macOS release signatures remain valid.
- Plugin reinstall replaces the managed checkout and updates the binary.
- The plugin remains accurately described as a community plugin.

## Phase 2: Standalone installer

### Goal

Provide the common open-source binary installation experience for users who
want to run the browser service or TUI outside Herdr's plugin manager:

```sh
curl -fsSL https://raw.githubusercontent.com/funsaized/herdr-mise/main/install.sh | sh
```

The manual download/checksum/extract path remains available for users who do
not want to pipe a script into a shell.

### Implementation

#### 1. Add default user installation mode

Running `install.sh` without `--plugin` must install into user-owned paths:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/herdr-mise/<version>/
${XDG_DATA_HOME:-$HOME/.local/share}/herdr-mise/current
${XDG_BIN_HOME:-$HOME/.local/bin}/herdr-mise
```

The executable in `~/.local/bin` should be an atomic symlink to the selected
version.

The installer must:

- Refuse to overwrite a non-symlink file at the launcher path.
- Keep the previous version available for rollback.
- Replace the `current` symlink atomically.
- Print the installed version and binary path.
- Warn when the selected bin directory is not present in `PATH`.
- Be idempotent when the exact same verified version is already installed.
- Never edit shell startup files automatically.

Allow install locations to be overridden through documented environment
variables for CI and advanced users.

#### 2. Document standalone update and uninstall

Document:

- Rerun `install.sh` to install the current stable version.
- How to select an older installed version by changing `current`.
- How to remove a specific inactive version.
- How to remove the launcher and all installed versions.
- Browser settings that may remain in local storage.
- That standalone mode does not register a Herdr plugin.

Do not add a background service, daemon, automatic updater, shell-profile
editor, or package database.

#### 3. Retain manual verification instructions

Keep the explicit archive workflow in `docs/operations.md`:

```sh
curl -O <archive> -O <archive.sha256>
shasum -a 256 -c <archive.sha256>
tar -xzf <archive>
./herdr-mise
```

This is the inspectable alternative to `curl | sh`.

#### 4. Update release documentation

Modify `docs/releasing.md` so each release verifies:

- `install.sh` references the intended version.
- The version exists in `server/Cargo.toml` and `herdr-plugin.toml`.
- All three corresponding release archives and sidecars will exist.
- The standalone installer is tested against the published release.
- The plugin installer and standalone installer resolve the same artifacts.

Document the brief release invariant: do not leave the installer or plugin
manifest pointing at an unpublished version.

### Phase 2 verification

Run:

```sh
node --test scripts/install.test.mjs scripts/public-artifact.test.mjs
npm run validate:release
```

On every supported target:

1. Run the installer with isolated XDG directories.
2. Confirm the binary appears in the selected bin directory.
3. Confirm the launcher resolves to the versioned installation.
4. Run the HTTP service in demo mode.
5. Verify the production browser assets.
6. Run the TUI.
7. Reinstall and verify idempotence.
8. Simulate a second version and verify atomic switching.
9. Verify uninstall refuses to remove the selected version accidentally.
10. Verify no `sudo`, Node, npm, or Cargo command is invoked.

### Phase 2 acceptance criteria

- Standalone installation is one command.
- Installation is user-local and requires no elevated privileges.
- The installed binary is identical to the corresponding GitHub release
  binary.
- Updates retain the previous version for rollback.
- PATH changes are suggested, never performed automatically.
- Manual verified installation remains documented.

## Phase 3: Homebrew and Linuxbrew

### Goal

Publish an upstream-maintained Homebrew tap supporting macOS arm64, macOS
x86_64, and Linux x86_64 through Linuxbrew.

The user-facing command will be:

```sh
brew install funsaized/tap/herdr-mise
```

There is currently no `funsaized/homebrew-tap` repository, so this phase
includes creating it.

### Tap repository

Create the public repository `funsaized/homebrew-tap` with this initial
structure:

```text
Formula/
  herdr-mise.rb
README.md
LICENSE
.github/
  workflows/
```

Use the conventional `homebrew-tap` repository name so Homebrew supports the
short `funsaized/tap` syntax.

### Formula design

Create `Formula/herdr-mise.rb`.

The formula must:

1. Be named `HerdrMise`.
2. Install the `herdr-mise` executable.
3. Use the existing GitHub release archives rather than rebuilding.
4. Declare the project homepage, MIT license, stable version,
   platform-specific URLs, and platform-specific SHA-256 values.
5. Support:
   - `aarch64-apple-darwin`
   - `x86_64-apple-darwin`
   - `x86_64-unknown-linux-gnu`
6. Fail clearly on Linux ARM rather than attempting to install the x86_64
   artifact.
7. Install `herdr-mise` into `bin`, plus `LICENSE` and
   `THIRD_PARTY_NOTICES.txt`.
8. Declare Homebrew Core's `herdr` formula as a dependency so a Homebrew
   installation is immediately usable in live mode.
9. Avoid bottles initially; the upstream release archives are already compiled
   artifacts.
10. Avoid a Homebrew service declaration; Herdr Mise is user-invoked and
    already binds only to loopback.
11. Avoid naming the formula `mise`, which conflicts with the established
    `mise` runtime manager.

Current `v0.1.0` archive hashes:

| Target                     | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `aarch64-apple-darwin`     | `5c8b56812dbd48ee5517871ad0c6ccff9512d8c37255d29dbb39f5889190985d` |
| `x86_64-apple-darwin`      | `b5f16da202d7a8dc9b5be948f964daa50686df5534800d81fb4b8ade551443bf` |
| `x86_64-unknown-linux-gnu` | `d4facb3c9cd727dda82e49be5afc542977e283e2a62634b9f57461368b5f9771` |

The formula must use hashes copied from the published release, not locally
rebuilt archives.

### Formula test

The Homebrew `test do` block must execute the installed binary, not merely check
that the file exists.

Because the binary currently has no `--version` or `--help` command, test the
real server:

1. Select a free loopback port.
2. Set `HERDR_MISE_PORT`, an unavailable `HERDR_SOCKET_PATH`, and isolated
   HOME/XDG paths.
3. Start `herdr-mise`.
4. Wait for the HTTP endpoint.
5. Fetch `/`.
6. Confirm the page references a production JavaScript asset.
7. Stop the process cleanly.
8. Ensure no process remains.

Do not add a product CLI flag solely to make the formula test easier.

### Tap CI

Configure the tap's generated or standard Homebrew workflows to run:

```sh
brew audit --strict --online funsaized/tap/herdr-mise
brew install --build-from-source funsaized/tap/herdr-mise
brew test funsaized/tap/herdr-mise
brew uninstall herdr-mise
```

Test at least:

- macOS arm64
- macOS x86_64 while runners remain available
- Linux x86_64

The formula downloads upstream release binaries, so "build from source" here
validates formula installation behavior rather than compiling Rust.

### Release process

For each Herdr Mise release:

1. Publish and verify the GitHub release using the existing release workflow.
2. Obtain SHA-256 values from the published artifacts.
3. Open a tap pull request updating the version, three URLs, and three SHA-256
   values.
4. Run tap CI.
5. Merge the tap update.
6. Verify a clean `brew update && brew upgrade herdr-mise`.
7. Update the main project's release checklist with the tap commit or pull
   request.

Start with manual tap updates. Do not add a cross-repository token or release
automation until at least two releases demonstrate that manual updates are a
recurring burden.

### Main repository documentation

Update `README.md` to show:

```sh
brew install funsaized/tap/herdr-mise
herdr-mise --tui
```

Also explain that users who want Herdr-managed pane registration should prefer:

```sh
herdr plugin install funsaized/herdr-mise
```

Update `docs/operations.md` with:

- Homebrew installation
- Upgrade using `brew upgrade`
- Uninstall using `brew uninstall`
- Homebrew-managed Herdr dependency
- Supported Homebrew/Linuxbrew architectures
- Difference between Homebrew installation and Herdr plugin registration

Update `docs/releasing.md` with the tap update checklist.

### Phase 3 verification

On each supported Homebrew target:

```sh
brew install funsaized/tap/herdr-mise
brew test funsaized/tap/herdr-mise
brew linkage --test herdr-mise
brew uninstall herdr-mise
```

Also verify:

1. `herdr` is installed as a dependency.
2. `herdr-mise` resolves from `PATH`.
3. The browser serves production assets.
4. The TUI starts.
5. Live mode discovers the Homebrew-installed Herdr socket.
6. macOS code-signature verification still passes.
7. `brew upgrade` replaces an older formula version.
8. Linuxbrew rejects unsupported ARM hosts clearly.

### Phase 3 acceptance criteria

- `brew install funsaized/tap/herdr-mise` installs a usable Herdr and Herdr Mise
  combination.
- No Rust or Node toolchain is installed to build Herdr Mise.
- The formula consumes the same binaries as plugin and standalone installation.
- Homebrew upgrades and uninstall work normally.
- macOS arm64, macOS x86_64, and Linux x86_64 are covered.
- No bottles, service definitions, or cross-repository publishing automation
  are introduced initially.

## Cross-phase invariants

The following must remain true throughout all phases:

1. `server/Cargo.toml` remains the product version authority.
2. `herdr-plugin.toml` and installer release selection match the shipped binary
   version.
3. All installation paths consume published release binaries.
4. No installation path silently compiles fallback browser assets.
5. Checksums are verified before extraction.
6. Archive contents are allow-listed before extraction.
7. macOS release signatures are preserved.
8. The server continues binding only to `127.0.0.1`.
9. Herdr Mise remains read-only against Herdr.
10. Installation never requires root privileges.
11. Unsupported systems fail rather than selecting a nearby target.
12. The release archive naming and six-asset release contract remain unchanged.
13. Source builds remain available for contributors.
14. The project remains described as an independent community plugin.

## Risks and mitigations

| Risk                                                                | Mitigation                                                                                                |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Plugin version points to an unpublished release                     | Make matching release availability a release invariant and test the public URLs after publication         |
| GitHub archive and sidecar share the same trust root                | Use HTTPS, exact version URLs, archive allow-listing, and preserved macOS code signatures                 |
| Minimal Linux systems lack curl or a SHA utility                    | Check dependencies before download and print exact installation requirements                              |
| Linux binary requires glibc                                         | Document x86_64 GNU support and reject unsupported platforms                                              |
| Plugin installation from a mutable default branch changes over time | Document Herdr's `--ref` option for users requiring a pinned source revision                              |
| `curl \| sh` concerns                                               | Keep manual download, inspection, checksum, and execution instructions adjacent to the one-line installer |
| Existing `mise` tool causes naming confusion                        | Use `herdr-mise` consistently for binary, formula, repository, and documentation                          |
| Homebrew tap becomes stale                                          | Add the tap update to every release checklist and verify with `brew upgrade`                              |
| Homebrew dependency duplicates a non-Brew Herdr install             | Document that plugin installation is preferred when Herdr is already managed elsewhere                    |
| Installer and acceptance verifier drift                             | Reuse existing validation behavior and cover both with the same fixture-based tests                       |
| Homebrew Intel runner availability ends                             | Keep the signed Intel release artifact and allow manual formula verification if hosted runners disappear  |

## Explicit non-goals

Do not add during this plan:

- npm publication
- crates.io publication
- apt repository
- RPM repository
- Snap
- Flatpak
- AppImage
- AUR package
- Nix flake or nixpkgs submission
- Windows support
- Linux ARM support
- Linux musl support
- Background service
- Automatic updater
- Shell profile modification
- Homebrew Core submission
- Homebrew bottles
- Cross-repository release credentials or automation

These can be reconsidered only when a supported target or actual user demand
requires them.

## Final acceptance

The plan is complete when all of the following work against the same stable
release:

```sh
herdr plugin install funsaized/herdr-mise
```

```sh
curl -fsSL https://raw.githubusercontent.com/funsaized/herdr-mise/main/install.sh | sh
```

```sh
brew install funsaized/tap/herdr-mise
```

For every supported platform, each path must install the production binary
without Node or Rust, verify its artifact before installation, preserve
platform trust properties, and successfully render both the TUI and production
browser client.
