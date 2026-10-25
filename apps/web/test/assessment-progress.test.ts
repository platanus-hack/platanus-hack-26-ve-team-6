import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AssessmentProgress } from '../src/components/assessment-progress';
import type { CustomerJob } from '../src/components/customer-client';

const job = (state: CustomerJob['state'], overrides: Partial<CustomerJob> = {}): CustomerJob => ({
  id: '6f1b9f0e-6d0c-4a59-9f43-2e1c6c4c2a10', applicationId: '0b8a3c6e-5a52-4e43-9c1d-7f0d1f3a2b11', kind: 'audit', state,
  reportId: null, reasonCode: null, mode: 'external', inputKind: null, createdAt: '2026-10-25T10:00:00.000Z', completedAt: null,
  progress: state === 'queued' ? [] : [{ phase: 'validating', at: '2026-10-25T10:00:01.000Z' }, { phase: 'analyzing', at: '2026-10-25T10:00:02.000Z' }],
  ...overrides,
});
const render = (props: Partial<Parameters<typeof AssessmentProgress>[0]>) => renderToStaticMarkup(createElement(AssessmentProgress, {
  purpose: 'assessment', job: undefined, mode: 'external', failure: null, error: null, retry: () => undefined, ...props,
}));
const count = (markup: string, state: string) => markup.match(new RegExp(`customer-progress-node is-${state}`, 'g'))?.length ?? 0;

describe('assessment phase graph markup', () => {
  it('does not reuse a previous completion while a new request is being registered', () => {
    const submitting = render({ waiting: 'submitting' });
    expect(submitting).toContain('Registrando solicitud');
    expect(submitting).toContain('aria-busy="true"');
    expect(count(submitting, 'done')).toBe(0);
  });

  it('draws a single HTTPS analysis as one line with nothing to correlate', () => {
    const running = render({ job: job('running') });
    expect(running).toContain('data-phase="external"');
    expect(running).not.toContain('data-phase="internal"');
    expect(running).not.toContain('data-phase="correlation"');
    expect(running).toContain('aria-current="step"');
    const both = render({ job: job('running', { mode: 'both' }) });
    expect(both).toContain('data-phase="internal"');
    expect(both).toContain('data-phase="correlation"');
  });

  it('keeps later phases pending until the coordinator records them', () => {
    const queued = render({ job: job('queued') });
    expect(count(queued, 'running')).toBe(1);
    expect(count(queued, 'pending')).toBe(3);
    expect(count(queued, 'done')).toBe(0);
  });

  it('does not claim a stored report merely because execution succeeded', () => {
    const withoutReport = render({ job: job('succeeded', { completedAt: '2026-10-25T10:00:09.000Z' }) });
    expect(withoutReport).toContain('Sin informe guardado');
    expect(count(withoutReport, 'done')).toBe(3);
    const withReport = render({ job: job('succeeded', { completedAt: '2026-10-25T10:00:09.000Z', reportId: '9d5c7f43-1b56-4f0a-8a35-6c2b47e1d8a2' }) });
    expect(count(withReport, 'done')).toBe(4);
  });

  it('shows where a failure stopped and does not advance an unconfirmed status', () => {
    const failed = render({ job: job('failed', { reasonCode: 'assessment_reconciliation_required' }), failure: 'La evaluación no finalizó.' });
    expect(count(failed, 'failed')).toBe(1);
    expect(failed).toContain('La evaluación no finalizó.');
    const unavailable = render({ error: 'No se pudo consultar el estado.' });
    expect(unavailable).toContain('Estado sin confirmar');
    expect(count(unavailable, 'done')).toBe(0);
    expect(count(unavailable, 'failed')).toBe(0);
  });

  it('stops animating and says so when the scanner has been silent past its deadline', () => {
    const long = job('running', { mode: 'both', createdAt: '2020-01-01T00:00:00.000Z', progress: [{ phase: 'validating', at: '2020-01-01T00:00:01.000Z' }, { phase: 'analyzing', at: '2020-01-01T00:00:02.000Z' }] });
    const stalled = render({ job: long });
    expect(stalled).toContain('Sin noticias del analizador');
    expect(stalled).toContain('is-stalled');
    expect(stalled.match(/Sin respuesta/g)).toHaveLength(2);
    const fresh = render({ job: job('running', { mode: 'both', createdAt: new Date().toISOString(), progress: [{ phase: 'analyzing', at: new Date().toISOString() }, { phase: 'internal_finished', at: new Date().toISOString() }] }) });
    expect(fresh).not.toContain('Sin noticias del analizador');
    expect(fresh).toContain('Esperando externo');
  });
});
