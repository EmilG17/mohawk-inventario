import { chromium } from '@playwright/test';

const routes = ['/', '/#/contar', '/#/movimientos', '/#/catalogo', '/#/reporte', '/#/equipo', '/#/ajustes'];
const widths = [320, 360, 393, 1280];
const browser = await chromium.launch();
let issues = 0;
for (const w of widths) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  for (const r of routes) {
    await page.goto('http://localhost:4173' + r);
    await page.waitForTimeout(500);
    const res = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
      const emptyPaths = [...document.querySelectorAll('svg.ico path')].filter((p) => !p.getAttribute('d')).length;
      const visibleHidden = [...document.querySelectorAll('[hidden]')].filter((e) => getComputedStyle(e).display !== 'none').length;
      return { overflow, emptyPaths, visibleHidden, sw: document.documentElement.scrollWidth };
    });
    const bad = res.overflow || res.emptyPaths || res.visibleHidden;
    if (bad) issues++;
    console.log(`${w}px ${r.padEnd(14)} ${bad ? 'FAIL' : 'ok'} ${JSON.stringify(res)}`);
  }
  if (errors.length) { issues++; console.log(`${w}px console errors:`, errors.slice(0, 5)); }
  await ctx.close();
}
await browser.close();
console.log(issues ? `ISSUES=${issues}` : 'ALL CLEAN');
