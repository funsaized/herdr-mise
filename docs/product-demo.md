# Product demo: building and ship preparation

## Building (source only)

The authoritative editorial timeline is `scripts/product-demo-config.mjs`:
busy kitchen 0–10s, blocked attention 10–20s, real details/locator 20–32s,
local workspace scope 32–44s, browser/TUI comparison 44–56s, observed service
recap 56–66s, and installation 66–75s. These durations are editorial choices.
Workspace selection filters this renderer only; it never commands Herdr.
Fictional pane locators are demo data. DEMO SERVICE stays visible.

Build and test source without generating media:

```sh
npm ci
npm ci --prefix client
PLAYWRIGHT_BROWSERS_PATH=0 npx playwright install chromium
node --test scripts/product-demo-config.test.mjs
node --test scripts/readme-media-config.test.mjs
PLAYWRIGHT_BROWSERS_PATH=0 npm run test:visual -- product-demo.spec.ts --grep 'product capture actions inspect fixture locators and scope workspaces by stable ID$'
PLAYWRIGHT_BROWSERS_PATH=0 npm run test:visual -- product-demo.spec.ts --grep 'product storyboard renders captioned demo checkpoints without publishing media$'
```

The fixture test crosses the real Herdr snapshot → adapter → Feed → WebSocket
→ browser store → DOM/canvas boundary. Checkpoint screenshots are temporary.
Node tests generate temporary packages and stub media probes, not committed
product assets. The explicit produced-artifact validator is intentionally not
an automatically discovered test. The existing twelve-second README capture,
its names, provenance, and default `capture:web` behavior are unchanged.

## Ship preparation (driver only)

First commit the source change and ensure the checkout is clean. Capture refuses
tracked changes, untracked source, or an unavailable HEAD before creating any
output or starting capture dependencies. No override is provided. Chromium,
`ffmpeg`, and `ffprobe` must be available. Do not run another workflow/capture in
the same checkout concurrently.

```sh
PLAYWRIGHT_BROWSERS_PATH=0 npm run capture:product
node scripts/check-product-media.mjs
```

One staging session captures all four deliverables, then validates the complete
package before publishing. The main clip is 75 seconds; independently playable
loops are attention/inspection (22s), local scope/blocked elsewhere (12s), and
browser/TUI presentation (12s). Each has MP4, WebM, PNG poster, WebVTT captions,
and a timestamped text transcript. Only the loops have looping GIFs. Under
`docs/assets`, stems are:

- `herdr-mise-product-demo`
- `herdr-mise-feature-attention`
- `herdr-mise-feature-workspace`
- `herdr-mise-feature-presentation`

Posters use `-poster.png`; other suffixes are `.mp4`, `.webm`, `.vtt`, `.txt`,
and (loops only) `.gif`. Outputs are 960×540 at 20 fps, from a 1280×720 browser.
Poster timestamps within the clips are 21s, 11s, 2s, and 2s respectively.
`scripts/product-demo.capture.json` records the storyboard, package version from
`server/Cargo.toml`, captured source commit, hashes, and input provenance.

The TUI is **prerecorded demo footage**, not a new recording or synchronized live
browser/TUI state. Its GIF and original `scripts/tui-demo.capture.json` are reused;
their hashes and original provenance remain recorded. Installation is a closing
card showing README plugin quick-start commands, never executing them.

Review the entire main clip and all loop seams: readable captions, unclipped
DEMO placard, exact visible locator, blocked-elsewhere recovery, truthful
prerecorded-TUI label, and output sizes. If footage is unsuitable, refreshing it
is a separate ship-preparation decision. Only then add README's static poster
and links to videos, captions, transcripts, and provenance. Do not link missing
outputs. The driver commits artifacts and links, then runs the validator again.
The recorded source commit intentionally predates that media commit.

## Recovering failed candidates

Failures print the retained `docs/assets/.capture-product-*` directory. Inspect
`diagnostics.json` (browser errors and visual-server output), frames, and candidate
files there before retrying. Capture cannot retry while that untracked candidate
makes the tree dirty. Relocate **only the printed directory** outside this checkout
to retain evidence, or delete only that candidate after review. Never clean/reset
unrelated work or weaken the clean-source guard. Re-run the entire capture; do
not manually publish a partial package. No new README links are added by capture.
