// Account-scoped workflow documents. No generation, implicit migration or connection credentials.
import { sanitizeStoryboardWorkflow } from './qianmu-storyboard.js';
import { inspectComfyWorkflow } from './qianmu-comfy-workflow.js';
export const COMFY_LIBRARY_SCHEMA = 'qianmu.comfy.workflow.v1';
export const COMFY_LIBRARY_PARAMETERS = Object.freeze(['width','height','count','steps','cfg','seed','sampler','scheduler']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value,max) => String(value ?? '').trim().slice(0,max);
export const comfyLibraryError = (code,message) => Object.assign(new Error(message),{code:`comfy_library_${code}`});
export function normalizeComfyLibraryDocument(value) {
  if (!object(value)) throw comfyLibraryError('document','工作流方案格式无效');
  const result=sanitizeStoryboardWorkflow(value.workflow);
  if (!result.ok || !result.serialized || !Object.keys(result.workflow).length || Object.keys(result.workflow).length>512
    || Array.isArray(result.workflow.nodes) || !Object.values(result.workflow).every(node=>object(node)&&object(node.inputs)&&typeof node.class_type==='string'&&node.class_type.trim())) {
    throw comfyLibraryError('document',result.message||'请使用包含 1 至 512 个节点的 API 工作流');
  }
  if(result.removedFields.length) throw Object.assign(comfyLibraryError('sensitive_fields','工作流含连接凭据字段，请移除后再保存'),{fields:result.removedFields});
  const inspection=inspectComfyWorkflow(result.serialized);
  if(!inspection.ok)throw comfyLibraryError('document',inspection.message);
  const outputNodeId=text(value.outputNodeId,121);
  if(outputNodeId&&!/^[a-zA-Z0-9_:-]{1,120}$/.test(outputNodeId))throw comfyLibraryError('output','最终输出节点编号无效');
  const bounded=(value,max)=>{if(value!=null&&typeof value!=='string'&&typeof value!=='number')throw comfyLibraryError('document','参数与提示补充须为文字或数字');const result=String(value??'').trim();if(result.length>max)throw comfyLibraryError('document','参数或提示补充超出长度上限，请缩短后再保存');return result;};
  const parameters=Object.fromEntries(COMFY_LIBRARY_PARAMETERS.map(key=>[key,bounded(value.parameters?.[key],120)]));
  return {workflow:result.serialized,outputNodeId,parameters,positivePrompt:bounded(value.positivePrompt,12000),negativePrompt:bounded(value.negativePrompt,12000)};
}
export function inspectComfyLibraryDocument(document) {
  const normalized=normalizeComfyLibraryDocument(document),inspection=inspectComfyWorkflow(normalized.workflow),nodes=JSON.parse(normalized.workflow);
  const outputMissing=normalized.outputNodeId&&!Object.hasOwn(nodes,normalized.outputNodeId);
  return {nodes:Object.keys(nodes).length,slots:[...inspection.slots],issue:outputMissing?'所选输出节点已缺失':inspection.message,
    bytes:new TextEncoder().encode(JSON.stringify(normalized)).byteLength};
}
export function importComfyLibraryDocument(contents) {
  if(typeof contents!=='string'||new TextEncoder().encode(contents).byteLength>3*1024*1024)throw comfyLibraryError('import','方案文件须小于 3 MB');
  let raw;try{raw=JSON.parse(contents);}catch(_){throw comfyLibraryError('import','方案文件不是有效 JSON');}
  if(raw?.schema!==undefined&&raw.schema!==COMFY_LIBRARY_SCHEMA)throw comfyLibraryError('version','方案文件版本不兼容');
  const wrapped=raw?.schema===COMFY_LIBRARY_SCHEMA;
  const candidate=wrapped?raw.document:{workflow:raw};
  const clean=sanitizeStoryboardWorkflow(candidate?.workflow);
  if(!clean.ok)throw comfyLibraryError('document',clean.message);
  const document=normalizeComfyLibraryDocument({...candidate,workflow:clean.serialized});
  return {name:wrapped?text(raw.name,80):'',document,removedFields:clean.removedFields};
}
export function exportComfyLibraryDocument(name,document) {
  return {schema:COMFY_LIBRARY_SCHEMA,name:text(name,80),document:normalizeComfyLibraryDocument(document)};
}

