import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const readSource = async name => (await readFile(path.join(root, name), 'utf8')).replace(/\r\n/g, '\n');
const css = await readSource('src/styles.css');
const stripModule = text => text.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
const modules = await Promise.all(['core', 'instagram', 'storage', 'demo', 'ui'].map(async name => stripModule(await readSource(`src/${name}.mjs`))));
const bundle = demo => `(() => {\n'use strict';\n${modules.join('\n')}\nstartApp({ css: ${JSON.stringify(css)}, demo: ${demo} });\n})();\n`;
await mkdir(path.join(root, 'dist'), { recursive: true });
const production = bundle(false);
const safeScript = value => value.replace(/<\/script/gi, '<\\/script');
const demo = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Unfollow Studio · Interactive demo</title><style>body{margin:0;background:#f6f8f7;font-family:system-ui}noscript{display:block;padding:40px}</style></head><body><noscript>Enable JavaScript to use this demo.</noscript><script type="text/plain" id="production-code">${safeScript(production)}</script><script>${safeScript(bundle(true))}</script></body></html>`;
for (const [name, content] of [['dist/instagram-unfollow.js', production], ['dist/instagram-unfollow.txt', production], ['demo.html', demo]]) {
  if (process.argv.includes('--check')) {
    if (await readFile(path.join(root, name), 'utf8') !== content) throw new Error(`${name} is out of date. Run npm run build.`);
  } else await writeFile(path.join(root, name), content);
}
console.log(process.argv.includes('--check') ? 'Build artifacts match the source.' : 'Built: dist/instagram-unfollow.js, dist/instagram-unfollow.txt, demo.html');