import { chromium } from 'playwright';
const url = process.argv[2];


(async () => {
    const b = await chromium.launch(), p = await b.newPage({ ignoreHTTPSErrors: true });
    await p.coverage.startJSCoverage({ reportAnonymousScripts: true });
    p.on('console', m => console.log(m.text()));
    p.on('pageerror', e => console.error('PAGE ERROR:', e.message));
    await p.goto('file://' + process.cwd() + '/' + url + '?test=1');
    await p.waitForFunction(() => window.TESTS_DONE, { timeout: 30000 });
    const c = await p.coverage.stopJSCoverage(), e = c.find(x => x.url.includes(url));
    if (e) {
        const s = e.source.split('\\n'), n = s.length, o = [0];
        for (let i = 0; i < n; i++)
            o.push(o[i] + s[i].length + 1);
        const u = new Set();
        for (const f of e.functions)
            for (const r of f.ranges)
                if (!r.count)
                    for (let i = 0; i < n; i++)
                        if (r.startOffset < o[i + 1] && r.endOffset > o[i])
                            u.add(i);

        console.log('Lines: ' + (n - u.size) + '/' + n + ' (' + (100 * (n - u.size) / n).toFixed(1) + '%)');
        const uf = e.functions.filter(f => f.functionName && f.ranges.every(r => !r.count));
        if (uf.length) console.log('Uncovered:\\n' + uf.map(f => '  ' + f.functionName).join('\\n'))
    }
    await b.close()
})();

