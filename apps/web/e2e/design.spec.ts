import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Controls keep the project's 34px minimum (above WCAG 2.2 AA's 24px target size). */
async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tiny = await page.locator('button:visible, summary:visible, .g-button:visible').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect(); return rect.width < 33 || rect.height < 33;
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
  expect(await response?.text()).toContain('Mira de cerca.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mira de cerca. Decide con pruebas.');
  await expect(page.locator('body')).not.toContainText(/ilustración conceptual|ejemplo ilustrativo|no es un análisis en vivo|cambiar de pestaña solo|cargando/i);
  await expect(page.locator('.g-page img')).toHaveCount(0);
  await expect(page.locator('.g-hero-mark .g-ascii')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => document.fonts.check('700 48px "Gotchu Display"'))).toBe(true);
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

test('the 3D mark turns toward the pointer and closes on the primary action', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Pointer following is exercised with a fine pointer.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const canvas = page.locator('.g-hero-mark canvas');
  await expect(page.locator('.g-hero-mark .g-ascii')).toHaveAttribute('data-ready', 'true');
  const frame = () => canvas.evaluate(element => element instanceof HTMLCanvasElement ? element.toDataURL() : '');
  await page.mouse.move(1400, 880);
  await page.waitForTimeout(700);
  const resting = await frame();
  await page.mouse.move(20, 120);
  await expect.poll(frame).not.toBe(resting);
  const turned = await frame();
  await page.getByRole('link', { name: 'Revisar mi aplicación', exact: true }).hover();
  await expect.poll(frame).not.toBe(turned);
  await checkLayout(page);
});

test('scrolling separates the perspectives, closes them on a finding and brings the report without trapping the page', async ({ page, isMobile }) => {
  test.skip(isMobile, 'The pinned sequence runs on roomy screens; small screens keep the stacked layout.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const stage = page.locator('.g-stage');
  await expect(stage).toHaveAttribute('data-live', 'true');
  const opacity = (selector: string) => page.locator(selector).evaluate(element => Number(getComputedStyle(element).opacity));
  await expect.poll(() => opacity('.g-stage-report')).toBe(0);
  await stage.evaluate(element => window.scrollTo(0, element.offsetTop + (element.offsetHeight - innerHeight) * .52));
  await expect.poll(() => opacity('.g-stage-flash')).toBeGreaterThan(.5);
  await stage.evaluate(element => window.scrollTo(0, element.offsetTop + element.offsetHeight - innerHeight));
  await expect.poll(() => opacity('.g-stage-report')).toBeGreaterThan(.95);
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeVisible();
  await expect(page.locator('.g-report-card')).toContainText('Lo que se revisó y lo que quedó fuera');
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
  await expect(page.locator('.g-hero-mark .g-ascii')).toHaveAttribute('data-ready', 'true');
  await page.locator('#perspectivas').scrollIntoViewIfNeeded();
  await page.getByRole('tab', { name: 'HTTPS', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toContainText('sin compartir el código fuente');
  expect(await page.locator('.g-hero-scan').evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeAttached();
  await checkLayout(page); await checkA11y(page);
});

test('the product journey presents source versioning, DNS authorization and persisted report capabilities', async ({ page, isMobile }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const steps = [
    { id: 'codigo', title: 'Instantánea de código', text: 'Huella SHA-256' },
    { id: 'https', title: 'Origen HTTPS', text: '_gotchu.<dominio>' },
    { id: 'evidencia', title: 'Informe de evaluación', text: 'Lo revisado y lo que quedó fuera' },
  ];
  for (const [index, step] of steps.entries()) {
    await page.locator(`#${step.id}`).evaluate(element => window.scrollTo(0, element.getBoundingClientRect().top + scrollY - innerHeight * .25));
    const flow = isMobile ? page.locator(`#${step.id} .g-mobile-flow`) : page.locator('.g-journey-visual .g-product-flow');
    await expect(flow).toHaveAttribute('data-step', String(index));
    await expect(flow.getByRole('heading', { name: step.title, exact: true })).toBeVisible();
    await expect(flow).toContainText(step.text);
  }
  await expect(page.locator('.g-workflow')).toContainText('Cada revisión, en su lugar');
  await expect(page.locator('.g-workflow')).toContainText('Llévate los datos contigo');
  await expect(page.getByRole('link', { name: 'Ir a mis aplicaciones', exact: true })).toHaveAttribute('href', '/dashboard');
  await page.locator('.g-workflow').scrollIntoViewIfNeeded();
  await checkLayout(page); await checkA11y(page);
});

test('the headline and primary CTA remain usable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  await page.goto(baseURL ?? 'http://127.0.0.1:3085/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Decide con pruebas.');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revisar mi aplicación', exact: true })).toHaveAttribute('href', '/dashboard');
  await context.close();
});

test('the header tucks away while scrolling down and returns when scrolling up', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const header = page.locator('.g-header');
  await expect(page.locator('.g-hero-mark .g-ascii')).toHaveAttribute('data-ready', 'true');
  for (const step of [400, 400, 400]) { await page.evaluate(distance => scrollBy(0, distance), step); await page.waitForTimeout(80); }
  await expect(header).toHaveClass(/is-tucked/);
  await page.evaluate(() => scrollBy(0, -300));
  await expect(header).not.toHaveClass(/is-tucked/);
  await expect(page.getByRole('link', { name: 'Gotchu, inicio' })).toBeInViewport();
});
