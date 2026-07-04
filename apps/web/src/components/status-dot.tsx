import { twMerge } from "tailwind-merge";

interface StatusDotProps {
  online: boolean;
  className?: string;
}

// The one deliberately memorable element in the "instrument panel" design:
// a calm pulse when a machine is online, a static ring when it's offline.
// Purely decorative (aria-hidden) -- the status badge text next to it
// ("Online"/"Offline") is the accessible label, so screen readers don't
// announce this twice. See .status-dot in main.css for the reduced-motion
// handling.
export function StatusDot({ online, className }: StatusDotProps) {
  return (
    <span
      aria-hidden="true"
      data-state={online ? "online" : "offline"}
      className={twMerge("status-dot", className)}
    />
  );
}
