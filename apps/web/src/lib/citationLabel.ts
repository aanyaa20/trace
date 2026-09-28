import type { Citation } from '@trace/contracts';

/** 12:43, or 1:02:05 once a recording passes the hour. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * Where a citation points, in words a reader recognises: "Page 3" for a
 * document, "12:43–13:17" for a recording, the site for a web result. Only
 * locations the citation actually carries are printed — a text file with no
 * page gets no page, never a guessed one.
 */
export function locationOf(citation: Citation, sectionChars = 40): string {
  const where = pointOf(citation);
  const section = citation.section?.trim();
  // A slide's section is its title, already implied by the slide number when
  // the title is just "Slide N"; anything else is worth naming.
  if (!section || /^slide \d+$/i.test(section)) return where;
  const short = section.length > sectionChars ? `${section.slice(0, sectionChars - 1)}…` : section;
  return where ? `${where} · ${isSlides(citation) ? short : `Section: ${short}`}` : `Section: ${short}`;
}

function isSlides(citation: Citation): boolean {
  return /\.pptx?$/i.test(citation.filename);
}

function pointOf(citation: Citation): string {
  if (citation.page !== null) return `${isSlides(citation) ? 'Slide' : 'Page'} ${citation.page}`;
  if (citation.tsStart !== null) {
    const end = citation.tsEnd;
    return end !== null && Math.floor(end) > Math.floor(citation.tsStart)
      ? `${clock(citation.tsStart)}–${clock(end)}`
      : clock(citation.tsStart);
  }
  if (citation.external && citation.externalUrl) {
    try {
      return new URL(citation.externalUrl).hostname.replace(/^www\./, '');
    } catch {
      return 'web';
    }
  }
  return '';
}

/** The whole receipt: "paper.pdf — Page 3", "lecture.mp4 — 12:43–13:17". */
export function citationLabel(citation: Citation): string {
  const where = locationOf(citation, 120);
  return where ? `${citation.filename} — ${where}` : citation.filename;
}
