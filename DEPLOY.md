# Deployment — CheeseThief

## Platform: Render

| Setting | Value |
|---------|-------|
| **Build command** | `npm install` |
| **Start command** | `node server.js` |
| **Port** | Set by Render via `PORT` env var — server reads `process.env.PORT` automatically |

### Notes
- Do **not** use `yarn` as the build command — the project uses npm (`package-lock.json` is present, no `yarn.lock`).
- `package.json` has no `start` script — set the start command explicitly in Render to `node server.js`.
- Auto-deploy from GitHub (`main` branch) is the recommended setup; every push triggers a redeploy.
