// Renders the project headlessly: opens the Motion Canvas editor and presses its Render button.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tools/render.mjs [http://localhost:9010]
const pw = await import(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');
const url = process.argv[2] ?? 'http://localhost:9010/';
const browser = await pw.chromium.launch({headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
const page = await browser.newPage({viewport: {width: 1600, height: 1000}});
page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().split('\n')[0]); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForTimeout(4000);
await page.screenshot({path: process.env.SHOT ?? 'output/editor.png'});
if (process.env.ONLY_SHOT) { await browser.close(); process.exit(0); }
// The rendering panel: the "Video settings" tab, then RENDER.
const buttons = await page.locator('button').allInnerTexts();
console.log('buttons:', buttons.filter(Boolean).join(' | '));
await page.getByRole('button', {name: /render/i}).first().click();
const t0 = Date.now();
for (;;) {
  await page.waitForTimeout(5000);
  const txt = (await page.locator('button').allInnerTexts()).join(' | ');
  console.log(`${Math.round((Date.now() - t0) / 1000)} s`, txt.match(/(RENDER|ABORT|STOP)[^|]*/gi)?.join(' ') ?? '');
  if (!/abort|stop/i.test(txt) && Date.now() - t0 > 15000) break;
  if (Date.now() - t0 > 30 * 60 * 1000) break;
}
await browser.close();
