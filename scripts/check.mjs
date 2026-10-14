import { readFileSync, existsSync } from 'node:fs';
import { Script } from 'node:vm';
import assert from 'node:assert/strict';

const html = readFileSync('index.html', 'utf8');
let count = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const source = match[1].match(/\bsrc=["']([^"']+)["']/i)?.[1];
  if (source) {
    assert(!source.includes('..') && !source.includes(':'), `Unexpected script path: ${source}`);
    assert(existsSync(source), `Missing script: ${source}`);
    new Script(readFileSync(source, 'utf8'), { filename: source });
  } else if (match[2].trim()) {
    new Script(match[2], { filename: `index.html:inline-${count}` });
  }
  count++;
}
assert(html.includes('id="root"'), 'Missing React mount point');
assert(html.includes('src="assets/app.js"'), 'Missing application script');
console.log(`Validated ${count} script blocks and application entry point.`);
