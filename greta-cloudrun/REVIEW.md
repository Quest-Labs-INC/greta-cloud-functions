# Code Review Guidelines

## Always flag
- Any file path used in shell commands or fs operations that doesn't go through `resolveSafePath()` — path traversal risk
- Hardcoded GCS bucket names, MongoDB URIs, or API keys outside of `lib/core/config.js`
- Any new Express route that accepts user input without validation
- Use of `syncDirectoryToGCS` — it has been replaced by `syncToGCS` / `syncFilesToGCS`
- Shell commands built with string interpolation from user input (command injection risk)
- Starting or stopping Vite/backend/MongoDB without going through the service modules in `lib/services/processes/`
- Reading or writing `state` directly outside of `lib/core/state.js`
- `bun add` without a subsequent Vite restart when adding frontend dependencies at runtime
- Bumping `IMAGE_VERSION` in `lib/core/config.js` without a corresponding Dockerfile change

## Style
- Prefer `execAsync` over raw `exec` or `spawn` for one-off shell commands
- Use `apiResponse()` from helpers for all Express responses — not `res.json()` directly
- Log with the module-specific logger (`viteLogger`, etc.) not `console.log` in service files
- All timeouts on `execAsync` calls must be explicit — no relying on defaults

## Skip
- `greta-cloudrun/main-template/` — generated template files, not hand-maintained code
- `*.lock` files (bun.lock, package-lock.json)
- Formatting-only changes
