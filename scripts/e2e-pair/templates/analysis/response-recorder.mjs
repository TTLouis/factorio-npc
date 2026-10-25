import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib'

// Host-only evidence tap. Never persist authorization/request headers or
// explicit provider reasoning fields. Ordinary assistant content is retained verbatim.
export function responseRecorder({ port=@@RECORDER_PORT@@, upstreamPort=@@TUNNEL_PORT@@, evidenceFile, host='127.0.0.1' }={}) {
  let sequence=0
  let recordingErrors=0
  const connections=new Set()
  const record=row=>{
    try { fs.appendFileSync(evidenceFile, JSON.stringify(row)+'\n', {encoding:'utf8',mode:0o600}) }
    catch { recordingErrors++ }
  }
  const server=http.createServer((request,response)=>{
    if(request.url==='/__e2e_recorder_health') {
      response.writeHead(200,{'content-type':'application/json'})
      response.end(JSON.stringify({ok:recordingErrors===0,recording_errors:recordingErrors,requests:sequence}))
      return
    }
    const capture=request.method==='POST' && new URL(request.url,'http://localhost').pathname.endsWith('/chat/completions')
    const id=++sequence
    const started=new Date().toISOString()
    const start=performance.now()
    const requestChunks=[]
    const bodyHash=createHash('sha256')
    const upstream=http.request({hostname:'127.0.0.1',port:upstreamPort,path:request.url,method:request.method,
      headers:{...request.headers,host:`127.0.0.1:${upstreamPort}`}},incoming=>{
      const chunks=[]
      response.writeHead(incoming.statusCode,incoming.headers)
      incoming.on('data',chunk=>{if(capture)chunks.push(chunk)})
      incoming.pipe(response)
      incoming.on('end',()=>{
        if(!capture)return
        let payload={}
        try { payload=JSON.parse(Buffer.concat(requestChunks).toString('utf8')) } catch {}
        const base={schema:1,event:'capture.response',tap_request_id:`tap_${id}`,started,ts:new Date().toISOString(),
          elapsed_ms:performance.now()-start,model:payload.model,stream:payload.stream??false,
          request_body_sha256:bodyHash.digest('hex'),status:incoming.statusCode}
        try {
          let bytes=Buffer.concat(chunks)
          const encoding=incoming.headers['content-encoding']
          if(encoding==='gzip')bytes=gunzipSync(bytes)
          if(encoding==='deflate')bytes=inflateSync(bytes)
          if(encoding==='br')bytes=brotliDecompressSync(bytes)
          const raw=JSON.parse(bytes.toString('utf8'))
          record({...base,response_id:raw.id,reported_model:raw.model,usage:raw.usage,
            choices:Array.isArray(raw.choices)?raw.choices.map(choice=>({index:choice.index,finish_reason:choice.finish_reason,
              message:choice.message?Object.fromEntries(Object.entries(choice.message).filter(([key])=>['role','content','tool_calls','refusal'].includes(key))):undefined})):[],
            error:raw.error?{type:raw.error.type,code:raw.error.code}:undefined,
            captured_response_bytes:bytes.length,complete:true})
        } catch {
          recordingErrors++
          record({...base,complete:false,capture_error:'response_json_unavailable'})
        }
      })
    })
    request.on('data',chunk=>{if(capture){requestChunks.push(chunk);bodyHash.update(chunk)}})
    upstream.on('error',()=>{
      if(capture)record({schema:1,event:'capture.upstream_error',tap_request_id:`tap_${id}`,started,ts:new Date().toISOString(),error:'upstream_connection_failed'})
      if(!response.headersSent)response.writeHead(502,{'content-type':'application/json'})
      response.end('{"error":{"type":"upstream_connection_failed"}}')
    })
    request.on('aborted',()=>upstream.destroy())
    response.on('close',()=>{if(!response.writableFinished)upstream.destroy()})
    request.pipe(upstream)
  })
  server.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))})
  return {server,connections,listen:()=>new Promise((resolve,reject)=>{
    server.once('error',reject)
    server.listen(port,host,()=>{server.off('error',reject);resolve()})
  })}
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const evidenceFile=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data/logs/provider-full-responses.jsonl')
  fs.mkdirSync(path.dirname(evidenceFile),{recursive:true})
  const recorder=responseRecorder({evidenceFile})
  await recorder.listen()
  fs.writeFileSync(path.resolve(path.dirname(evidenceFile),'recorder-ready.json'),JSON.stringify({pid:process.pid,ts:new Date().toISOString(),port:@@RECORDER_PORT@@,loopback_only:true})+'\n')
  const stop=()=>{recorder.server.close();for(const socket of recorder.connections)socket.destroy()}
  process.on('SIGTERM',stop)
  process.on('SIGINT',stop)
}
