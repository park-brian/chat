function splitLines(source) {
    let offset = 0;
    return source.split(/(?<=\r?\n)/u).map((text, index) => {
        const start = offset;
        const end = start + text.length - (text.match(/\r?\n$/u)?.[0].length ?? 0);
        offset += text.length;
        return { number: index + 1, start, end, count: start === end ? 1 : 0 };
    });
}

function summarize(source, functions, lineOffset) {
    const lines = splitLines(source);

    // Match Node's behavior: only a range covering a complete line changes it.
    for (const fn of functions) {
        for (const range of fn.ranges) {
            for (const line of lines) {
                if (range.endOffset <= line.start) break;
                if (range.startOffset <= line.start && range.endOffset >= line.end)
                    line.count = range.count;
            }
        }
    }

    const uncoveredLines = lines
        .filter(line => line.count === 0)
        .map(line => line.number + lineOffset);
    const branches = functions.filter(fn => fn.isBlockCoverage).flatMap(fn => fn.ranges);
    const coveredBranches = branches.filter(range => range.count !== 0).length;
    const coveredFunctions = functions.slice(1).filter(fn => fn.ranges[0]?.count !== 0).length;
    const percent = (covered, total) => total === 0 ? 100 : covered / total * 100;

    return {
        linePercent: percent(lines.length - uncoveredLines.length, lines.length),
        branchPercent: percent(coveredBranches, branches.length),
        functionPercent: percent(coveredFunctions, Math.max(0, functions.length - 1)),
        uncoveredLines,
    };
}

function findLineOffset(fileSource, scriptSource) {
    const file = fileSource.replace(/\r\n?/gu, '\n');
    const script = scriptSource.replace(/\r\n?/gu, '\n');
    const offset = file.indexOf(script);
    if (offset === -1)
        throw new Error('Unable to map the covered script back to the target file');
    return file.slice(0, offset).split('\n').length - 1;
}

function compressLines(lines) {
    const ranges = [];
    for (let index = 0; index < lines.length;) {
        const start = lines[index];
        let end = start;
        while (lines[index + 1] === end + 1) end = lines[++index];
        ranges.push(start === end ? `${start}` : `${start}-${end}`);
        index++;
    }
    return ranges.join(',');
}

function wrapRanges(value, width) {
    if (!value) return [''];
    const lines = [];
    let current = '';
    for (const range of value.split(',')) {
        const next = current ? `${current},${range}` : range;
        if (current && next.length > width) {
            lines.push(current);
            current = range;
        } else {
            current = next;
        }
    }
    lines.push(current);
    return lines;
}

function formatReport(file, summary, maxWidth) {
    const headers = ['file', 'line %', 'branch %', 'funcs %', 'uncovered lines'];
    const percentages = [
        summary.linePercent.toFixed(2),
        summary.branchPercent.toFixed(2),
        summary.functionPercent.toFixed(2),
    ];
    const widths = [
        Math.max(headers[0].length, file.length, 'all files'.length),
        ...headers.slice(1, 4).map((header, index) => Math.max(header.length, percentages[index].length)),
    ];
    const uncoveredWidth = Math.max(headers[4].length, maxWidth - widths.reduce((sum, width) => sum + width, 0) - 12);
    const uncoveredRows = wrapRanges(compressLines(summary.uncoveredLines), uncoveredWidth);
    widths.push(Math.max(headers[4].length, ...uncoveredRows.map(row => row.length)));

    const formatRow = cells => cells.map((cell, index) =>
        index === 0 || index === 4 ? cell.padEnd(widths[index]) : cell.padStart(widths[index]))
        .join(' | ')
        .trimEnd();
    const separator = '-'.repeat(widths.reduce((sum, width) => sum + width, 0) + 12);
    const fileRows = uncoveredRows.map((uncovered, index) => index === 0
        ? [file, ...percentages, uncovered]
        : ['', '', '', '', uncovered]);

    return [
        'ℹ start of coverage report',
        `ℹ ${separator}`,
        `ℹ ${formatRow(headers)}`,
        `ℹ ${separator}`,
        ...fileRows.map(row => `ℹ ${formatRow(row)}`),
        `ℹ ${separator}`,
        `ℹ ${formatRow(['all files', ...percentages, ''])}`,
        `ℹ ${separator}`,
        'ℹ end of coverage report',
    ].join('\n');
}

export function createCoverageReport(file, fileSource, entry, { width = 120 } = {}) {
    if (!entry?.source)
        throw new Error(`No JavaScript coverage was found for ${file}`);
    const summary = summarize(entry.source, entry.functions, findLineOffset(fileSource, entry.source));
    return { summary, report: formatReport(file, summary, width) };
}
