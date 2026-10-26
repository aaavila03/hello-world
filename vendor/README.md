# Vendored libraries

Third-party code is served from this folder, not a CDN, so the Content Security Policy can
allow scripts from this site only and a compromised CDN can't inject code.

| File | Package | Version | SHA-256 |
|---|---|---|---|
| `supabase.js` | `@supabase/supabase-js` (`dist/umd/supabase.js`, unmodified) | 2.117.3 | `d6a5c4414a5d4ce646d9c1de223aa7067d3ff664c15394ffeb7fcffc763354a3` |
| `anthropic-sdk.mjs` | `@anthropic-ai/sdk`, bundled for the browser (demo mode only) | 0.133.0 | `9d9280cf2d8d0890477a0332a7014e80643f6ac102a9cbdf81831091003525cb` |

To update, install the new versions and rebuild:

```bash
npm install @supabase/supabase-js@<version> @anthropic-ai/sdk@<version> esbuild
cp node_modules/@supabase/supabase-js/dist/umd/supabase.js vendor/supabase.js
printf 'export { default } from "@anthropic-ai/sdk";\nexport * from "@anthropic-ai/sdk";\n' > anth.mjs
npx esbuild anth.mjs --bundle --format=esm --platform=browser --minify --legal-comments=eof --outfile=vendor/anthropic-sdk.mjs
sha256sum vendor/supabase.js vendor/anthropic-sdk.mjs   # update the table above
```
