# Tab AI Studio

Private, on-device AI tools that run **entirely in your browser**. No servers, no
signup, nothing uploaded. Models are downloaded once from the Hugging Face Hub and
then run offline from the browser cache.

Built with **Vite + React + TypeScript + Tailwind CSS v4 + Transformers.js**.

## Tools

| Route         | What it does                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/`           | Hub linking to the two tools.                                                                                                            |
| `/background` | On-device image background removal with **MODNet** → transparent PNG.                                                                    |
| `/chat`       | Multi-conversation chat with a tiny LLM (SmolLM2 / Qwen2.5 / DistilGPT-2), streaming, with a prompt library and per-chat system prompts. |

## Requirements

- Node.js 18+ (20+ recommended) and npm.
- A modern browser. **Chrome/Edge 113+** (or a recent Chromium) for WebGPU; other
  browsers fall back to WASM automatically.

## Getting started

```bash
npm install
npm run dev      # http://localhost:5173
```

First run downloads a model (~117 MB – ~1.2 GB depending on the chat model you
pick). After that it is served from cache and works offline.

### Scripts

| Script              | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `npm run dev`       | Start the dev server (with COOP/COEP headers).       |
| `npm run build`     | Type-check (`tsc`) then build to `dist/`.            |
| `npm run preview`   | Serve the production build locally (with COOP/COEP). |
| `npm run typecheck` | Type-check only.                                     |

## How it works

Everything is client-side:

- **`src/shared/modelLoader.ts`** — one ref-counted, cached Transformers.js pipeline
  loader. A given `task + model + device + dtype` is built once and shared. It turns
  the library's per-file events into a single `DownloadProgress` snapshot (per-file
  **and** overall %), and disposes the pipeline when the last consumer unmounts.
- **`src/shared/capabilities.ts`** — probes WebGPU / `hardwareConcurrency` /
  `deviceMemory` and recommends a model.
- **`src/shared/storage.ts`** — scoped cache management. It only ever deletes **our
  own** Cache Storage entries and IndexedDB databases (matched by name); it never
  blanket-deletes the whole origin. It also exposes `probeModelCache()`, used by the
  models page to tell whether a model's weights are already on disk: Cache Storage is
  the authoritative signal (it reflects the actual bytes and stays correct after
  "Clear model cache"), with a persisted `loaded:v1:<model>` `localStorage` flag as a
  fallback when the Cache API is unavailable.
- **`src/shared/chatSession.tsx`** — the app-wide chat provider (mounted in `Layout`
  so the loaded pipeline survives route changes). Owns the model lifecycle, the
  conversation store, generation settings, and the skill/prompt library. Models
  load with `dtype: "q4f16"` on WebGPU and `dtype: "q4"` on WASM; large models
  (e.g. Qwen2.5 1.5B) are WebGPU-only because they cannot fit in the WASM heap.
- **`src/shared/conversations.ts`** — the multi-chat model + IndexedDB persistence.
  Conversations live in their own `tabai-chat` database, deliberately outside the
  `transformers|onnx` pattern that "Clear model cache" removes.
- **`src/shared/skills.ts`** — toggleable instruction blocks composed into the system
  prompt. **`src/shared/prompts.ts`** — the `/` prompt library and `;` command palette.
- **`src/shared/ui/`** — small presentational pieces (`ProgressBar`, `DownloadCard`,
  `Badge`, `StatusPill`, `Footer`).
- **`src/shared/styles/`** — design tokens as CSS variables, light/dark via
  `prefers-color-scheme`.

**Privacy:** images and prompts never leave the tab. **Model caching:** model weights
are fetched from `huggingface.co` on first use and cached locally (Cache Storage),
so subsequent runs are offline.

**Lifecycle:** pipelines are disposed on unmount and in-flight loads are cancelled on
navigation. `Enter` handling in inputs is guarded against IME composition
(`isComposing` / `keyCode === 229`).

## Cross-Origin Isolation (COOP/COEP) — important

Transformers.js runs ONNX Runtime Web's WASM backend, which uses `SharedArrayBuffer`
for **multi-threaded** inference. `SharedArrayBuffer` is only available when the page
is _cross-origin isolated_, which requires these two response headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These are configured for you in `vite.config.ts` for both `npm run dev` and
`npm run preview`. **Your production host must send them too**, or WASM inference
will silently fall back to single-threaded (it still works, just slower).

Examples:

**Netlify / Cloudflare Pages** — `public/_headers`:

```
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
```

**Vercel** — `vercel.json`:

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
      ]
    }
  ]
}
```

**Nginx**:

```nginx
add_header Cross-Origin-Opener-Policy  same-origin;
add_header Cross-Origin-Embedder-Policy require-corp;
```

> GitHub Pages cannot set custom response headers. If you deploy there, WASM
> multi-threading will be disabled (WebGPU is unaffected). To get isolation you need
> a host/proxy that can set headers, or a service worker (out of scope here).

Under `COEP: require-corp`, any third-party subresource must opt in with CORS/CORP.
The app only loads Google Fonts (which send permissive CORS headers) and model files
from `huggingface.co` (fetched with CORS) — both are compatible.

## WASM asset handling

Transformers.js ships ONNX Runtime Web, which loads a large `.wasm` runtime. By
default the library points at a **jsdelivr CDN** URL; we deliberately avoid that.

- `vite.config.ts` copies the runtime (`ort-wasm-*.wasm` + its `ort-wasm-*.mjs`
  loader) from `node_modules/onnxruntime-web/dist` into `public/ort/` at dev/build
  time (this directory is generated and git-ignored).
- `src/shared/modelLoader.ts` sets
  `env.backends.onnx.wasm.wasmPaths = <base>/ort/` so the runtime is loaded
  **same-origin**, with no CDN and no CORS surprises under COEP.
- `optimizeDeps.exclude` keeps `@huggingface/transformers`, `onnxruntime-web` and
  `onnxruntime-common` out of esbuild pre-bundling, because esbuild mangles the
  `new URL(..., import.meta.url)` / worker lookups they rely on.

## Deployment

```bash
npm run build     # outputs to dist/
```

Serve `dist/` as a static SPA with a catch-all rewrite to `index.html`, and remember
to send the COOP/COEP headers above.

If you deploy under a sub-path, set Vite's `base` (e.g. `base: '/my-app/'`) in
`vite.config.ts` — the WASM path is derived from `import.meta.env.BASE_URL`, so it
follows automatically.

Notes:

- The Transformers.js chunk (~870 kB) is large by design; it is code-split into its own
  chunk and only loaded when a tool actually runs a model.
- Models are cached per-origin in Cache Storage; use **Clear model cache** on the
  background page or your browser's site-data settings to reclaim space.

## Project structure

```
src/
  main.tsx            # React root + router
  App.tsx             # routes from src/pages via vite-plugin-pages
  components/
    Layout.tsx        # header (nav) + footer shell
  pages/              # file-based routes
    index.tsx
    background.tsx
    chat.tsx
  shared/
    modelLoader.ts    # cached pipeline loader + download progress
    capabilities.ts   # WebGPU / device probing + model recommendation
    storage.ts        # scoped cache + IndexedDB clearing
    chatSession.tsx   # chat provider: model lifecycle, conversations, skills
    conversations.ts  # conversation model + IndexedDB persistence
    skills.ts         # toggleable system-prompt blocks
    prompts.ts        # `/` prompts + `;` commands
    styles/
      index.css       # @import "tailwindcss"; + tokens
      tokens.css      # design tokens (light/dark via prefers-color-scheme)
    ui/               # ProgressBar, DownloadCard, Badge, StatusPill, Footer
```

## License

MIT
