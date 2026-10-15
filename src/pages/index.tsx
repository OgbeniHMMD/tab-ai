import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Badge } from "../shared/ui";

interface ToolCard {
  to: string;
  title: string;
  description: string;
  meta: string[];
  icon: ReactNode;
}

const TOOLS: ToolCard[] = [
  {
    to: "/background",
    title: "Remove background",
    description: "Drop an image and get a transparent PNG. On-device segmentation with MODNet — nothing is uploaded.",
    meta: ["MODNet", "~12 MB", "Runs offline after first load"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M12 16V4M12 4l-3.5 3.5M12 4l3.5 3.5" />
        <path d="M4 14v3a2 2 0 002 2h12a2 2 0 002-2v-3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    to: "/chat",
    title: "Tiny chat",
    description: "Run a small language model right in the browser. Streams tokens locally; your prompts never leave the tab.",
    meta: ["SmolLM2 / Qwen", "WebGPU or WASM", "Streams token by token"],
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3">
        <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

export default function IndexPage() {
  return (
    <div className="flex w-full max-w-[760px] flex-col items-center px-6 pb-16 pt-12 md:pt-20">
      <div className="mb-12 w-full text-center">
        <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[44px]">
          AI that stays
          <br />
          on your device.
        </h1>
        <p className="mx-auto mt-4 max-w-[42ch] text-[15px] leading-6 text-[var(--text-muted)]">
          Two small on-device tools. Models download once from Hugging Face, then run entirely in your browser — private by default, offline afterwards.
        </p>
      </div>

      <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
        {TOOLS.map((tool) => (
          <Link
            key={tool.to}
            to={tool.to}
            className="group flex flex-col rounded-[28px] border border-[var(--border)] bg-[var(--bg-soft)] p-6 transition-all duration-300 hover:border-[var(--border-strong)] hover:shadow-[0_8px_40px_rgba(0,0,0,0.06)]"
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] text-[var(--text-faint)] transition-colors group-hover:border-[var(--border-strong)] group-hover:text-[var(--text)]">
              {tool.icon}
            </div>
            <div className="mt-5 text-[18px] font-[550] tracking-[-0.02em]">{tool.title}</div>
            <p className="mt-2 flex-1 text-[13px] leading-5 text-[var(--text-muted)]">{tool.description}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              {tool.meta.map((item) => (
                <Badge key={item}>{item}</Badge>
              ))}
            </div>
          </Link>
        ))}
      </div>

      <div className="mono mt-10 flex flex-wrap items-center justify-center gap-2 text-[11px] text-[var(--text-faint)]">
        <span>Client-side only</span>
        <span className="h-1 w-1 rounded-full bg-[var(--border-strong)]" />
        <span>No signup</span>
        <span className="h-1 w-1 rounded-full bg-[var(--border-strong)]" />
        <span>Works offline after first load</span>
      </div>
    </div>
  );
}
