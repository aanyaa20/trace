/**
 * Draws the cited region over a rendered page.
 *
 * Rects are normalised to the page box (0-1), so they survive zoom without
 * recomputation. They are optional, and that is the honest part: PDF
 * extraction currently calls `page.get_text("text")` in
 * services/ml/app/extractors/pdf.py, which discards geometry, so no
 * coordinates reach the client for a PDF citation.
 *
 * When there are no rects this renders nothing and the caller falls back to
 * marking the page in the rail and highlighting the span in the text column.
 * It does not guess a position: a highlight drawn over the wrong paragraph is
 * worse than no highlight, because it looks authoritative.
 *
 * TODO: switch pdf.py to get_text("words"), persist word boxes on the chunk,
 * and map charStart/charEnd to rects here.
 */
export interface HighlightRect {
  /** All four normalised to the page box, origin top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function HighlightLayer({
  rects,
  active,
}: {
  rects?: HighlightRect[];
  active: boolean;
}): React.ReactElement | null {
  if (!rects || rects.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      {rects.map((rect, index) => (
        <span
          key={`${rect.x}-${rect.y}-${index}`}
          className={`absolute rounded-[2px] mix-blend-multiply ${active ? 'animate-bloom' : ''}`}
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
            backgroundColor: active
              ? undefined
              : 'color-mix(in srgb, var(--highlight) 30%, transparent)',
          }}
        />
      ))}
    </div>
  );
}
