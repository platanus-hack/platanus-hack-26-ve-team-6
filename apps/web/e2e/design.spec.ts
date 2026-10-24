import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Controls keep the project's 34px minimum (above WCAG 2.2 AA's 24px target size). */
async function checkLayout(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const tiny = await page.locator('button:visible, [data-slot="button"]:not([class*="underline"]):visible').evaluateAll(elements => elements.filter(element => {
    const rect = element.getBoundingClientRect(); return rect.width < 33 || rect.height < 33;
  }).map(element => element.outerHTML.slice(0, 140)));
  expect(tiny).toEqual([]);
}
async function checkA11y(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  expect(result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) }))).toEqual([]);
}
/** Scrolls through the page so every scroll reveal settles before an audit. */
async function revealAll(page: Page) {
  await page.evaluate(async () => {
    for (let y = 0; y < document.documentElement.scrollHeight; y += 400) { scrollTo(0, y); await new Promise(resolve => setTimeout(resolve, 60)); }
    await new Promise(resolve => setTimeout(resolve, 1200));
  });
}
const background = (page: Page) => page.locator('.gl').first().evaluate(element => getComputedStyle(element).backgroundColor);

test('landing is server-rendered without a loader, fabricated results or explanatory artwork captions', async ({ page }, info) => {
  const errors: string[] = []; const apiRequests: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url()); });
  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response?.status()).toBe(200);
  expect(await response?.text()).toContain('Mira de cerca.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mira de cerca. Decide con pruebas.');
  await expect(page.locator('body')).not.toContainText(/ilustración conceptual|ejemplo ilustrativo|no es un análisis en vivo|cargando/i);
  await expect(page.locator('.g-page img')).toHaveCount(0);
  await expect(page.locator('.gl-hero-field .g-dot-plate')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => document.fonts.check('700 48px "Gotchu Display"'))).toBe(true);
  await checkLayout(page); await checkA11y(page);
  expect(errors).toEqual([]); expect(apiRequests).toEqual([]);
  await page.screenshot({ path: info.outputPath('hero.png') });
});

