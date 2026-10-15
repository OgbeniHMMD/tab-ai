import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig, ViteDevServer } from "vite";
import { defineConfig } from "vite";
import Pages from "vite-plugin-pages";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** onnxruntime-web ships its WASM runtime as loose files next to a JS loader. */
const ORT_DIST = resolve(projectRoot, "node_modules/onnxruntime-web/dist");

/** Content types for the ORT runtime files we serve from `public/ort/`. */
const ORT_CONTENT_TYPES: Record<string, string> = {
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
};

/**
 * Serve `public/ort/**` ourselves, ahead of Vite's transform middleware.
 *
 * onnxruntime-web loads its runtime loader through a *dynamic* `import()` whose
 * specifier is a runtime variable. Vite cannot analyze that, so it rewrites the
 * call to `__vite__injectQuery(url, 'import')`, producing a request like
 * `/ort/ort-wasm-simd-threaded.jsep.mjs?import`. That request looks like a JS
 * module import, but Vite refuses to transform anything under `public/`
 * (`ERR_LOAD_PUBLIC_URL`), so the `import()` rejects with "Failed to fetch
 * dynamically imported module".
 *
 * Serving the copied files directly keeps them same-origin and byte-identical to
 * `node_modules/onnxruntime-web/dist`, which is exactly what the loader expects.
 * This only runs for `vite dev`; in production the files are copied verbatim
 * and served by the static host, with no transform pipeline to trip over.
 */
function serveOrtRuntime(server: ViteDevServer, dir: string): void {
  const base = server.config.base.replace(/\/$/, "");
  const prefix = `${base}/ort/`;

  server.middlewares.use((req, res, next) => {
    const pathname = (req.url ?? "").split("?")[0];
    if (!pathname.startsWith(prefix)) return next();

    const filePath = resolve(dir, decodeURIComponent(pathname.slice(prefix.length)));
    // Reject path traversal and unknown files; let Vite handle anything else.
    if (!filePath.startsWith(dir + sep) || !existsSync(filePath)) return next();

    res.setHeader("Content-Type", ORT_CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    createReadStream(filePath).pipe(res);
  });
}

/**
 * Copy the onnxruntime-web WASM runtime (`.wasm` + its `.mjs` loader glue) into
 * `public/ort/` so it is served from our own origin instead of a CDN.
 *
 * transformers.js hard-codes a jsdelivr fallback for `wasmPaths`, so at runtime
 * (see `src/shared/modelLoader.ts`) we override it to point at this directory.
 * Serving the WASM same-origin also avoids CORS headaches under COEP.
 */
function copyOrtWasm(): Plugin {
  let publicOrtDir = resolve(projectRoot, "public/ort");

  const copy = () => {
    if (!existsSync(ORT_DIST)) {
      // Dependencies are not installed yet — nothing to copy.
      return;
    }
    mkdirSync(publicOrtDir, { recursive: true });
    for (const file of readdirSync(ORT_DIST)) {
      if (/^ort-wasm-.*\.(wasm|mjs)$/.test(file)) {
        copyFileSync(resolve(ORT_DIST, file), resolve(publicOrtDir, file));
      }
    }
  };

  return {
    name: "tab-ai:copy-ort-wasm",
    configResolved(config) {
      publicOrtDir = resolve(config.root, "public/ort");
    },
    configureServer(server) {
      copy();
      serveOrtRuntime(server, publicOrtDir);
    },
    buildStart() {
      copy();
    },
    generateBundle(_options, bundle) {
      // onnxruntime-web also references its `.wasm` from JS via
      // `new URL(..., import.meta.url)`, so Rollup bundles a second copy under
      // `assets/`. At runtime we always load from `/ort/` (see modelLoader.ts),
      // so that copy is dead weight — drop it from the output.
      for (const fileName of Object.keys(bundle)) {
        if (/(^|\/)ort-wasm-.*\.wasm$/.test(fileName)) delete bundle[fileName];
      }
    },
  };
}

/**
 * Cross-Origin Isolation headers. Required so `SharedArrayBuffer` is available,
 * which lets onnxruntime-web run its multi-threaded WASM build.
 *
 * NOTE: the same headers MUST be sent in production — see README.md.
 */
const crossOriginIsolationHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig((): UserConfig => ({
  plugins: [react(), tailwindcss(), copyOrtWasm(), Pages({ dirs: "src/pages", extensions: ["tsx", "ts"] })],

  // transformers.js and onnxruntime-web must not be pre-bundled by esbuild:
  // esbuild rewrites/mangles the `new URL(..., import.meta.url)` and
  // `import.meta.url`-relative worker/WASM lookups they rely on.
  optimizeDeps: {
    exclude: ["@huggingface/transformers", "onnxruntime-web", "onnxruntime-common"],
  },

  // Treat `.wasm` as a static asset so it can be imported/`new URL`-referenced.
  assetsInclude: ["**/*.wasm"],

  worker: {
    format: "es",
  },

  build: {
    // Top-level await / WASM features need a modern target.
    target: "esnext",
    rollupOptions: {
      output: {
        // Keep the WASM-bearing ORT chunk stable across builds.
        manualChunks: {
          transformers: ["@huggingface/transformers", "onnxruntime-web", "onnxruntime-common"],
        },
      },
    },
  },

  server: {
    headers: crossOriginIsolationHeaders,
  },

  // `vite preview` serves the production build; keep the headers there too.
  preview: {
    headers: crossOriginIsolationHeaders,
  },
}));
