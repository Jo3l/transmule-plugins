# Copilot / Agent instructions

## Versioning rule

Whenever a plugin version is bumped, **always** update these three places in the same commit:

1. `meta.version` inside the plugin `.js` file
2. `version` for that plugin's entry in `manifest.json`
3. The version shown in the plugin's row in `README.md` (format: `Name (vX.Y.Z)`)

The `check-updates` feature in transmule compares the **manifest** version against the installed plugin's `meta.version`, so all three must stay in sync.
