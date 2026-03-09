const { chromium } = require('playwright');
(async () => {
    const b = await chromium.launch();
    const p = await b.newPage();
    await p.setContent('<div><h1>My title</h1></div>');
    console.time('eval');
    try {
        await p.locator('div[role="main"]').filter({ has: p.locator('h1') }).last().evaluate(el => el.textContent).catch(e => console.log('caught', e.message));
    } finally {
        console.timeEnd('eval');
        await b.close();
    }
})();
