# Nexus Web

Web port of Nexus Android — same matrix, notes JSON, and Google Drive sync (`nexus_backup.json` in appDataFolder).

## Folder location

**Default path:** `ToDo/website/` at the Android project root (`AndroidStudioProjects/ToDo/website`).

You can copy this folder **anywhere** (sibling to `ToDo`, another repo, etc.) — it is self-contained. It is a static site: copy it to any host. Only requirement for sync: same Google OAuth Web client with your deployed origin authorized.

## Develop

```bash
cd website
npm install
npm run dev
```

## Deploy (GitHub Pages)

1. In Google Cloud Console → OAuth Web client → add **Authorized JavaScript origins**:
   - `https://YOUR_USERNAME.github.io`
   - `http://localhost:5173` (dev)
2. Build:

```bash
npm run build
```

3. Publish `dist/` to GitHub Pages (branch `gh-pages` or `/docs` on `main`).
4. If the repo is `username.github.io/REPO_NAME`, set in `vite.config.ts`:

```ts
base: '/REPO_NAME/',
```

Default is `./` (works for custom domain or root project pages).

## PWA / Add to Home Screen

- **Android Chrome**: menu → Install app / Add to Home screen.
- **iPhone Safari**: Share → Add to Home Screen.

Offline: tasks in IndexedDB; service worker caches the app shell.

## Sync

Uses the same file as Android: `nexus_backup.json`, merge by `taskUuid` and `max(updatedAt, deletedAt)`. Sign in with the **same Google account** as the app.

## Layout modes

Settings → **Phone** or **Desktop**. Desktop uses a centered wide layout (not a scaled phone UI).
