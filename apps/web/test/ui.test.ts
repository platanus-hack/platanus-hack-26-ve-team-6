import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { Brand, Button, LoadingState, Notice, Status, UiIcon } from '../src/components/ui';

describe('shared design primitives', () => {
  it('defaults standalone actions to type=button but preserves explicit form submission', () => {
    expect(renderToStaticMarkup(createElement(Button, null, 'Guardar'))).toContain('type="button"');
    expect(renderToStaticMarkup(createElement(Button, { type: 'submit' }, 'Guardar'))).toContain('type="submit"');
  });
  it('keeps pending actions disabled and announces busy state', () => {
    const html = renderToStaticMarkup(createElement(Button, { busy: true, variant: 'primary' }, 'Guardando…'));
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
  });
  it('does not discard caller-specified disabled state', () => {
    expect(renderToStaticMarkup(createElement(Button, { disabled: true, busy: false }, 'No autorizado'))).toContain('disabled=""');
  });
  it('retains readable semantic labels instead of using color alone', () => {
    expect(renderToStaticMarkup(createElement(Status, { tone: 'unknown', children: 'Sin comprobar' }))).toContain('Sin comprobar');
    expect(renderToStaticMarkup(createElement(Notice, { tone: 'danger', title: 'Sin conexión', children: 'Reintenta.' }))).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(LoadingState, { label: 'Cargando informe…' }))).toContain('role="status"');
  });
  it('makes decorative icons silent and the brand link explicit', () => {
    expect(renderToStaticMarkup(createElement(UiIcon, { name: 'grid' }))).toContain('aria-hidden="true"');
    expect(renderToStaticMarkup(createElement(Brand))).toContain('aria-label="Gotchu, inicio"');
  });
});