test('the theme switch moves between pure white, pure black and the system preference, and persists', async ({ page, isMobile }, info) => {
  test.setTimeout(90_000);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/', { waitUntil: 'networkidle' });
  const group = page.getByRole('group', { name: 'Tema' }).first();
  if (!(await group.isVisible())) await page.getByRole('button', { name: 'Menú', exact: true }).click();
  const theme = page.getByRole('group', { name: 'Tema' }).locator('visible=true');
  await expect(theme.getByRole('button', { name: 'Tema del sistema' })).toHaveAttribute('aria-pressed', 'true');
  expect(await background(page)).toBe('rgb(255, 255, 255)');

  await theme.getByRole('button', { name: 'Tema oscuro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await background(page)).toBe('rgb(0, 0, 0)');
  if (isMobile) {
    const darkSwitches = page.locator('.gl-theme [aria-label="Tema oscuro"]');
    await expect(darkSwitches).toHaveCount(2);
    await expect(darkSwitches.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(darkSwitches.nth(1)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // The stored choice is applied before paint on the next visit, over the system preference.
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await revealAll(page);
  await checkA11y(page);
  await page.screenshot({ path: info.outputPath('dark.png') });

  // Back to "system": it follows the operating system as that changes.
  await page.evaluate(() => scrollTo(0, 0));
  await expect(page.locator('.gl-header')).not.toHaveClass(/is-tucked/);
  if (!(await group.isVisible())) await page.getByRole('button', { name: 'Menú', exact: true }).click();
  const visibleTheme = page.getByRole('group', { name: 'Tema' }).locator('visible=true');
  await visibleTheme.getByRole('button', { name: 'Tema claro' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  if (isMobile) {
    const lightSwitches = page.locator('.gl-theme [aria-label="Tema claro"]');
    await expect(lightSwitches).toHaveCount(2);
    await expect(lightSwitches.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(lightSwitches.nth(1)).toHaveAttribute('aria-pressed', 'true');
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await visibleTheme.getByRole('button', { name: 'Tema del sistema' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('the mobile menu fits its links, keeps focus inside, and closes on the backdrop', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'The sheet is only shown below 900px.');
  await page.goto('/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Menú', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const sheetHeight = await dialog.evaluate(element => element.getBoundingClientRect().height);
  expect(sheetHeight).toBeLessThan(await page.evaluate(() => innerHeight));

  const menuLink = dialog.getByRole('link', { name: 'Cómo funciona', exact: true });
  expect(await menuLink.evaluate(element => getComputedStyle(element).fontFamily)).toContain('Gotchu Text');
  await dialog.getByRole('button', { name: 'Cerrar' }).focus();
  await page.keyboard.press('Tab');
  await expect(menuLink).toBeFocused();

  await page.mouse.click(12, 830);
  await expect(dialog).toBeHidden();
});

test('the light theme passes the accessibility audit after every reveal', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/', { waitUntil: 'networkidle' });
  await revealAll(page);
  await checkA11y(page);
});

test('menu, anchor navigation, FAQ and dashboard CTAs keep accessible behavior', async ({ page, isMobile }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  if (isMobile) {
    const menu = page.getByRole('button', { name: 'Menú', exact: true });
    await menu.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await expect(menu).toBeFocused();
    await menu.click();
    await page.getByRole('dialog').getByRole('link', { name: 'Preguntas', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  } else {
    await page.getByRole('banner').getByRole('link', { name: 'Preguntas', exact: true }).click();
  }
  expect(new URL(page.url()).hash).toBe('#gl-preguntas');

  const first = page.getByRole('button', { name: '¿Tengo que compartir mi código?' });
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await first.focus(); await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Puedes revisar el origen HTTPS de un dominio que controles')).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-expanded', 'false');

  const primary = page.getByRole('link', { name: 'Revisar mi aplicación', exact: true });
  await expect(primary).toHaveAttribute('href', '/dashboard');
  await expect(page.getByRole('link', { name: 'Empezar mi revisión', exact: true })).toHaveAttribute('href', '/dashboard');
  await checkLayout(page);
});

test('the dot fields follow the pointer, gather on the primary action and pause on request', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Pointer following is exercised with a fine pointer.');
  await page.goto('/', { waitUntil: 'networkidle' });
  const plate = page.locator('.gl-hero-field .g-dot-plate');
  await expect(plate).toHaveAttribute('data-ready', 'true');
  const frame = () => plate.locator('canvas').evaluate(element => element instanceof HTMLCanvasElement ? element.toDataURL() : '');
  await page.waitForTimeout(2500);
  const box = await plate.boundingBox();
  if (!box) throw new Error('The hero field has no box.');
  const resting = await frame();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 });
  await expect.poll(frame).not.toBe(resting);
  await page.getByRole('link', { name: 'Revisar mi aplicación', exact: true }).hover();
  await page.waitForTimeout(300);
  const gathering = await frame();
  await expect.poll(frame).not.toBe(gathering);

  const pause = page.getByRole('button', { name: 'Pausar animación' });
  await pause.click();
  await expect(page.getByRole('button', { name: 'Reanudar animación' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(200);
  const still = await frame();
  await page.mouse.move(box.x + 40, box.y + 40, { steps: 8 });
  await page.waitForTimeout(400);
  expect(await frame()).toBe(still);
});

test('reduced motion and a 320px viewport keep all content and drop the pause control', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('.gl-hero-field .g-dot-plate')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Pausar animación' })).toHaveCount(0);
  expect(await page.locator('.gl-display--hero .gl-line-in').first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeAttached();
  const plateWidths = await page.locator('.gl-plate').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
  expect(plateWidths.every(width => width <= 320)).toBe(true);
  await checkLayout(page); await checkA11y(page);
});

test('the headline, sections and primary CTA remain usable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false }); const page = await context.newPage();
  await page.goto(baseURL ?? 'http://127.0.0.1:3085/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Decide con pruebas.');
  await expect(page.getByRole('heading', { name: /Cada hallazgo/ })).toBeVisible();
  await expect(page.getByText('Sin hallazgos significa que esa revisión no produjo hallazgos')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Revisar mi aplicación', exact: true })).toHaveAttribute('href', '/dashboard');
  await context.close();
});

test('the header tucks away while scrolling down and returns when scrolling up', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  const header = page.locator('.gl-header');
  await expect(page.locator('.gl-hero-field .g-dot-plate')).toHaveAttribute('data-ready', 'true');
  for (const step of [400, 400, 400]) { await page.evaluate(distance => scrollBy(0, distance), step); await page.waitForTimeout(80); }
  await expect(header).toHaveClass(/is-tucked/);
  await page.evaluate(() => scrollBy(0, -300));
  await expect(header).not.toHaveClass(/is-tucked/);
  await expect(page.getByRole('link', { name: 'Gotchu, inicio' }).first()).toBeInViewport();
});
