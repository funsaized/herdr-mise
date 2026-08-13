# VHS tape for the Phase 2 TUI pane demo.
#
# Drives the *real* integrated release binary in a real ttyd-backed
# terminal, not a mock or browser substitute. VHS is an external CLI
# installed system-wide (brew install vhs, version 0.11.0+); it brings
# its own ffmpeg + ttyd dependencies and is not added to the project's
# repository dependencies.
#
# The tape is intentionally minimal: size, fonts, and a long enough
# sleep for the demo roster to advance through idle/working/blocked/done
# ticks at the 100 ms scene cadence. The capture wrapper
# (`scripts/capture-tui-demo.sh`) owns all fail-closed checks and
# cleanup traps; the tape does no cleanup itself.
#
# Why these settings:
#   - Width 1100 / Height 800: captures approximately 110 columns by 40
#     rows. The committed scene goldens use an 80x24-cell harness; this
#     larger capture keeps the status header + 86 board + both station rows +
#     footer visible at the same time, matching the 30-minute pane review.
#   - FontSize 14, monospace: the only theme where every glyph
#     (`▀`, `·`, `!!`, `✓`, accent symbols) renders legibly at the
#     released terminal capture resolution.
#   - Framerate 20: matches `scripts/readme-media-config.mjs`
#     `gifFrameRate`. Keeping browser/TUI captures at the same rate
#     makes the README side-by-side comparison visually consistent.
#   - Padding 24, MarginFill #0b141a: capture chrome outside the terminal
#     pane. The margin never bleeds into the pane area, so it does not
#     represent the scene's `theme::BG` color.

Output docs/assets/herdr-mise-tui-demo.gif

Require bash
Require ./target/release/herdr-mise
Require vhs

Set Shell bash
Set FontSize 14
Set FontFamily "DejaVu Sans Mono, monospace"
Set Width 1100
Set Height 800
Set Padding 24
Set MarginFill "#0b141a"
Set Margin 0
Set BorderRadius 0
Set WindowBar Colorful
Set WindowBarSize 28
Set TypingSpeed 0ms
Set Framerate 20

Type "./target/release/herdr-mise --tui"
Enter

# Let the demo roster cycle through multiple tick windows so the GIF
# visibly contains idle/working/blocked/done cell art, the 86 board,
# the PASS — ORDERS UP banner, and at least one full blocked escalation
# banner with a literal MM:SS timer. 8 s at the 100 ms scene cadence
# is ~80 frames, comfortably above the 60-frame minimum needed to
# prove animation and is well under the 10 s browser capture budget.
Sleep 8s

# Quit the pane cleanly so ttyd closes the websocket and VHS flushes
# the last frame. 'q' is the canonical Phase 2 quit key
# (`server/src/tui/mod.rs` `handle_key`).
Type "q"
Sleep 500ms
