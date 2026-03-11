# Contributing

Thanks for your interest in contributing plugins to TransMule!

## Adding a new plugin

1. **Fork** this repository
2. Create your plugin file following the [Plugin API](PLUGIN_API.md)
3. Place it in the correct folder:
   - `media/` — content providers (movies, shows, etc.)
   - `torrent-search/` — torrent search index providers
4. Test it locally by uploading it in TransMule (Settings → Providers → Upload Plugin)
5. Open a **Pull Request** with:
   - The plugin file
   - A row added to the relevant table in [README.md](README.md)
   - A brief description of what the plugin does and what source it uses

## Plugin requirements

- Plain `.js` file — no build step, no `npm` dependencies
- Must pass TransMule's validation (correct `meta` fields + required method)
- Must not require authentication or API keys that aren't user-supplied
- Must only make outbound requests to the declared source
- No `eval()`, `Function()`, or dynamic code execution tricks
- Works on Node.js 18+

## Code style

- Use `async/await` over `.then()` chains
- Use `fetch` with `AbortSignal.timeout(10_000)` for every network call
- Return empty arrays `[]` / `{ items: [] }` on non-2xx responses rather than throwing
- Keep helpers small and co-located in the same file (no imports)

## Updating an existing plugin

If a source changes its URL or response format, open a PR updating the relevant file. Please describe what changed and include a brief test you ran locally.

## Reporting broken plugins

Open an issue with:

- Plugin name / filename
- Error message or symptoms
- When it stopped working (if known)
