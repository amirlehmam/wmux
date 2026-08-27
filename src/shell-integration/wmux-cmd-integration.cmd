@echo off
REM wmux CMD Integration
REM Reports CWD via OSC 9 escape sequence embedded in prompt

REM Set WMUX env var
set WMUX=1

REM UTF-8 code page so multi-byte input (Korean, Japanese, Chinese, emoji)
REM round-trips through conpty correctly.
chcp 65001 >nul 2>&1

REM Set prompt to include OSC 9 with current directory
REM ESC]9;9;PATH ESC\ then normal prompt
prompt $e]9;9;$P$e\$P$G

REM Semantic prompt marks (issue #207), layered on top of the line above rather
REM than folded into it, so the cwd report keeps working byte for byte whatever
REM happens here. A goes in front of everything the prompt draws, B right after
REM the "> ", where the user's input starts. cmd's prompt has no non-printing
REM markers of the kind bash's \[ \] provides, and needs none: OSC strings do not
REM move the console cursor, which is exactly why the OSC 9;9 already in the line
REM above has never disturbed it either.
REM
REM C and D are NOT here, and cannot be. They mark the moment a command is
REM submitted and the moment it finishes, and cmd offers no preexec/precmd seam
REM to hang either one on — DOSKEY macros only rewrite what was typed, and there
REM is no hook at all after a command returns. Faking them from the prompt would
REM mean claiming a boundary one whole command late, so a cmd pane reports where
REM its prompts are and stays honest about knowing nothing else. Consumers must
REM already tolerate an A/B-only stream: plenty of shells emit no D.
REM
REM Guarded on WMUX_SURFACE_ID like every other emission in this integration —
REM without a surface there is nothing for the marks to be about.
if defined WMUX_SURFACE_ID prompt $e]133;A$e\$e]9;9;$P$e\$P$G$e]133;B$e\
