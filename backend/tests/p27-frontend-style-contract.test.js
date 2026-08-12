const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const frontendRoot = path.resolve(__dirname, '../../frontend');
const cssPath = path.join(frontendRoot, 'src/index.css');
const tradeLogPath = path.join(frontendRoot, 'src/pages/TradeLog.tsx');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test('P27 CSS references only defined tokens and local fonts', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const defined = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/gi)].map((match) => match[1]));
  const referenced = new Set([...css.matchAll(/var\(--([a-z0-9-]+)/gi)].map((match) => match[1]));
  assert.deepEqual([...referenced].filter((token) => !defined.has(token)), []);
  assert.doesNotMatch(css, /@import\s+(?:url\()?['"]?https?:/i);
});

test('P27 static className values resolve to a real stylesheet selector', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  const defined = new Set([...css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)]
    .map((match) => match[1]));
  const unresolved = [];
  for (const file of walk(path.join(frontendRoot, 'src')).filter((name) => /\.(tsx|jsx)$/.test(name))) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/className="([^"]+)"/g)) {
      for (const className of match[1].split(/\s+/).filter(Boolean)) {
        if (!defined.has(className)) unresolved.push(`${path.relative(frontendRoot, file)}:${className}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
});

test('P27 framed surfaces stay at eight pixels and keyboard focus is visible', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  for (const token of ['radius-md', 'radius-lg', 'radius-modal']) {
    const match = css.match(new RegExp(`--${token}:\\s*(\\d+)px`));
    assert.ok(match, `${token} must be defined in pixels`);
    assert.ok(Number(match[1]) <= 8, `${token} exceeds 8px`);
  }
  assert.match(css, /:focus-visible/);
});

test('P27 signal match details preserve complete long addresses on mobile', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.signal-match-panel\s*,\s*\.signal-match-panel\s*>\s*div\s*\{[^}]*min-width:\s*0/si);
  assert.match(css, /\.signal-match-detail\s*\{[^}]*white-space:\s*normal[^}]*overflow-wrap:\s*anywhere/si);
  assert.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*?\.signal-match-detail\s*\{[^}]*display:\s*block[^}]*margin-left:\s*0/si);
});

test('P27 trade detail modal wraps complete transaction hashes', () => {
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.detail-link\s*\{[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/si);
  assert.match(css, /\.detail-link\s+svg\s*\{[^}]*flex:\s*0\s+0\s+auto/si);
  assert.match(css, /\.modal-content\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/si);
});

test('P27 trade detail modal exposes keyboard-accessible dialog semantics', () => {
  const source = fs.readFileSync(tradeLogPath, 'utf8');
  assert.match(source, /role="dialog"\s+aria-modal="true"\s+aria-labelledby="trade-attempt-dialog-title"/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /ref=\{detailCloseRef\}[\s\S]*?aria-label="关闭交易详情"/);
});
