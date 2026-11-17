import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, link, symlink, rename } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import * as P from '../vendor/security-node/node-security.js'
import { createInterface } from 'node:readline'
import { windowsPython, windowsPythonCandidates } from '../vendor/security-node/windows-paths.mjs'
import { ApiKeyStore } from '../lib/api-keys-store.js'
import { NodeRuntime } from '../lib/node-runtime.js'

test('desktop Electron and managed runtime both resolve bundled Python', {skip:process.platform !== 'win32'}, () => {
  const desktop=windowsPythonCandidates('C:/Apps/DeepSeek Harness/DeepSeek Harness.exe', {DSH_HOME:'C:/Private/dsh'}, 'C:/Users/test')
  assert.ok(desktop.includes(path.normalize('C:/Private/dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe')))
  assert.ok(desktop.includes(path.normalize('C:/Apps/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/python/python.exe')))
})

test('Windows runtime prepares real broker and pairing without Unix-only dependencies', {skip:process.platform !== 'win32'}, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(),'dsh-win-node-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  const workspace = path.join(dir,'workspace'); await mkdir(workspace)
  const keys = new ApiKeyStore('',path.join(dir,'home'));await keys.ensureReady()
  const key = await keys.create({name:'test'})
  const runtime = new NodeRuntime({dir:path.join(dir,'private'),keyStore:keys,getRoots:()=>[workspace],getDshRef:async()=>({baseUrl:'https://fixture.example/api/v1',apiKey:key.plaintext,mappingId:'fixture'})})
  t.after(()=>runtime.close())
  await runtime.prepare()
  assert.equal(runtime.status().running,true)
  assert.equal(runtime.status().isolation.available,false)
  const ticket=await runtime.createPairing()
  assert.match(ticket.pairingCode,/^wbpair1\./)
  const pin=JSON.parse(Buffer.from(ticket.pairingCode.slice(8),'base64url').toString())
  const server=createServer((req,res)=>{if(!runtime.handle(req,res)){res.writeHead(404);res.end()}})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>{server.closeAllConnections();server.close()})
  const client=new P.NodeSecurityClient({baseUrl:'http://127.0.0.1:'+server.address().port,pin,allowLoopbackHttp:true})
  const issuer=generateKeyPairSync('ed25519')
  assert.equal((await client.identity()).nodeId,ticket.nodeId)
  const paired=await client.control('pair',{secret:pin.secret,userId:'user-1'},issuer.privateKey)
  assert.deepEqual(paired.roots,[workspace])
  const resolved=await client.control('catalog/resolve',{path:workspace},issuer.privateKey)
  assert.equal(resolved.path,workspace)
  await assert.rejects(client.control('catalog/resolve',{path:dir},issuer.privateKey))
})

test('Windows broker reads files while denying traversal streams and writes', {skip:process.platform !== 'win32'}, async t=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-win-broker-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  await writeFile(path.join(dir,'hello.txt'),'hello')
  const child=spawn(await windowsPython(),['-I',path.resolve('vendor/security-node/security-node-windows.py')],{stdio:['pipe','pipe','pipe'],windowsHide:true})
  t.after(()=>child.kill())
  const pending=new Map();let seq=0
  createInterface({input:child.stdout}).on('line',line=>{const data=JSON.parse(line);pending.get(data.id)?.(data)})
  child.stderr.on('data',data=>console.error(data.toString()))
  const call=req=>new Promise(resolve=>{const id=++seq;pending.set(id,resolve);child.stdin.write(JSON.stringify({...req,id})+'\n')})
  const ws={workspaceId:'test',nodeId:'node',root:dir,policyVersion:1}
  assert.equal((await call({op:'init',workspaces:[ws]})).ok,true)
  const request=(op,p)=>({op,claims:{...ws,expiresAt:Date.now()+10000,paths:['.'],actions:['file.read','file.list','file.write']},payload:{path:p},leaseExpiresAt:Date.now()+10000})
  const read=await call(request('read','hello.txt'));assert.equal(read.ok,true);assert.equal(Buffer.from(read.result.contentBase64,'base64').toString(),'hello')
  for(const p of ['../escape','hello.txt:secret','CON','a\\b'])assert.equal((await call(request('read',p))).ok,false)
  assert.equal((await call(request('write','hello.txt'))).error,'WINDOWS_READ_ONLY')
  await link(path.join(dir,'hello.txt'),path.join(dir,'hardlink.txt'))
  assert.equal((await call(request('read','hardlink.txt'))).ok,false)
  await mkdir(path.join(dir,'ordinary'))
  await symlink(path.join(dir,'ordinary'),path.join(dir,'junction'),'junction')
  assert.equal((await call(request('list','junction'))).ok,false)
  try {
    await rename(dir,dir+'-moved')
    await mkdir(dir)
    assert.equal((await call(request('list','.'))).ok,false)
    await rm(dir,{recursive:true})
    await rename(dir+'-moved',dir)
  } catch(error) { if(!['EPERM','EACCES','EBUSY'].includes(error.code)) throw error }
  const expired=request('read','hello.txt');expired.leaseExpiresAt=Date.now()-1
  assert.equal((await call(expired)).error,'AUTH_EXPIRED')
  child.stdin.end();await new Promise(resolve=>child.once('close',resolve))
})
