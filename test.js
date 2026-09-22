import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createCoverageReport } from './coverage.js';
import { startServer } from './server.js';

function isCoverageEntryForTarget(entry, pageUrl) {
    try {
        const entryUrl = new URL(entry.url);
        entryUrl.search = '';
        entryUrl.hash = '';
        pageUrl = new URL(pageUrl);
        pageUrl.search = '';
        pageUrl.hash = '';
        return entryUrl.href === pageUrl.href;
    } catch {
        return false;
    }
}

async function run(target = process.argv[2]) {
    if (!target)
        throw new Error('Usage: node test.js <target.html>');

    const absoluteTarget = path.resolve(target);
    const relativeTarget = path.relative(process.cwd(), absoluteTarget);
    if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget))
        throw new Error('The test target must be inside the current working directory');
    const fileSource = await readFile(absoluteTarget, 'utf8');
    let browser;
    let server;

    try {
        server = await startServer(0);
        const { port } = server.address();
        const route = relativeTarget.split(path.sep).map(encodeURIComponent).join('/');
        const pageUrl = new URL(route, `http://localhost:${port}/`);
        pageUrl.searchParams.set('test', '1');

        browser = await chromium.launch();
        const page = await browser.newPage({ ignoreHTTPSErrors: true });
        await page.coverage.startJSCoverage({ reportAnonymousScripts: true });
        page.on('console', message => console.log(message.text()));
        page.on('pageerror', error => console.error('PAGE ERROR:', error.message));
        await page.goto(pageUrl.href);
        await page.waitForFunction(() => window.TESTS_DONE, { timeout: 30000 });

        const coverage = await page.coverage.stopJSCoverage();
        const entry = coverage.find(item => isCoverageEntryForTarget(item, pageUrl));
        const displayPath = path.relative(process.cwd(), absoluteTarget).split(path.sep).join('/') || path.basename(absoluteTarget);
        const { report, summary } = createCoverageReport(displayPath, fileSource, entry, {
            width: process.stdout.columns || 120,
        });
        console.log(report);
        return summary;
    } finally {
        server?.close();
        await browser?.close();
    }
}

run().catch(error => {
    console.error(`Coverage error: ${error.message}`);
    process.exitCode = 1;
});

