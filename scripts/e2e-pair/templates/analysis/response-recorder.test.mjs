import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { responseRecorder } from './response-recorder.mjs'

test('opaque forwarding preserves complete large plans/tool arguments, compressed responses, status and body bytes; headers/reasoning are not logged',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'recorder-'))
  const file=path.join(dir,'capture.jsonl')
  const requestBody=JSON.stringify({model:'fixture-planner',stream:false,messages:[{role:'user',content:'fixture'}]})
  const output=JSON.stringify({id:'fixture-response',model:'fixture-planner',usage:{prompt_tokens:10,completion_tokens:20},choices:[{index:0,finish_reason:'tool_calls',message:{role:'assistant',content:'P'.repeat(9000),tool_calls:[{id:'call1',type:'function',function:{name:'submitPlan',arguments:'A'.repeat(17000)}}],reasoning_content:'NEVER_PERSIST_REASONING'}}]})
  const encoded=gzipSync(output)
  const upstream=http.createServer(async(req,res)=>{
    const chunks=[]
    for await(const chunk of req)chunks.push(chunk)
    assert.equal(Buffer.concat(chunks).toString(),requestBody)
    assert.equal(req.headers.authorization,'Bearer TEST_ONLY_HEADER')
    res.writeHead(201,{'content-type':'application/json','content-encoding':'gzip','x-fixture':'unchanged'})
    res.end(encoded)
  })
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
  const tap=responseRecorder({port:0,upstreamPort:upstream.address().port,evidenceFile:file})
  await tap.listen()
  try {
    const response=await fetch(`http://127.0.0.1:${tap.server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer TEST_ONLY_HEADER','content-type':'application/json'},body:requestBody})
    assert.equal(response.status,201)
    assert.equal(response.headers.get('x-fixture'),'unchanged')
    assert.equal(await response.text(),output)
    const logged=await fs.readFile(file,'utf8')
    assert.ok(!logged.includes('TEST_ONLY_HEADER') && !logged.includes('NEVER_PERSIST_REASONING'))
    const row=JSON.parse(logged)
    assert.equal(row.complete,true)
    assert.equal(row.choices[0].message.content.length,9000)
    assert.equal(row.choices[0].message.tool_calls[0].function.arguments.length,17000)
    assert.equal(row.request_body_sha256,createHash('sha256').update(requestBody).digest('hex'))
    assert.equal(row.captured_response_bytes,Buffer.byteLength(output))
  }finally{
    tap.server.closeAllConnections();upstream.closeAllConnections()
    await Promise.all([new Promise(resolve=>tap.server.close(resolve)),new Promise(resolve=>upstream.close(resolve))])
    await fs.rm(dir,{recursive:true,force:true})
  }
})
