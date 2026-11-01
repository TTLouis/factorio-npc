import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const release=path.dirname(await fs.realpath('/opt/sgluna/start-sgluna.sh'));
const expected=JSON.parse(await fs.readFile('/e2e/expected-native-mod.json','utf8'));
const mismatches=[];
const files=async(dir,prefix='')=>{const out=[];for(const entry of await fs.readdir(path.join(dir,prefix),{withFileTypes:true})){const rel=path.join(prefix,entry.name);if(entry.isDirectory())out.push(...await files(dir,rel));else out.push(rel.replaceAll('\\','/'));}return out;};
const actual=await files(path.join(release,'autorio'));
const expectedPaths=expected.map(e=>e.path);
for(const file of actual)if(!expectedPaths.includes(file))mismatches.push(`unexpected:${file}`);
for(const file of expectedPaths)if(!actual.includes(file))mismatches.push(`missing:${file}`);
for(const e of expected) {
 const content=await fs.readFile(path.join(release,'autorio',e.path));
 const text=/\.(lua|json)$/.test(e.path)||e.path==='LICENSE';
 const digest=crypto.createHash('sha256').update(text?content.toString('utf8').replaceAll('\r',''):content).digest('hex');
 if(digest!==e.sha256)mismatches.push(e.path);
}
console.log(JSON.stringify({native_mod_files:actual.length,expected_native_mod_files:expected.length,mismatches}));
if(mismatches.length)process.exitCode=1;
