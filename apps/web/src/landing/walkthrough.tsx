import { useState } from 'react';
import { FileDiffIcon, GitPullRequestDraftIcon, KeyRoundIcon, RefreshCwIcon, ScanSearchIcon } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { FIX_STEPS, INTERVALS, REVIEWS, SOURCES } from './copy';
import { useReveal } from './editorial';

/** Each review against the sources it can read; the pixels fill row by row when the chart scrolls in. */
export function ReviewMatrix() {
  const ref = useReveal<HTMLTableElement>('0px 0px -20% 0px');
  return <table ref={ref} className="gl-matrix">
    <caption className="gl-sr">Revisiones por fuente</caption>
    <thead>
      <tr><th scope="col"><span className="gl-sr">Revisión</span></th>{SOURCES.map(source => <th scope="col" key={source}>{source}</th>)}</tr>
    </thead>
    <tbody>
      {REVIEWS.map((review, row) => <tr key={review.name}>
        <th scope="row"><span className="gl-matrix-name">{review.name}</span><span className="gl-matrix-detail">{review.detail}</span></th>
        {SOURCES.map((source, column) => {
          const reads = review.sources.includes(source);
          return <td key={source} data-reads={reads || undefined} style={{ '--gl-i': row * SOURCES.length + column }}>
            <span className="gl-pixel" aria-hidden="true" />
            <span className="gl-sr">{reads ? 'Sí' : 'No'}</span>
          </td>;
        })}
      </tr>)}
    </tbody>
  </table>;
}

const FIX_ICONS = [ScanSearchIcon, FileDiffIcon, RefreshCwIcon, KeyRoundIcon, GitPullRequestDraftIcon];

/** The private-fix path as a track: the finding travels along it and lights each step as it passes. */
export function FixTrack() {
  const ref = useReveal<HTMLDivElement>('0px 0px -25% 0px');
  return <div ref={ref} className="gl-track" style={{ '--gl-steps': FIX_STEPS.length }}>
    <span className="gl-track-rail" aria-hidden="true"><span className="gl-track-diamond" /></span>
    <ol>{FIX_STEPS.map(([title, detail], index) => {
      const Icon = FIX_ICONS[index] ?? ScanSearchIcon;
      return <li key={title} style={{ '--gl-i': index }}>
        <span className="gl-track-node" aria-hidden="true"><Icon /></span>
        <div><h3>{title}</h3><p>{detail}</p></div>
      </li>;
    })}</ol>
  </div>;
}

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** One day of scheduled re-checks; the visitor picks the interval and the day redraws. */
export function IntervalDay() {
  const [interval, setIntervalHours] = useState<(typeof INTERVALS)[number]>(6);
  const runs = 24 / interval;
  return <figure className="gl-day">
    <div className="gl-day-controls" role="group" aria-label="Intervalo entre revisiones">
      {INTERVALS.map(hours => <Toggle key={hours} variant="outline" pressed={interval === hours} onPressedChange={pressed => { if (pressed) setIntervalHours(hours); }}>
        {hours} h
      </Toggle>)}
    </div>
    <ol className="gl-day-strip" aria-hidden="true">
      {HOURS.map(hour => <li key={hour} data-run={hour % interval === 0 || undefined} style={{ '--gl-i': hour }} />)}
    </ol>
    <div className="gl-day-axis" aria-hidden="true">{[0, 6, 12, 18, 24].map(hour => <span key={hour}>{String(hour).padStart(2, '0')}:00</span>)}</div>
    <figcaption aria-live="polite"><strong>{runs}</strong> {runs === 1 ? 'revisión' : 'revisiones'} al día</figcaption>
  </figure>;
}
