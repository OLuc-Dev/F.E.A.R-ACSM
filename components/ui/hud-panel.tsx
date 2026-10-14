import type { ReactNode } from "react";

/** A HUD frame: thin border, lit corners, a spaced-out title (and, beside it, `aside`). */
export function HudPanel({
  title,
  label,
  aside,
  children,
  className = "",
}: {
  title: string;
  /** The region's name for screen readers, when the title alone is too terse. */
  label?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const corner = "pointer-events-none absolute size-3 border-cyan-300/60";
  return (
    <section
      aria-label={label}
      className={`relative rounded-lg border border-cyan-300/[0.14] bg-[#060d14]/70 p-3.5 backdrop-blur-md ${className}`}
    >
      <span aria-hidden className={`${corner} -left-px -top-px rounded-tl-lg border-l-2 border-t-2`} />
      <span aria-hidden className={`${corner} -right-px -top-px rounded-tr-lg border-r-2 border-t-2`} />
      <span aria-hidden className={`${corner} -bottom-px -left-px rounded-bl-lg border-b-2 border-l-2`} />
      <span aria-hidden className={`${corner} -bottom-px -right-px rounded-br-lg border-b-2 border-r-2`} />
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h2 className="font-mono text-[10px] uppercase tracking-[0.32em] text-cyan-200/55">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}
