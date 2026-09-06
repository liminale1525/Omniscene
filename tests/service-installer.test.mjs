import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository='https://github.com/Liminale-art/qianmuwanxiang-V2-Directors-Cut.git';
const project=fileURLToPath(new URL('../',import.meta.url));
const win=process.platform==='win32';
const powershell=win?path.join(path.dirname(process.execPath),'../../native/powershell/pwsh.exe'):'pwsh';
const bash=win?'C:/Program Files/Git/bin/bash.exe':'sh';
const original='port: 8000\nenableServerPlugins: false # keep this\nother: preserved\n';
async function command(binary,args,{cwd,env={}}={}) {
  const child=spawn(binary,args,{cwd,env:{...process.env,...env},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{output+=bytes;});
  return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>resolve({code,output}));});
}
async function fixture(t,{docker=false,config=original}={}) {
  const parent=await fs.realpath(os.tmpdir()),root=await fs.mkdtemp(path.join(parent,'qianmu-installer-test-'));
  const st=path.join(root,'ST installation space'),origin=path.join(root,'origin'),empty=path.join(root,'empty-git-config');
  await fs.mkdir(st);await fs.mkdir(origin);await fs.writeFile(empty,'');
  const configFile=path.join(st,docker?'config/config.yaml':'config.yaml');
  if(docker){await fs.mkdir(path.join(st,'config'));await fs.writeFile(path.join(st,'compose.yaml'),'services:\n  sillytavern:\n    volumes:\n      - "./plugins:/home/node/app/plugins"\n');}
  await fs.writeFile(configFile,config);const data=path.join(st,'data');await fs.mkdir(data);await fs.writeFile(path.join(data,'old-user-data'),'keep legacy data');
  const env={GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:empty,GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:`url.${pathToFileURL(origin).href}.insteadOf`,GIT_CONFIG_VALUE_0:repository,
    GIT_ALLOW_PROTOCOL:'file',GIT_TERMINAL_PROMPT:'0',QIANMU_SERVER_STOPPED:'1'};
  const git=async(...args)=>{const result=await command('git',args,{cwd:origin,env});assert.equal(result.code,0,result.output);return result.output.trim();};
  await git('init','--initial-branch=codex/install-test');await git('config','user.name','Installer Test');await git('config','user.email','installer@example.invalid');
  await git('config','commit.gpgsign','false');await fs.writeFile(path.join(origin,'package.json'),JSON.stringify({name:'qianmu-omniscene',version:'1.0.0',main:'server-plugin.js'}));
  await fs.writeFile(path.join(origin,'server-plugin.js'),'export const testVersion=1;\n');await git('add','.');await git('commit','-m','isolated fixture');
  const head=await git('rev-parse','HEAD');
  t.after(async()=>{const real=await fs.realpath(root);assert.equal(path.dirname(real),parent);assert.match(path.basename(real),/^qianmu-installer-test-/);await fs.rm(real,{recursive:true});});
  return {root,st,origin,configFile,env,git,head,data,plugin:path.join(st,'plugins','Omniscene')};
}
async function run(f,engine,extra={},before='') {
  const script=path.join(project,engine==='powershell'?'install-server-plugin.ps1':'install-server-plugin.sh');
  return command(engine==='powershell'?powershell:bash,engine==='powershell'?['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${before}; & '${script.replaceAll("'","''")}'`]
    : before?['-c',`${before}\n. "$QM_INSTALL_SCRIPT"`]:[script],{cwd:f.st,env:{...f.env,QM_INSTALL_SCRIPT:script,...extra}});
}
const backups=async f=>(await fs.readdir(path.dirname(f.configFile))).filter(name=>/^config\.yaml\.qianmu-backup\./.test(name)&&!name.endsWith('.ref'));
// Both shells are exercised on Windows; other CI hosts run their native sh path.
for(const engine of win?['powershell','shell']:['shell']) {
  test(`${engine}: real local Git install enables only the intended key after code is ready`,async t=>{
    const f=await fixture(t),result=await run(f,engine);assert.equal(result.code,0,result.output);
    assert.equal(await fs.readFile(f.configFile,'utf8'),original.replace('false','true'));
    const [backup]=await backups(f);assert.equal(await fs.readFile(path.join(path.dirname(f.configFile),backup),'utf8'),original);
    assert.equal(await fs.readFile(path.join(f.data,'old-user-data'),'utf8'),'keep legacy data');
    assert.equal(await f.git('-C',f.plugin,'rev-parse','HEAD'),f.head);assert.match(result.output,/不会停止或重启|没有重启容器/);
  });
  test(`${engine}: updating retains unique original backup and records the exact prior commit`,async t=>{
    const f=await fixture(t);assert.equal((await run(f,engine)).code,0);const first=await backups(f);
    await fs.writeFile(path.join(f.origin,'server-plugin.js'),'export const testVersion=2;\n');await f.git('add','.');await f.git('commit','-m','next fixture');
    const result=await run(f,engine);assert.equal(result.code,0,result.output);const names=await backups(f);assert.equal(names.length,2);
    assert.equal(await fs.readFile(path.join(path.dirname(f.configFile),first[0]),'utf8'),original);
    const later=names.find(name=>!first.includes(name));assert.equal((await fs.readFile(path.join(path.dirname(f.configFile),later+'.ref'),'utf8')).trim(),f.head);
    assert.match(await fs.readFile(path.join(f.plugin,'server-plugin.js'),'utf8'),/testVersion=2/);
  });
  test(`${engine}: offline clone cannot enable config or leave a partial plugin in the loader directory`,async t=>{
    const f=await fixture(t),result=await run(f,engine,{GIT_CONFIG_KEY_0:`url.${pathToFileURL(path.join(f.root,'missing-origin')).href}.insteadOf`});
    assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);await assert.rejects(fs.stat(f.plugin),{code:'ENOENT'});
    assert.equal((await backups(f)).length,1);
  });
  test(`${engine}: a dirty installed checkout is preserved without changing configuration`,async t=>{
    const f=await fixture(t);assert.equal((await run(f,engine)).code,0);await fs.writeFile(f.configFile,original);await fs.writeFile(path.join(f.plugin,'local-user-file'),'user edit');
    const before=await backups(f),result=await run(f,engine);assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);
    assert.equal(await fs.readFile(path.join(f.plugin,'local-user-file'),'utf8'),'user edit');assert.deepEqual(await backups(f),before);
  });
  test(`${engine}: failed fast-forward update does not touch configuration or remove local history`,async t=>{
    const f=await fixture(t);assert.equal((await run(f,engine)).code,0);await fs.writeFile(f.configFile,original);
    await fs.writeFile(path.join(f.plugin,'local-commit'),'preserve');await f.git('-C',f.plugin,'add','.');
    await f.git('-C',f.plugin,'-c','user.name=Installer Test','-c','user.email=installer@example.invalid','-c','commit.gpgsign=false','commit','-m','local branch');
    const local=await f.git('-C',f.plugin,'rev-parse','HEAD');await fs.writeFile(path.join(f.origin,'remote-commit'),'remote');await f.git('add','.');await f.git('commit','-m','remote branch');
    const result=await run(f,engine);assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.equal(await f.git('-C',f.plugin,'rev-parse','HEAD'),local);
  });
  test(`${engine}: ambiguous YAML and aliases are not silently replaced`,async t=>{
    for(const config of ['enableServerPlugins: false\nenableServerPlugins: true\n','enableServerPlugins: *shared\n','---\nport: 8000\n---\nport: 9000\n']){
      const f=await fixture(t,{config}),result=await run(f,engine);assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),config);assert.equal((await backups(f)).length,0);
    }
  });
  test(`${engine}: UTF-8 BOM and CRLF do not cause duplicate plugin keys`,async t=>{
    const config='\uFEFFenableServerPlugins: false # original\r\nport: 8000\r\n',f=await fixture(t,{config});const result=await run(f,engine);assert.equal(result.code,0,result.output);
    assert.equal(await fs.readFile(f.configFile,'utf8'),config.replace('false','true'));
  });
  test(`${engine}: symlink or junction plugin parent cannot redirect installation`,async t=>{
    const f=await fixture(t),outside=path.join(f.root,'unrelated');await fs.mkdir(outside);await fs.symlink(outside,path.join(f.st,'plugins'),win?'junction':'dir');
    const result=await run(f,engine);assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.deepEqual(await fs.readdir(outside),[]);
  });
  test(`${engine}: no stop confirmation fails without modifying files`,async t=>{
    const f=await fixture(t),result=await run(f,engine,{QIANMU_SERVER_STOPPED:''});assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.equal((await backups(f)).length,0);
  });
  test(`${engine}: an existing installation lock is never stolen or removed`,async t=>{
    const f=await fixture(t),lock=path.join(f.st,'.qianmu-installer.lock');await fs.mkdir(lock);await fs.writeFile(path.join(lock,'other-owner'),'busy');
    const result=await run(f,engine);assert.notEqual(result.code,0);assert.equal(await fs.readFile(f.configFile,'utf8'),original);assert.equal(await fs.readFile(path.join(lock,'other-owner'),'utf8'),'busy');
  });
  test(`${engine}: old fixed-name backups survive and update hooks are not executed`,async t=>{
    const f=await fixture(t),old=path.join(f.st,'config.yaml.qianmu-backup');await fs.writeFile(old,'older backup');assert.equal((await run(f,engine)).code,0);
    await fs.writeFile(path.join(f.plugin,'.git','hooks','post-merge'),'#!/bin/sh\nprintf changed > local-hook-ran\n',{mode:0o700});
    await fs.writeFile(path.join(f.origin,'version-2'),'new');await f.git('add','.');await f.git('commit','-m','update fixture');
    const result=await run(f,engine);assert.equal(result.code,0,result.output);await assert.rejects(fs.stat(path.join(f.plugin,'local-hook-ran')),{code:'ENOENT'});
    assert.equal(await fs.readFile(old,'utf8'),'older backup');await assert.rejects(fs.stat(path.join(f.st,'.qianmu-installer.lock')),{code:'ENOENT'});
  });
  test(`${engine}: a concurrent configuration edit at final write is preserved and installation reports failure`,async t=>{
    const f=await fixture(t),before=engine==='powershell'
      ? `function Set-Acl { param($LiteralPath,$AclObject) Microsoft.PowerShell.Security\\Set-Acl -LiteralPath $LiteralPath -AclObject $AclObject; if ($LiteralPath -like '*.qianmu-new.*') { [IO.File]::WriteAllText($env:QM_FIXTURE_CONFIG,'edited during install') } }`
      : `cp() { command cp "$@" || return; case "$*" in *qianmu-new.*) printf 'edited during install' > "$QM_FIXTURE_CONFIG" ;; esac; }`;
    const result=await run(f,engine,{QM_FIXTURE_CONFIG:f.configFile},before);assert.notEqual(result.code,0,result.output);
    assert.equal(await fs.readFile(f.configFile,'utf8'),'edited during install');assert.match(result.output,/配置.*变化/);
    const [backup]=await backups(f);assert.equal(await fs.readFile(path.join(path.dirname(f.configFile),backup),'utf8'),original);
    assert.equal((await fs.readdir(f.st)).some(name=>name.includes('.qianmu-new.')),false);
    assert.equal(await fs.readFile(path.join(f.data,'old-user-data'),'utf8'),'keep legacy data');
  });
}
test('shell Docker path preserves other config and prints manual startup without invoking Docker',async t=>{
  const f=await fixture(t,{docker:true}),result=await run(f,'shell');assert.equal(result.code,0,result.output);
  assert.equal(await fs.readFile(f.configFile,'utf8'),original.replace('false','true'));assert.match(result.output,/没有重启容器/);assert.match(result.output,/docker compose start sillytavern/);
});
