import { NavLink, Outlet } from "react-router-dom";
import { Footer } from "../shared/ui";
import { ChatSessionProvider } from "../shared/chatSession";

const NAV = [
  { to: "/", label: "Home", end: true },
  // { to: "/models", label: "Models", end: false },
  { to: "/chat", label: "Chat", end: false },
  { to: "/background", label: "Background", end: false },
];

export function Layout() {
  return (
    <ChatSessionProvider>
      <div className="flex min-h-screen w-full flex-col overflow-x-hidden bg-[var(--bg)]" style={{ paddingTop: "var(--safe-area-inset-top)" }}>
        <header className="w-full border-b border-[var(--border)]">
          <div className="mx-auto flex h-[56px] max-w-[1200px] items-center justify-between px-6">
            <NavLink to="/" className="flex items-center gap-2">
              <div className="flex h-6 w-6 items-center justify-center rounded-full bg-[var(--text)] text-[11px] font-semibold text-[var(--bg)]">T</div>
              <span className="text-[14px] font-[500] tracking-[-0.02em]">Tab AI Studio</span>
              <span className="mono ml-2 hidden text-[10px] uppercase tracking-widest text-[var(--text-faint)] md:inline">Local • Private • No upload</span>
            </NavLink>

            <nav className="flex items-center gap-1">
              {NAV.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `mono rounded-full px-3 py-1.5 text-[11px] tracking-wide transition ${
                      isActive ? "bg-[var(--text)] text-[var(--bg)]" : "border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>

        <main className="flex w-full flex-1 flex-col items-center justify-start">
          <Outlet />
        </main>

        <Footer />
      </div>
    </ChatSessionProvider>
  );
}
