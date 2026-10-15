export function Footer() {
  return (
    <footer className="mt-auto w-full border-t border-[var(--border)]">
      <div className="mx-auto flex h-[56px] max-w-[1200px] items-center justify-center px-6">
        <div className="flex items-center gap-1.5 text-[12px] tracking-[-0.01em] text-[var(--text-faint)]">
          <span>made with</span>
          <span className="text-[13px] text-[#ef4444]">❤️</span>
          <span>in Nigeria by</span>
          <span className="font-medium text-[var(--text-muted)]">Hammed Olajide</span>
        </div>
      </div>
    </footer>
  );
}