export function createComfyWorkflowStore({indexedDB=globalThis.indexedDB,keyRange=globalThis.IDBKeyRange,dbName='qianmu-comfy-workflows',timeoutMs=6000,maxBytes=64*1024*1024,now=Date.now}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1)throw comfyLibraryError('capacity','工作流库容量配置无效');
  const stores=['workflows','revisions','documents'],timeout=Math.max(100,Math.min(15000,Number(timeoutMs)||6000));
  let opening=null,db=null,closed=false;const pending=new Set();
  const error=()=>comfyLibraryError('storage','工作流库暂不可用，请检查浏览器储存空间');
  const identity=(namespace,id='')=>{
    if(typeof namespace!=='string'||!namespace.trim()||namespace.length>240||/[\u0000-\u001f]/.test(namespace)
      ||typeof id!=='string'||id&&!/^[a-zA-Z0-9_-]{1,160}$/.test(id))throw comfyLibraryError('identity','工作流库账户或编号无效');
    return JSON.stringify([namespace,id]);
  };
  const open=()=>{
    if(closed)return Promise.reject(comfyLibraryError('closed','工作流库会话已结束'));
    if(db)return Promise.resolve(db);if(opening)return opening;
    const promise=new Promise((resolve,reject)=>{
      let request,done=false;
      const finish=(failure,value)=>{if(done){value?.close();return;}done=true;clearTimeout(timer);failure?reject(failure):resolve(value);};
      const timer=setTimeout(()=>finish(comfyLibraryError('timeout','工作流库读取超时，请关闭其它旧页面后重试')),timeout);
      try{request=indexedDB.open(dbName,1);}catch(_){finish(error());return;}
      request.onupgradeneeded=()=>{if(done||closed){request.transaction?.abort();return;}for(const name of stores)if(!request.result.objectStoreNames.contains(name)){
        const store=request.result.createObjectStore(name,{keyPath:'key'});
        if(name!=='documents')store.createIndex('namespace','namespace');
        if(name==='revisions')store.createIndex('workflowKey','workflowKey');
      }};
      request.onerror=()=>finish(error());request.onblocked=()=>finish(comfyLibraryError('blocked','工作流库正在升级，请关闭其它旧页面后重试'));
      request.onsuccess=()=>{const value=request.result;if(done||closed){value.close();finish(comfyLibraryError('closed','工作流库会话已结束'));return;}
        db=value;value.onversionchange=()=>{value.close();if(db===value)db=null;opening=null;};value.onclose=()=>{if(db===value)db=null;opening=null;};finish(null,value);};
    });opening=promise;void promise.catch(()=>{if(opening===promise)opening=null;});return promise;
  };
  async function operation(names,mode,work) {
    const database=await open();if(closed)throw comfyLibraryError('closed','工作流库会话已结束');
    return new Promise((resolve,reject)=>{
      let tx,output,failure,finished=false;
      const finish=cause=>{if(finished)return;finished=true;clearTimeout(timer);pending.delete(tx);cause||closed?reject(cause||comfyLibraryError('closed','工作流库会话已结束')):resolve(output);};
      const abort=cause=>{failure=cause?.code?.startsWith('comfy_library_')?cause:error();try{tx.abort();}catch(_){finish(failure);}};
      const timer=setTimeout(()=>{failure=comfyLibraryError('timeout','工作流操作未确认，请刷新核对后再试');try{tx?.abort();}catch(_){}finish(failure);},timeout);
      try{tx=database.transaction(names,mode);pending.add(tx);}catch(_){finish(error());return;}
      tx.oncomplete=()=>finish();tx.onabort=()=>finish(failure||error());tx.onerror=()=>{failure||=error();};
      const read=(request,receive)=>{request.onsuccess=()=>{try{receive(request.result);}catch(cause){abort(cause);}};};
      try{work(tx,read,value=>{output=value;},abort);}catch(cause){abort(cause);}
    });
  }
  const metadata=row=>row?{...row}:null;
  const validHeads=(rows,namespace)=>{for(const row of rows)if(row.namespace!==namespace||row.key!==identity(namespace,row.id)
    ||!Number.isSafeInteger(row.version)||row.version<1||!Number.isSafeInteger(row.totalBytes)||row.totalBytes<1)throw comfyLibraryError('storage','工作流索引异常，请先导出核对，不会覆盖原数据');return rows;};
  const revisionKey=(namespace,id,revision)=>{identity(namespace,id);if(typeof revision!=='string'||!/^[a-zA-Z0-9_-]{1,160}$/.test(revision))throw comfyLibraryError('identity','工作流版本编号无效');return JSON.stringify([namespace,id,revision]);};
  return Object.freeze({
    async list(namespace,{archived=false}={}) {identity(namespace);return operation(['workflows'],'readonly',(tx,read,set)=>{
      read(tx.objectStore('workflows').index('namespace').getAll(keyRange.only(namespace)),rows=>set(validHeads(rows,namespace).filter(row=>Boolean(row.archived)===Boolean(archived)).map(metadata).sort((a,b)=>b.updatedAt-a.updatedAt)));
    });},
    async versions(namespace,id) {const key=identity(namespace,id);return operation(['revisions'],'readonly',(tx,read,set)=>{
      read(tx.objectStore('revisions').index('workflowKey').getAll(keyRange.only(key)),rows=>set(rows.map(metadata).sort((a,b)=>b.version-a.version)));
    });},
    async load(namespace,id,revision) {const key=revisionKey(namespace,id,revision);return operation(['documents'],'readonly',(tx,read,set)=>{
      read(tx.objectStore('documents').get(key),row=>{if(!row||row.namespace!==namespace||row.id!==id||row.revision!==revision){set(null);return;}set(normalizeComfyLibraryDocument(row.document));});
    });},
    async save(namespace,{id='',expectedRevision='',name,document}) {
      identity(namespace,id);name=text(name,80);if(!name)throw comfyLibraryError('name','请填写方案名');
      const normalized=normalizeComfyLibraryDocument(document),inspection=inspectComfyLibraryDocument(normalized);
      if(!globalThis.crypto?.randomUUID)throw comfyLibraryError('identity','当前环境不能安全建立版本编号，请使用 HTTPS 或本机地址');
      const workflowId=id||globalThis.crypto.randomUUID(),revision=globalThis.crypto.randomUUID(),key=identity(namespace,workflowId);
      if(!id&&expectedRevision)throw comfyLibraryError('conflict','新方案不能覆盖已有版本');
      return operation(stores,'readwrite',(tx,read,set)=>{
        const heads=tx.objectStore('workflows');read(heads.get(key),previous=>{
          if(id&&!previous||previous&&previous.revision!==expectedRevision)throw comfyLibraryError('conflict','此方案已被另一页修改，请重新载入或另存新方案');
          if(previous?.archived)throw comfyLibraryError('archived','请先恢复已归档的方案');
          read(heads.index('namespace').getAll(keyRange.only(namespace)),all=>{
            validHeads(all,namespace);
            if(!previous&&all.length>=128||all.reduce((sum,row)=>sum+row.totalBytes,0)+inspection.bytes>maxBytes||(previous?.version||0)>=64)throw comfyLibraryError('capacity','工作流库达到容量或版本上限，请先导出并整理归档方案');
            const at=now(),version=(previous?.version||0)+1,documentKey=revisionKey(namespace,workflowId,revision);
            const row={key,namespace,id:workflowId,name,revision,version,createdAt:previous?.createdAt||at,updatedAt:at,archived:false,
              bytes:inspection.bytes,totalBytes:(previous?.totalBytes||0)+inspection.bytes,nodes:inspection.nodes,slots:inspection.slots,issue:inspection.issue};
            tx.objectStore('documents').add({key:documentKey,namespace,id:workflowId,revision,document:normalized});
            tx.objectStore('revisions').add({...row,key:documentKey,workflowKey:key,parentRevision:previous?.revision||''});
            heads.put(row);set(metadata(row));
          });
        });
      });
    },
    async archive(namespace,id,expectedRevision,archived=true) {const key=identity(namespace,id);return operation(['workflows'],'readwrite',(tx,read,set)=>{
      const heads=tx.objectStore('workflows');read(heads.get(key),row=>{if(!row||row.revision!==expectedRevision)throw comfyLibraryError('conflict','方案已变化，请刷新后再操作');const next={...row,archived:Boolean(archived),updatedAt:now()};heads.put(next);set(metadata(next));});
    });},
    async purge(namespace,id,expectedRevision) {const key=identity(namespace,id);return operation(stores,'readwrite',(tx,read,set)=>{
      const heads=tx.objectStore('workflows');read(heads.get(key),row=>{
        if(!row||row.revision!==expectedRevision||!row.archived)throw comfyLibraryError('conflict','仅可永久清理仍未变化的归档方案');
        const request=tx.objectStore('revisions').index('workflowKey').openCursor(keyRange.only(key));
        read(request,cursor=>{if(!cursor){heads.delete(key);set({removed:row.version,bytes:row.totalBytes});return;}tx.objectStore('documents').delete(cursor.primaryKey);cursor.delete();cursor.continue();});
      });
    });},
    async usage(namespace) {identity(namespace);return operation(['workflows'],'readonly',(tx,read,set)=>{
      read(tx.objectStore('workflows').index('namespace').getAll(keyRange.only(namespace)),rows=>{validHeads(rows,namespace);set({count:rows.length,archived:rows.filter(row=>row.archived).length,versions:rows.reduce((sum,row)=>sum+row.version,0),bytes:rows.reduce((sum,row)=>sum+row.totalBytes,0),limit:maxBytes});});
    });},
    close(){closed=true;for(const tx of pending)try{tx.abort();}catch(_){}db?.close();db=null;opening=null;},
  });
}
