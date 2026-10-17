/**
 * Device capability probing + model recommendation.
 *
 * Everything here is best-effort: browsers deliberately under-report hardware
 * for fingerprinting reasons (e.g. `deviceMemory` is Chrome-only and capped at 8).
 */
import { useEffect, useState } from "react";

export interface AdapterInfo {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}

export interface WebCapabilities {
  webgpu: boolean;
  /** Whether the WebGPU adapter exposes the `shader-f16` feature. */
  f16: boolean;
  adapter: AdapterInfo | null;
  /** navigator.hardwareConcurrency — often capped by the browser. */
  threads: number | null;
  /** navigator.deviceMemory (GB) — Chrome-only, capped at 8. */
  memoryGB: number | null;
  mobile: boolean;
}

/** Chat model used when the device is modest or WebGPU is unavailable. */
export const CHAT_FALLBACK_MODEL = "onnx-community/SmolLM2-135M-Instruct-ONNX";
/** Chat model used on capable desktops. */
export const CHAT_DESKTOP_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

export async function probeCapabilities(): Promise<WebCapabilities> {
  let webgpu = false;
  let f16 = false;
  let adapter: AdapterInfo | null = null;

  try {
    // WebGPU types are not in the default TS DOM lib yet, so probe loosely.
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<any> } }).gpu;
    if (gpu) {
      const gpuAdapter = await gpu.requestAdapter();
      if (gpuAdapter) {
        webgpu = true;
        f16 = gpuAdapter.features?.has?.("shader-f16") ?? false;
        adapter = (gpuAdapter.info as AdapterInfo | undefined) ?? null;
      }
    }
  } catch {
    // WebGPU unavailable or blocked — fall back to WASM.
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: { mobile?: boolean };
  };

  return {
    webgpu,
    f16,
    adapter,
    threads: nav.hardwareConcurrency ?? null,
    memoryGB: nav.deviceMemory ?? null,
    mobile: nav.userAgentData?.mobile ?? /Mobi|Android/i.test(navigator.userAgent),
  };
}

/** React hook wrapper around {@link probeCapabilities}. */
export function useCapabilities(): WebCapabilities | null {
  const [caps, setCaps] = useState<WebCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    void probeCapabilities().then((result) => {
      if (!cancelled) setCaps(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return caps;
}

/**
 * Recommend a text-generation model. Larger models only make sense with WebGPU
 * and plenty of RAM; otherwise stay small so it still runs smoothly on WASM.
 */
export function recommendModel(caps: WebCapabilities | null): string {
  if (!caps) return CHAT_FALLBACK_MODEL;
  if (caps.webgpu && !caps.mobile && (caps.memoryGB ?? 8) >= 8) {
    return CHAT_DESKTOP_MODEL;
  }
  return CHAT_FALLBACK_MODEL;
}
