import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const [expectedPath, modRoot, outputPath] = process.argv.slice(2);
const expected = JSON.parse(await fs.readFile(expectedPath, 'utf8')).sort((a, b) => a.path.localeCompare(b.path));
const files = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) files.push(full);
  }
}
await walk(modRoot);
const actual = [];
for (const file of files.sort()) {
  const bytes = await fs.readFile(file);
  const relative = path.relative(modRoot, file).split(path.sep).join('/');
  const normalizeText = /\.(lua|json)$/.test(relative) || relative === 'LICENSE';
  actual.push({
    path: relative,
    sha256: createHash('sha256').update(normalizeText ? bytes.toString('utf8').replaceAll('\r', '') : bytes).digest('hex'),
    raw_sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
actual.sort((a, b) => a.path.localeCompare(b.path));
const normalizedActual = actual.map(({ path, sha256 }) => ({ path, sha256 }));
const proof = {
  expected_count: expected.length,
  actual_count: actual.length,
  exact_paths_and_normalized_content: normalizedActual.length === expected.length && normalizedActual.every((item, index) => item.path === expected[index].path && item.sha256 === expected[index].sha256),
  raw_active_files_copied_for_load: true,
  expected,
  actual,
};
await fs.writeFile(outputPath, `${JSON.stringify(proof, null, 2)}\n`);
if (!proof.exact_paths_and_normalized_content) throw new Error('active mod files do not match paired lane expected manifest');
