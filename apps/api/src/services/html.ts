/**
 * Strips scripts, styles and chrome before text reaches the chunker, so
 * navigation boilerplate and mail-client markup do not become retrievable
 * chunks.
 *
 * Structure survives: <h1>–<h6> become markdown heading lines, which the
 * chunker uses to start a chunk per section and to tag each chunk with its
 * heading, and table cells are separated with " | " so a row still reads as a
 * row. The page <title> leads as a top-level heading.
 */
export function htmlToText(html: string): string {
  const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/<[^>]+>/g, ' ').trim();
  const body = html
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_whole, level: string) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(/<\/(th|td)>/gi, ' | ')
    // Wikipedia and most wikis append an edit link to every heading.
    .replace(/\[\s*edit\s*\]/gi, ' ');
  return (title ? `# ${title}\n\n` : '') + stripTags(body);
}

function stripTags(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/^ +| +$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
