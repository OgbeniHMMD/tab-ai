import { Link } from "react-router-dom";

import { SettingsPanel } from "../components/SettingsPanel";

export default function SettingsPage() {
  return (
    <div className="flex w-full flex-1 flex-col items-center">
      <div className="flex w-full max-w-[760px] flex-col px-6 pb-16 pt-10 md:pt-14">
        <header className="mb-8">
          <h1 className="display text-[32px] leading-[0.95] tracking-[-0.03em] md:text-[40px]">Settings.</h1>
          <p className="mt-3 max-w-[52ch] text-[14px] leading-6 text-[var(--text-muted)]">
            Shape how the on-device model answers. Everything here is stored locally in this browser and applied to your next message.
          </p>
        </header>

        <SettingsPanel />

        <p className="mono mt-6 text-[11px] text-[var(--text-faint)]">
          Looking for models?{" "}
          <Link to="/models" className="underline underline-offset-2">
            Change the active model
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
