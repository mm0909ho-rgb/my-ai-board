import './check.mjs';
import './check-detail-navigation.mjs';
import { mkdirSync, copyFileSync } from 'node:fs';

mkdirSync('dist/assets', { recursive: true });
copyFileSync('index.html', 'dist/index.html');
copyFileSync('assets/app.js', 'dist/assets/app.js');
copyFileSync('assets/dashboard.css', 'dist/assets/dashboard.css');
console.log('Static site built in dist/.');
