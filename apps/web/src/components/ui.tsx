/**
 * The shared primitives.
 *
 * Every page used to build its own header, its own row and its own empty
 * state out of utility classes, which is why no two page titles sat at the
 * same height and no two lists had the same row. These are the pieces; a page
 * composes them and stops making layout decisions of its own.
 */

/** The top of a page: what this is, how much of it there is, what you can do. */
export function PageHeader({
  title,
  meta,
  lede,
  actions,
}: {
  title: string;
  meta?: React.ReactNode;
  lede?: string;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="mb-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="page-title">{title}</h1>
        {meta && <span className="mono-meta">{meta}</span>}
        {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </div>
      {lede && (
        <p className="measure mt-1.5 text-[13px] leading-relaxed text-ink-muted">{lede}</p>
      )}
    </header>
  );
}

export function Panel({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <section className="panel">
      {title && (
        <div className="panel-head">
          <span className="eyebrow">{title}</span>
          {action && <span className="ml-auto">{action}</span>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * A statistic. The number leads because it is what the eye is looking for,
 * and the label sits under it rather than beside it so a row of these aligns
 * on the numbers rather than on their names.
 */
export function Stat({
  value,
  label,
  note,
  tone,
}: {
  value: string;
  label: string;
  note?: string;
  tone?: string;
}): React.ReactElement {
  return (
    <div className="panel flex-1 px-4 py-3.5" style={{ minWidth: 148 }}>
      <p
        className="font-display text-[26px] font-semibold leading-none"
        style={{ color: tone ?? 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}
      >
        {value}
      </p>
      <p className="mt-2 text-[13px] text-ink-muted">{label}</p>
      {note && <p className="mono-meta mt-0.5 truncate">{note}</p>}
    </div>
  );
}

export function Chip({
  children,
  tone,
}: {
  children: React.ReactNode;
  /** A colour token. Omit for the neutral chip, which is most of them. */
  tone?: string;
}): React.ReactElement {
  if (!tone) return <span className="chip chip-neutral">{children}</span>;
  return (
    <span
      className="chip"
      style={{ backgroundColor: `color-mix(in srgb, ${tone} 15%, transparent)`, color: tone }}
    >
      {children}
    </span>
  );
}

/** A status dot. Same vocabulary in the library, the rail and the mailboxes. */
export function Dot({ tone }: { tone: string }): React.ReactElement {
  return (
    <span
      aria-hidden
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: tone }}
    />
  );
}

/**
 * What a page says when it has nothing to show. An empty state that only says
 * "nothing here" wastes the one moment the reader is definitely looking at it,
 * so it names the next action instead.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="px-6 py-14 text-center">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {body && (
        <p className="measure mx-auto mt-1.5 text-[13px] leading-relaxed text-ink-muted">{body}</p>
      )}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Rows that hold their shape while the real ones load. */
export function SkeletonRows({ rows = 5 }: { rows?: number }): React.ReactElement {
  return (
    <div>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="list-row">
          <span className="skeleton h-7 w-7 rounded-md" />
          <span className="min-w-0 flex-1">
            <span
              className="skeleton block h-3 rounded"
              style={{ width: `${38 + ((index * 13) % 34)}%` }}
            />
            <span className="skeleton mt-1.5 block h-2.5 w-24 rounded" />
          </span>
          <span className="skeleton h-3 w-14 rounded" />
        </div>
      ))}
    </div>
  );
}

/** A group of mutually exclusive choices, used for filters and modes. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <div
      className="inline-flex rounded-md border border-rule p-0.5"
      style={{ backgroundColor: 'var(--paper-sunk)' }}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className="rounded px-2.5 py-1 text-[12px] font-medium disabled:opacity-50"
            style={{
              backgroundColor: active ? 'var(--surface-raised)' : 'transparent',
              color: active ? 'var(--ink)' : 'var(--ink-faint)',
              boxShadow: active ? 'var(--elev-1)' : 'none',
              transition: 'color var(--dur) var(--ease-out)',
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
