import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tiny = await page.locator('button:visible, summary:visible, .g-button:visible').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect(); return rect.width < 43 || rect.height < 43;
  }).map(element => element.outerHTML.slice(0, 140)));
  expect(tiny).toEqual([]);
}
async function checkA11y(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
}

test('landing is server-rendered without a loader, fabricated results or explanatory artwork captions', async ({ page }, info) => {
  const errors: string[] = []; const apiRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  expect(await response?.text()).toContain('Tu código.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tu código.Tu web.Bajo la misma lupa.');
  await expect(page.locator('body')).not.toContainText(/ilustración conceptual|ejemplo ilustrativo|no es un análisis en vivo|cambiar de pestaña solo|cargando/i);
  await expect(page.locator('.g-stage img')).toHaveCount(2);
  expect(await page.locator('.g-page img').evaluateAll(images => images.every(image => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0))).toBe(true);
  expect(await page.evaluate(() => document.fonts.check('500 48px Oxanium'))).toBe(true);
  await checkLayout(page); await checkA11y(page);
  expect(errors).toEqual([]); expect(apiRequests).toEqual([]);
  await page.screenshot({ path: info.outputPath('hero.png') });
});

test('scope controls work with pointer and keyboard, retaining valid panel relationships', async ({ page }, info) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Ambas', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-both');
  await expect(page.getByRole('tabpanel')).toContainText('Comparación de hallazgos');
  await page.getByRole('tab', { name: 'Ambas', exact: true }).press('Home');
  await expect(page.getByRole('tab', { name: 'Código', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'HTTPS', exact: true })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-https');
  await page.keyboard.press('End');
  await expect(page.getByRole('tabpanel')).toHaveAttribute('id', 'panel-both');
  await checkLayout(page); await checkA11y(page);
  await page.screenshot({ path: info.outputPath('perspectives.png') });
});

test('menu, anchor navigation, FAQ and dashboard CTAs retain native accessible behavior', async ({ page, isMobile }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  if (isMobile) {
    const menu = page.getByRole('button', { name: 'Menú', exact: true }); await menu.click();
    await expect(page.getByRole('button', { name: 'Cerrar', exact: true })).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('link', { name: 'Preguntas', exact: true }).focus(); await page.keyboard.press('Escape');
    await expect(menu).toBeFocused(); await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await menu.click();
  }
  await page.getByRole('link', { name: 'Preguntas', exact: true }).click();
  expect(new URL(page.url()).hash).toBe('#preguntas');
  const disclosure = page.locator('summary').first(); await disclosure.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('details').first()).toHaveAttribute('open', '');
  await expect(page.locator('details').first().locator('p')).toBeVisible();
  await checkA11y(page);
  const ctas = await page.locator('.g-button').evaluateAll(elements => elements.map(element => element.getAttribute('href')));
  expect(ctas.length).toBeGreaterThan(1); expect(ctas.every(href => href === '/dashboard')).toBe(true);
});

test('the lens follows the pointer and narrows its iris on the primary action', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Pointer following is exercised with a fine pointer.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const body = page.locator('.g-hero-lens .g-lens-body');
  const blade = page.locator('.g-hero-lens .g-lens-face path[d^="M"]').last();
  await page.mouse.move(40, 40);
  await expect.poll(() => body.evaluate(element => element.style.transform)).toMatch(/rotateX\(\d/);
  const open = await blade.getAttribute('d');
  await page.getByRole('link', { name: 'Revisar mi aplicación', exact: true }).hover();
  await expect.poll(() => blade.getAttribute('d')).not.toBe(open);
  await checkLayout(page);
});

test('scrolling draws code and web into the lens and returns the report without trapping the page', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The pinned sequence runs on roomy screens; small screens keep the stacked layout.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const stage = page.locator('.g-stage');
  await expect(stage).toHaveAttribute('data-live', 'true');
  const report = page.locator('.g-stage-report');
  await expect.poll(() => report.evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
  await stage.evaluate(element => window.scrollTo(0, element.offsetTop + element.offsetHeight - innerHeight));
  await expect.poll(() => report.evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.95);
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeVisible();
  await expect.poll(() => page.locator('.g-hero-slab').evaluate(element => Number(getComputedStyle(element).opacity))).toBe(0);
  await page.locator('.g-footer').scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Gotchu, volver al inicio' })).toBeVisible();
});

test('scroll narrative tracks chapters and does not trap page scrolling', async ({ page, isMobile }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  for (const [index, id] of ['codigo', 'https', 'evidencia'].entries()) {
    await page.locator(`#${id}`).evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * .25));
    if (!isMobile) await expect(page.locator('.g-journey-visual .g-product-flow')).toHaveAttribute('data-step', String(index));
  }
  await page.locator('.g-footer').scrollIntoViewIfNeeded();
  await expect(page.getByRole('link', { name: 'Gotchu, volver al inicio' })).toBeVisible();
  await checkLayout(page);
});

test('reduced motion and a 320px viewport retain all content without pointer or scroll parallax', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('.g-stage')).toHaveAttribute('data-live', 'false');
  await expect.poll(() => page.locator('.g-hero-lens .g-lens-body').evaluate(element => getComputedStyle(element).transform)).toBe('none');
  await page.locator('#perspectivas').scrollIntoViewIfNeeded();
  await page.getByRole('tab', { name: 'HTTPS', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('sin compartir el código fuente');
  expect(await page.locator('.g-word-code').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeAttached();
  await checkLayout(page); await checkA11y(page);
});

test('the product journey presents source versioning, DNS authorization and persisted report capabilities', async ({ page, isMobile }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const steps = [
    { id: 'codigo', title: 'Instantánea de código', text: 'Huella SHA-256' },
    { id: 'https', title: 'Origen HTTPS', text: '_gotchu.<dominio>' },
    { id: 'evidencia', title: 'Informe de evaluación', text: 'Extracto, herramienta y checksum' },
  ];
  for (const [index, step] of steps.entries()) {
    await page.locator(`#${step.id}`).evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * .25));
    const flow = isMobile ? page.locator(`#${step.id} .g-mobile-flow`) : page.locator('.g-journey-visual .g-product-flow');
    await expect(flow).toHaveAttribute('data-step', String(index));
    await expect(flow.getByRole('heading', { name: step.title, exact: true })).toBeVisible();
    await expect(flow).toContainText(step.text);
  }
  await expect(page.locator('.g-workflow')).toContainText('Historial de evaluaciones');
  await expect(page.locator('.g-workflow')).toContainText('Exportación JSON');
  await expect(page.getByRole('link', { name: 'Ir a mis aplicaciones', exact: true })).toHaveAttribute('href', '/dashboard');
  await page.locator('.g-workflow').scrollIntoViewIfNeeded();
  await checkLayout(page); await checkA11y(page);
});

test('the headline and primary CTA remain usable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  await page.goto(baseURL ?? 'http://127.0.0.1:3085/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Bajo la misma lupa.');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revisar mi aplicación', exact: true })).toHaveAttribute('href', '/dashboard');
  await context.close();
});
