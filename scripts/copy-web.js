#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'www');
const entries = ['index.html', 'css', 'js'];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const entry of entries) {
  fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
}
console.log(`Copied ${entries.join(', ')} to ${path.relative(root, out)}/`);
