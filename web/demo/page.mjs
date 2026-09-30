// Turns the preview build into the one self-contained page published as the
// claude.ai artifact: the app's styles and script inlined, nothing else to load.
//
//     npm run build:demo      writes demo-dist/vision-bot-pro.html
import {readFileSync, writeFileSync} from 'node:fs';

const dist = new URL('../demo-dist/', import.meta.url);
const css = readFileSync(new URL('demo.css', dist), 'utf8');
const js = readFileSync(new URL('demo.js', dist), 'utf8');
// Inlined, a literal closing tag would end the element early.
if (/<\/style/i.test(css) || /<\/script/i.test(js)) throw new Error('The build contains a closing tag and cannot be inlined as is.');

// The publisher wraps this in the document skeleton, so it starts with the
// title and styles rather than <html>.
writeFileSync(new URL('vision-bot-pro.html', dist),
  `<title>Vision-Bot-Pro</title>\n<style>${css}</style>\n<div id="app"></div>\n<script type="module">${js}</script>\n`);
console.log('demo-dist/vision-bot-pro.html');
