# Release fixtures provenance

These fixtures are static, checked-in projections of the public GitHub Releases
API for `funsaized/herdr-mise` tag `v0.3.0`.

## Source

- Captured anonymously (no token) on 2026-09-30.
- `v0.3.0-public.json` projects `GET https://api.github.com/repos/funsaized/herdr-mise/releases/tags/v0.3.0`.
- `v0.3.0-latest.json` projects `GET https://api.github.com/repos/funsaized/herdr-mise/releases/latest`.

Both endpoints returned the same release (`id` 396655343, `tag_name`/`name`
`v0.3.0`), so the two files are byte-identical. Tests do not
fetch these URLs again; the fixtures are snapshots.

## Projection

The fixtures are a documented subset projection, not raw API responses. Only
facts observed in the anonymous capture are recorded; nothing is derived,
reconstructed, or invented.

Included per release: `id`, `tag_name`, `name`, `draft`, `prerelease`,
`published_at`, `updated_at`, `html_url`, `body`, `assets`.

Included per asset: `id`, `name`, `state`.

Omitted:

- `author` (release author) and `uploader` (asset uploader): identity fields
  not needed by the release verification logic.
- transport counters (`download_count`) and other volatile fields
  (`created_at`, `size`, `content_type`, `label`, `node_id`, API URL fields):
  they change over time and would make the fixtures non-reproducible.
- `browser_download_url`: observed but omitted because this checker consumes
  asset names, not download URLs. Existing public-download verification covers URLs.

The asset order follows the release pipeline's sorted upload order: each
target archive immediately followed by its `.sha256` sidecar. Asset ids are
recorded respectively in that order:

| id        | name                                                     |
| --------- | -------------------------------------------------------- |
| 588479531 | herdr-mise-v0.3.0-aarch64-apple-darwin.tar.gz            |
| 588479545 | herdr-mise-v0.3.0-aarch64-apple-darwin.tar.gz.sha256     |
| 588479556 | herdr-mise-v0.3.0-x86_64-apple-darwin.tar.gz             |
| 588479569 | herdr-mise-v0.3.0-x86_64-apple-darwin.tar.gz.sha256      |
| 588479578 | herdr-mise-v0.3.0-x86_64-unknown-linux-gnu.tar.gz        |
| 588479601 | herdr-mise-v0.3.0-x86_64-unknown-linux-gnu.tar.gz.sha256 |

## Body normalization

`body` is the checked-in `docs/releases/v0.3.0.md` at capture time, normalized
the same way the release pipeline normalizes release notes: line endings
normalized to `\n` with a single trailing newline. The pipeline then appends a
blank line, `## Checksums`, a blank line, and one `"<sha256>  <archive>\n"`
line per supported target in pipeline order. The fixture body reproduces that
construction exactly. The body still contains the pre-publication sentences
(`Once the stable release is published`, `No stable archive or checksum is
claimed before publication.`) because those were present in the captured
notes; they are preserved, not corrected.
