import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type CardProps = {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
};

export default function Card({ title, subtitle, children, className }: CardProps) {
  return (
    <section
      className={cn(
        "rounded-xl border border-line bg-surface p-5 shadow-sm",
        className,
      )}
    >
      {title && <h2 className="text-lg font-semibold text-ink">{title}</h2>}
      {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      {children && <div className="mt-4">{children}</div>}
    </section>
  );
}
