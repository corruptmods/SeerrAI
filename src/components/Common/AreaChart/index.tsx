import { useId, useRef, useState } from 'react';

export interface AreaPoint {
  /** Epoch milliseconds. */
  t: number;
  /** Null where there is no reading: the line breaks there. */
  v: number | null;
}

interface AreaChartProps {
  points: AreaPoint[];
  /** Top of the scale. The bottom is always zero. */
  max: number;
  /** A level to mark across the chart, such as a limit. */
  reference?: { value: number; label: string };
  formatValue: (value: number) => string;
  formatTime: (t: number) => string;
  /** What the chart shows, for screen readers and its data table. */
  label: string;
  height?: number;
}

const WIDTH = 1000;

/** Runs of consecutive readings; a missing one starts a new run. */
const splitRuns = (points: AreaPoint[]): AreaPoint[][] => {
  const runs: AreaPoint[][] = [];
  let run: AreaPoint[] = [];
  for (const point of points) {
    if (point.v === null) {
      if (run.length) {
        runs.push(run);
      }
      run = [];
    } else {
      run.push(point);
    }
  }
  if (run.length) {
    runs.push(run);
  }
  return runs;
};

/**
 * One series over time as a line with a light wash beneath: the app's
 * indigo on its gray, hairline grid, and a readout that follows the pointer
 * (or the arrow keys). Values are also in a hidden table for screen readers.
 */
const AreaChart = ({
  points,
  max,
  reference,
  formatValue,
  formatTime,
  label,
  height = 128,
}: AreaChartProps) => {
  const frame = useRef<HTMLDivElement>(null);
  const tableId = useId();
  const [hover, setHover] = useState<number>();

  const first = points[0]?.t ?? 0;
  const last = points[points.length - 1]?.t ?? 1;
  const span = Math.max(1, last - first);
  const x = (t: number) => ((t - first) / span) * WIDTH;
  const y = (v: number) => height - (Math.min(v, max) / max) * height;

  const runs = splitRuns(points);

  const line = (run: AreaPoint[]) =>
    run.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)},${y(p.v as number)}`).join('');
  const area = (run: AreaPoint[]) =>
    `${line(run)}L${x(run[run.length - 1].t)},${height}L${x(run[0].t)},${height}Z`;

  const nearest = (clientX: number) => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !points.length) {
      return undefined;
    }
    const t = first + ((clientX - box.left) / box.width) * span;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) {
        best = i;
      }
    }
    return best;
  };

  const shown = hover !== undefined ? points[hover] : undefined;
  const latest = [...points].reverse().find((p) => p.v !== null);
  const marker = shown ?? latest;
  const markerLeft = marker ? (x(marker.t) / WIDTH) * 100 : 0;

  return (
    <div>
      <div
        ref={frame}
        className="relative touch-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        style={{ height }}
        // Arrow keys move the readout through time, as a slider would.
        role="slider"
        aria-label={label}
        aria-describedby={tableId}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, points.length - 1)}
        aria-valuenow={hover ?? Math.max(0, points.length - 1)}
        aria-valuetext={
          marker
            ? `${marker.v === null ? '–' : formatValue(marker.v)}, ${formatTime(marker.t)}`
            : undefined
        }
        tabIndex={0}
        onPointerMove={(e) => setHover(nearest(e.clientX))}
        onPointerDown={(e) => setHover(nearest(e.clientX))}
        onPointerLeave={() => setHover(undefined)}
        onBlur={() => setHover(undefined)}
        onKeyDown={(e) => {
          if (!points.length) {
            return;
          }
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault();
            const from = hover ?? points.length - 1;
            setHover(
              Math.max(
                0,
                Math.min(
                  points.length - 1,
                  from + (e.key === 'ArrowLeft' ? -1 : 1)
                )
              )
            );
          }
          if (e.key === 'Escape') {
            setHover(undefined);
          }
        }}
      >
        <svg
          className="absolute inset-0 h-full w-full overflow-visible"
          viewBox={`0 0 ${WIDTH} ${height}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {[0, 0.5, 1].map((f) => (
            <line
              key={f}
              x1={0}
              x2={WIDTH}
              y1={height * f}
              y2={height * f}
              className="stroke-gray-700"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {reference && reference.value <= max && (
            <line
              x1={0}
              x2={WIDTH}
              y1={y(reference.value)}
              y2={y(reference.value)}
              className="stroke-gray-400"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {runs.map((run) => (
            <g key={run[0].t}>
              <path d={area(run)} className="fill-indigo-500/10" />
              <path
                d={line(run)}
                fill="none"
                className="stroke-indigo-500"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ))}
        </svg>

        {/* Scale, in text colour: the top value and the reference level. */}
        <span className="pointer-events-none absolute left-1 top-0.5 text-[11px] text-gray-400">
          {formatValue(max)}
        </span>
        {reference && reference.value <= max && (
          <span
            className="pointer-events-none absolute right-1 -translate-y-full text-[11px] text-gray-300"
            style={{ top: y(reference.value) - 2 }}
          >
            {reference.label}
          </span>
        )}

        {shown && (
          <div
            className="pointer-events-none absolute bottom-0 top-0 w-px bg-gray-400"
            style={{ left: `${markerLeft}%` }}
          />
        )}
        {marker && marker.v !== null && (
          <div
            className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-500 ring-2 ring-gray-800"
            style={{ left: `${markerLeft}%`, top: y(marker.v) }}
          />
        )}
        {shown && (
          <div
            className={`pointer-events-none absolute top-0 z-10 whitespace-nowrap rounded-md border border-gray-700 bg-gray-900/95 px-2 py-1 text-xs shadow-lg ${
              markerLeft > 60 ? '-ml-2 -translate-x-full' : 'ml-2'
            }`}
            style={{ left: `${markerLeft}%` }}
          >
            <span className="font-semibold text-strong">
              {shown.v === null ? '–' : formatValue(shown.v)}
            </span>{' '}
            <span className="text-gray-400">{formatTime(shown.t)}</span>
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-gray-400">
        <span>{points.length ? formatTime(first) : ''}</span>
        <span>{points.length ? formatTime(last) : ''}</span>
      </div>

      <table id={tableId} className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {points
            .filter((p) => p.v !== null)
            .map((p) => (
              <tr key={p.t}>
                <th scope="row">{formatTime(p.t)}</th>
                <td>{formatValue(p.v as number)}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
};

export default AreaChart;
