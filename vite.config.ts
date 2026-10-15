import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin, UserConfig } from "vite";
import { defineConfig } from "vite";
import Pages from "vite-plugin-pages";

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** onnxruntime-web ships its WASM runtime as loose files next to a JS loader. */
const ORT_DIST = resolve(projectRoot, "node_modules/onnxruntime-web/dist");

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
    configureServer() {
      copy();
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
