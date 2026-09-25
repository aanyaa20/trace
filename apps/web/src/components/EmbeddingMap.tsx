import { useEffect, useRef, useState } from 'react';
import type { EmbeddingMap as EmbeddingMapData, Modality } from '@trace/contracts';
import { api } from '../lib/api.js';

// Warm, archival, and distinguishable without relying on hue alone: the
// query marker is told apart by its shape, not its colour.
const MODALITY_COLOR: Record<Modality, string> = {
  text: '#a9c98e',
  pdf: '#e0ae52',
  image: '#e8674a',
  audio: '#7fc4b0',
  video: '#c9a882',
};

/** Canvas cannot read Tailwind tokens, so the accent is pulled off :root. */
function token(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

interface Rotation {
  yaw: number;
  pitch: number;
}

/**
 * Scale from a high percentile rather than the maximum. PCA on a small corpus
 * usually leaves one or two outliers far from the rest, and scaling to them
 * squeezes every other point into the middle of the canvas.
 */
function spreadOf(points: Array<{ x: number; y: number; z: number }>): number {
  const magnitudes = points
    .map((point) => Math.hypot(point.x, point.y, point.z))
    .sort((a, b) => a - b);
  if (magnitudes.length === 0) return 1;
  const index = Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * 0.9));
  return Math.max(0.05, magnitudes[index] ?? 1);
}

/**
 * Projects the three PCA components to the canvas by hand rather than pulling
 * in a WebGL scene graph. A few thousand points is well inside what 2D canvas
 * handles, and the dependency would outweigh the feature on a laptop build.
 */
function project(
  point: { x: number; y: number; z: number },
  rotation: Rotation,
  scale: number,
  centre: { x: number; y: number },
): { x: number; y: number; depth: number } {
  const cosYaw = Math.cos(rotation.yaw);
  const sinYaw = Math.sin(rotation.yaw);
  const cosPitch = Math.cos(rotation.pitch);
  const sinPitch = Math.sin(rotation.pitch);

  const x1 = point.x * cosYaw - point.z * sinYaw;
  const z1 = point.x * sinYaw + point.z * cosYaw;
  const y1 = point.y * cosPitch - z1 * sinPitch;
  const z2 = point.y * sinPitch + z1 * cosPitch;

  // Mild perspective so depth is readable while rotating.
  const perspective = 1 / (1.8 - z2 * 0.35);

  return {
    x: centre.x + x1 * scale * perspective,
    y: centre.y - y1 * scale * perspective,
    depth: z2,
  };
}

export function EmbeddingMap({
  kbId,
  query,
}: {
  kbId: string;
  query: string | null;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [data, setData] = useState<EmbeddingMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rotation, setRotation] = useState<Rotation>({ yaw: 0.6, pitch: 0.3 });
  const [hovered, setHovered] = useState<string | null>(null);
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void api
      .embeddingMap(kbId, query ?? undefined)
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [kbId, query]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;

    const context = canvas.getContext('2d');
    if (!context) return;

    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const centre = { x: width / 2, y: height / 2 };
    const scale = (Math.min(width, height) / 2.6) / spreadOf(data.points);

    // Painter's algorithm: far points first, so near ones overlap them.
    const drawn = data.points
      .map((point) => ({ point, screen: project(point, rotation, scale, centre) }))
      .sort((a, b) => a.screen.depth - b.screen.depth);

    for (const { point, screen } of drawn) {
      const near = (screen.depth + 1) / 2;
      context.globalAlpha = 0.35 + near * 0.6;
      context.fillStyle = MODALITY_COLOR[point.modality];
      context.beginPath();
      context.arc(screen.x, screen.y, hovered === point.chunkId ? 6 : 3 + near * 1.5, 0, Math.PI * 2);
      context.fill();
    }

    if (data.queryPoint) {
      const screen = project(data.queryPoint, rotation, scale, centre);
      const accent = token('--vermillion', '#c0462a');
      context.globalAlpha = 1;
      context.strokeStyle = accent;
      context.lineWidth = 1.5;
      context.beginPath();
      context.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
      context.stroke();
      // Crosshair: the query is distinguished by shape, so it stays legible
      // against any modality colour it happens to land on.
      context.beginPath();
      context.moveTo(screen.x - 13, screen.y);
      context.lineTo(screen.x - 4, screen.y);
      context.moveTo(screen.x + 4, screen.y);
      context.lineTo(screen.x + 13, screen.y);
      context.moveTo(screen.x, screen.y - 13);
      context.lineTo(screen.x, screen.y - 4);
      context.moveTo(screen.x, screen.y + 4);
      context.lineTo(screen.x, screen.y + 13);
      context.stroke();
      context.fillStyle = accent;
      context.font = "500 10px 'IBM Plex Mono', ui-monospace, monospace";
      context.fillText('query', screen.x + 15, screen.y + 3.5);
    }

    context.globalAlpha = 1;
  }, [data, rotation, hovered]);

  if (error) {
    return (
      <p className="mono-meta p-4" style={{ color: 'var(--vermillion)' }}>
        {error}
      </p>
    );
  }
  if (!data) return <p className="mono-meta p-4">projecting chunk vectors</p>;
  if (data.totalChunks === 0) {
    return <p className="mono-meta p-4">no indexed chunks to plot yet</p>;
  }

  return (
    <div className="flex h-full flex-col bg-paper">
      <canvas
        ref={canvasRef}
        className="min-h-0 w-full flex-1 cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          dragging.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
        onPointerMove={(event) => {
          const origin = dragging.current;
          if (!origin) {
            const canvas = canvasRef.current;
            if (!canvas || !data) return;
            const bounds = canvas.getBoundingClientRect();
            const centre = { x: bounds.width / 2, y: bounds.height / 2 };
            const scale = (Math.min(bounds.width, bounds.height) / 2.6) / spreadOf(data.points);
            const mouse = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };

            let nearest: { id: string; distance: number } | null = null;
            for (const point of data.points) {
              const screen = project(point, rotation, scale, centre);
              const distance = Math.hypot(screen.x - mouse.x, screen.y - mouse.y);
              if (distance < 8 && (!nearest || distance < nearest.distance)) {
                nearest = { id: point.chunkId, distance };
              }
            }
            setHovered(nearest?.id ?? null);
            return;
          }

          setRotation((previous) => ({
            yaw: previous.yaw + (event.clientX - origin.x) * 0.01,
            pitch: Math.max(
              -1.4,
              Math.min(1.4, previous.pitch + (event.clientY - origin.y) * 0.01),
            ),
          }));
          dragging.current = { x: event.clientX, y: event.clientY };
        }}
      />

      <div className="shrink-0 space-y-1 border-t border-rule px-4 py-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {Object.entries(MODALITY_COLOR).map(([modality, color]) => (
            <span key={modality} className="mono-meta flex items-center gap-1.5">
              <span
                className="inline-block h-[3px] w-4 rounded-full"
                style={{ backgroundColor: color }}
              />
              {modality}
            </span>
          ))}
          <span className="mono-meta ml-auto">
            {data.totalChunks} chunks · PCA 3 components ·{' '}
            {(data.explainedVariance.reduce((sum, value) => sum + value, 0) * 100).toFixed(0)}%
            variance · drag to rotate
          </span>
        </div>
        {hovered && (
          <p className="truncate text-xs text-ink-muted">
            {data.points.find((point) => point.chunkId === hovered)?.preview}
          </p>
        )}
      </div>
    </div>
  );
}
