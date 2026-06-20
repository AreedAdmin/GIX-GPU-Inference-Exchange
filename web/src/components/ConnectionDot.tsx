type Status = "connecting" | "connected" | "disconnected";

const COLOR: Record<Status, string> = {
  connected: "var(--buy)",
  connecting: "var(--amber)",
  disconnected: "var(--sell)",
};

export function ConnectionDot({
  status,
  label,
}: {
  status: Status;
  label?: string;
}) {
  const color = COLOR[status];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative inline-flex h-2 w-2">
        <span
          className="absolute inline-flex h-full w-full rounded-full opacity-70 animate-pulse-dot"
          style={{ background: color }}
        />
        <span
          className="relative inline-flex h-2 w-2 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
        />
      </span>
      {label && (
        <span className="num text-micro uppercase tracking-wide text-secondary">
          {label}
        </span>
      )}
    </span>
  );
}
