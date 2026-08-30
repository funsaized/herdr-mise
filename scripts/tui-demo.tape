# Captures an already-prepared real Herdr session. The wrapper verifies that
# Herdr is live; this tape only attaches a terminal and records its host chrome.

Output docs/assets/herdr-mise-tui-demo.gif

Require bash
Require herdr
Require vhs

Set Shell bash
Set FontSize 12
Set FontFamily "DejaVu Sans Mono, monospace"
Set Width 1600
Set Height 900
Set Padding 0
Set Margin 0
Set BorderRadius 0
Set WindowBar Colorful
Set WindowBarSize 28
Set TypingSpeed 0ms
Set Framerate 20

Hide
Type "herdr session attach \"${HERDR_CAPTURE_SESSION}\""
Enter
Wait+Screen@15s /MISE.*LIVE/
Sleep 500ms
Show
Sleep 8s
Hide
Ctrl+C
