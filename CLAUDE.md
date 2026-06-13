# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git Workflow

For the duration of this project: every change must be committed with a clean message, saved locally, and pushed to GitHub immediately. No exceptions.

- **Remote:** https://github.com/Frigan/CheeseThief (branch: `main`)
- **Commit style:** Imperative subject line (≤72 chars), blank line, then a body explaining *why* if non-obvious
- **After every change:** stage → commit → `git push origin main`
- **PowerShell commit syntax** (heredoc does not work in PowerShell):
  ```powershell
  git commit -m @'
  Subject line here

  Optional body here.

  Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
  '@
  ```
- **gh CLI** is at `C:\Program Files\GitHub CLI\gh.exe` and is not in the default PATH — prepend it when needed: `$env:PATH += ";C:\Program Files\GitHub CLI"`
