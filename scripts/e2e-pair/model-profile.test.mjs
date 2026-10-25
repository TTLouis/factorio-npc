import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {definePair,freezePair,kitRoot} from './pair.mjs';
const repo=path.resolve(kitRoot,'../..');
const candidate=execFileSync('git',['-C',repo,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
const opts={candidate,published:'b'.repeat(40),imageId:'sha256:'+'c'.repeat(64)};
const luna={planner:'gpt-6-luna',executor:'gpt-6-luna',overwatch:'gpt-6-luna'};
test('explicit frozen role allowlist retains legacy default and rejects unapproved, missing or extra roles',()=>{
  assert.deepEqual(definePair(opts).models,{...luna,planner:'gpt-6.1-sol'});
  assert.deepEqual(definePair({...opts,models:luna}).models,luna);
  for(const models of [null,{}, {...luna,planner:'gpt-unknown'},{...luna,executor:'gpt-6.1-sol'},{...luna,overwatch:'gpt-6.1-sol'},{planner:luna.planner,executor:luna.executor},{...luna,extra:'gpt-6-luna'}])assert.throws(()=>definePair({...opts,models}),/Unapproved frozen/);
});
test('real Luna/Luna freezer binds Compose, lane intent, runtime-check modules and immutable manifests',async()=>{
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'paired-model-profile-'));
  try{
    const nativeDir=path.join(temp,'native');fs.mkdirSync(nativeDir);
    fs.writeFileSync(path.join(nativeDir,'info.json'),'{}\n');
    const nativeManifest=path.join(temp,'native.json');fs.writeFileSync(nativeManifest,JSON.stringify([{path:'info.json',sha256:crypto.createHash('sha256').update('{}\n').digest('hex')}]));
    const output=path.join(temp,'pair');freezePair({...opts,repo,output,nativeDir,nativeManifest,nativeBuildSource:candidate,models:luna});
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output,'pair.json'))).models,luna);
    for(const id of ['a','b']){
      const root=path.join(output,id), read=name=>fs.readFileSync(path.join(root,name),'utf8');
      assert.match(read('live.compose.yml'),/OPENAI_MODEL: "gpt-6-luna,gpt-6-luna"/);
      for(const file of ['lane.json','run-intent.json']){const value=JSON.parse(read(file));assert.deepEqual(value.models,luna);assert.equal(value.overwatchReasoning,'low');}
      const frozen=await import(pathToFileURL(path.join(root,'frozen-models.mjs')));assert.deepEqual(frozen.frozenModels,luna);assert.equal(frozen.overwatchReasoning,'low');
      for(const name of ['verify-deployment.mjs','supervisor-preflight.mjs','run-live.mjs']){assert.match(read(name),/from '.\/frozen-models.mjs'/);assert.doesNotMatch(read(name),/gpt-6\.1-sol/);}
      const manifest=JSON.parse(read('helper-manifest.json'));assert.ok(manifest.some(e=>e.path==='frozen-models.mjs'));
    }
    execFileSync('pwsh',['-NoProfile','-Command',`. '${path.join(output,'pair-common.ps1').replaceAll("'","''")}'; Assert-PairFrozen`]);
    fs.appendFileSync(path.join(output,'a/frozen-models.mjs'),'\n// unreviewed model drift\n');
    assert.throws(()=>execFileSync('pwsh',['-NoProfile','-Command',`. '${path.join(output,'pair-common.ps1').replaceAll("'","''")}'; Assert-PairFrozen`],{stdio:'pipe'}));
  }finally{fs.rmSync(temp,{recursive:true,force:true});}
});
