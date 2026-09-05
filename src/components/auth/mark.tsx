import clsx from "clsx";

/**
 * The product mark: a satellite tracing a ring. One element, one `rotate`
 * transform, so the browser composites it on the GPU and never repaints.
 */
export function GlentreeMark({ size = 52 }: { size?: number }) {
  return (
    <span className="auth-mark shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      <span className="auth-mark-orbit" />
      <span
        className="rounded-full bg-[var(--a-500)]"
        style={{ width: Math.round(size * 0.17), height: Math.round(size * 0.17) }}
      />
    </span>
  );
}

export function WordMark({ className }: { className?: string }) {
  return (
    <span className={clsx("font-semibold tracking-tight text-mist-100", className)}>Glentree</span>
  );
}
