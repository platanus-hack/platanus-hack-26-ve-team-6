import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssessmentProgress } from '../src/components/assessment-progress';

describe('assessment progress evidence', () => {
  it('keeps evaluation and report pending until the worker confirms them', () => {
    const queued = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'queued' }));
    expect(queued.match(/data-state="done"/g)).toHaveLength(1);
    expect(queued.match(/data-state="pending"/g)).toHaveLength(2);
    const running = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'running' }));
    expect(running).toContain('aria-current="step"');
    expect(running).toContain('data-state="running"');
    expect(running).not.toContain('Informe disponible');
  });
  it('does not claim a persisted report merely because execution succeeded', () => {
    const withoutReport = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'succeeded', reportAvailable: false }));
    expect(withoutReport.match(/data-state="done"/g)).toHaveLength(2);
    expect(withoutReport).toContain('Evaluación terminada');
    const withReport = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'succeeded', reportAvailable: true }));
    expect(withReport.match(/data-state="done"/g)).toHaveLength(3);
    expect(withReport).toContain('Informe disponible');
  });
  it('preserves failure and uncertainty instead of advancing the graph', () => {
    const failed = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'failed' }));
    expect(failed).toContain('data-state="failed"');
    expect(failed).not.toContain('Informe disponible');
    const unavailable = renderToStaticMarkup(createElement(AssessmentProgress, { status: 'unavailable' }));
    expect(unavailable).toContain('Estado sin confirmar');
    expect(unavailable).not.toContain('data-state="done"');
    expect(unavailable).not.toContain('data-state="failed"');
  });
});
