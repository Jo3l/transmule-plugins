# Copilot / Agent instructions

## Git permission gate (non-negotiable)

Git operations (`git add`, `git commit`, `git tag`, `git push`, `git push --tags`, `git tag -d`, `git push origin --delete`) are **forbidden by default**. They require the user's **explicit, literal** authorization first — every single time, including after long multi-step tasks.

**Only these authorize git** (or an unambiguous equivalent):
- `sí`
- `commit y push`
- `haz commit y push`
- `commit` / `push` — only when they clearly answer "¿Commit y push?"

**These do NOT authorize git** — they only approve the code changes:
- `continua`, `adelante`, `adelante con los cambios`, `vale`, `ok`, `perfecto`, `dale`, `yes`, `go ahead`

Rules:
- Making code changes does **NOT** imply git permission. Code approval and git approval are separate.
- Ask "¿Commit y push?" and treat the answer as **DENIED** unless it is a literal authorization above.
- If the answer is ambiguous, re-ask. Never interpret a vague continuation as git permission.
- If you already committed/pushed without permission, stop and tell the user immediately; do not hide it.

## Versioning rule

Whenever a plugin version is bumped, **always** update these three places in the same commit:

1. `meta.version` inside the plugin `.js` file
2. `version` for that plugin's entry in `manifest.json`
3. The version shown in the plugin's row in `README.md` (format: `Name (vX.Y.Z)`)

The `check-updates` feature in transmule compares the **manifest** version against the installed plugin's `meta.version`, so all three must stay in sync.
