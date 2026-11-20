import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('dist', { recursive: true });
const { metafile } = await build({
  entryPoints: ['src/content.ts', 'src/background.ts'],
  outdir: 'dist',
  platform: 'browser',
  target: 'chrome120',
  format: 'iife',
  bundle: true,
  minify: true,
  legalComments: 'linked',
  metafile: true,
  alias: { events: 'events/' },
});
await copyFile('manifest.json', 'dist/manifest.json');
await copyFile('LICENSE', 'dist/LICENSE');

const packageDirectories = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = [...input.matchAll(/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+/g)].at(-1);
  if (match) packageDirectories.add(input.slice(0, match.index + match[0].length));
}
const notices = [];
for (const directory of [...packageDirectories].sort()) {
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
  const documents = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(license|licence|copying|notice|copyright)/i.test(entry.name))
    .map(entry => entry.name).sort();
  if (!documents.length) throw new Error(`Falta el aviso de licencia de ${pkg.name}`);
  const contents = await Promise.all(documents.map(async file =>
    `${file}\n${(await readFile(`${directory}/${file}`, 'utf8')).trim()}`));
  notices.push(`${pkg.name}@${pkg.version} (${pkg.license})\n\n${contents.join('\n\n')}`);
}
await writeFile('dist/THIRD_PARTY_NOTICES.txt', notices.join('\n\n————————————————————————————————————————\n\n') + '\n');

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const repository = pkg.repository.url.replace(/^git\+|\.git$/g, '');
await writeFile('dist/SOURCE.txt', [
  `SGT · Ver firmas v${pkg.version}`,
  'Licencia GNU AGPL v3. Consultá LICENSE y THIRD_PARTY_NOTICES.txt.',
  `Código fuente y scripts de compilación: ${repository}/tree/v${pkg.version}`,
  'Peculiar PDF Core 2.0.1: https://github.com/PeculiarVentures/pdf/tree/v2.0.1',
  '',
].join('\n'));

const trust = JSON.parse(await readFile('trust/argentina.json', 'utf8'));
await mkdir('dist/crl', { recursive: true });
for (const { file } of trust.crls) await copyFile(`trust/crl/${file}`, `dist/crl/${file}`);
