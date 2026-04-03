# Greta Cloud Run - Project Context

## What this is
A Node.js orchestration server that runs inside a Google Cloud Run container. It manages:
- A Vite dev server (port 5173) for the user's React/TypeScript frontend
- A FastAPI Python backend (port 8000)
- A local MongoDB instance (port 27017)
- An Express API (port 8080) that proxies requests and handles file ops, dependency management, builds, screenshots

## Architecture
- `server.js` — entry point, initializes all services on startup
- `lib/core/` — config, state, logger (shared across all modules)
- `lib/api/` — Express route handlers (files, logs, screenshot, agents)
- `lib/services/` — process managers (vite, backend, mongodb), GCS storage, secrets
- `main-template/frontend/` — the React/shadcn/ui template copied into each user project
- `main-template/backend/` — the FastAPI template copied into each user project

## Key conventions
- All processes (Vite, FastAPI, MongoDB) are tracked in `lib/core/state.js`
- File paths must go through `resolveSafePath()` to prevent path traversal
- Use `execAsync` from `lib/api/files/helpers.js`, not raw `exec`
- GCS sync is the persistence layer — file changes must be synced via `syncToGCS` or `scheduleSyncToGCS`
- Bun is the package manager for the frontend, pip for the backend
- Image version is tracked in `lib/core/config.js` as `IMAGE_VERSION` — bump on every build

## Critical constraints
- `node_modules` is never symlinked — always a real folder installed via `bun install` at startup
- Vite must be restarted (not just HMR) after new npm dependencies are installed
- Never use `syncDirectoryToGCS` — use `syncToGCS` for full sync or `syncFilesToGCS` for incremental
- MongoDB runs locally in the container; Atlas is used for chat/session persistence only
