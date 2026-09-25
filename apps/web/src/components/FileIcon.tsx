import type { Modality } from '@trace/contracts';

/**
 * Conventional file-type colours, the way every file manager does it: a reader
 * finds a PDF in a list of thirty rows by colour long before they read the
 * name. These are content semantics rather than interface chrome, which is why
 * they are the one place the palette is not the theme's.
 */
const STYLE: Record<Modality, { tint: string; label: string }> = {
  pdf: { tint: '#c8402f', label: 'PDF' },
  text: { tint: '#3d6ea8', label: 'TXT' },
  image: { tint: '#7a5ba6', label: 'IMG' },
  audio: { tint: '#c98a28', label: 'AUD' },
  video: { tint: '#2f8a76', label: 'VID' },
};

export function FileIcon({
  modality,
  size = 34,
}: {
  modality: Modality;
  size?: number;
}): React.ReactElement {
  const { tint, label } = STYLE[modality];

  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[6px] font-mono font-medium"
      style={{
        width: size,
        height: size,
        // A tint of the hue rather than the hue itself, so a list of thirty
        // rows does not read as a colour chart.
        backgroundColor: `color-mix(in srgb, ${tint} 16%, transparent)`,
        color: tint,
        fontSize: size <= 24 ? 8 : 9,
        letterSpacing: '0.04em',
      }}
    >
      {label}
    </span>
  );
}

export function modalityLabel(modality: Modality): string {
  return STYLE[modality].label;
}
