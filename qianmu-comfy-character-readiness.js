// Read-only per-shot verification, using the same explicitly selected requester as generation.
import {checkComfyReadiness} from './qianmu-comfy-readiness.js';
export async function checkComfyCharacterReadiness(request,{transport,headers,fetchImpl=globalThis.fetch,guard=async()=>{},timeoutMs=30000}={}) {
  if(!['browser','gateway','legacy-auto'].includes(transport))throw Error('请确认 Comfy 请求方式');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(30000,Math.max(1000,timeoutMs)));
  try {
    let result;await guard();
    if(transport!=='gateway'){
      try{result=await checkComfyReadiness(request,{signal:controller.signal,fetchImpl:async(url,options)=>{await guard();return fetchImpl(url,options);}});}
      catch(error){if(transport==='browser'||error.code!=='comfy_readiness_transport'||controller.signal.aborted)throw error;}
    }
    await guard();
    if(!result){
      const response=await fetchImpl('/api/plugins/qianmu-tts/image/comfy/readiness',{method:'POST',headers,credentials:'same-origin',redirect:'error',signal:controller.signal,body:JSON.stringify(request)});
      if(!response.ok) {await response.body?.cancel?.();throw Error(response.status===404?'请更新增强服务后使用 Comfy 角色节点检查':`Comfy 角色节点检查失败（${response.status}）`);}
      const limit=256*1024;let raw='';const reader=response.body?.getReader();
      if(!reader)throw Error('Comfy 角色节点检查没有返回内容');
      let size=0;const decoder=new TextDecoder();
      try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit)throw Error('Comfy 节点检查返回过大');raw+=decoder.decode(value,{stream:true});await guard();}raw+=decoder.decode();}
      catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
      result=JSON.parse(raw);
    }
    await guard();
    if(!result?.ok||result.schemaVersion!==1||result.actualGenerationVerified!==false||!Number.isSafeInteger(result.errors)||result.errors!==0
      ||!Number.isSafeInteger(result.warnings)||result.warnings<0||result.ready!==(result.errors===0&&result.warnings===0))throw Error(String(result?.issues?.[0]?.message||result?.message||'Comfy 角色节点或模型未通过检查').replace(/[\r\n]/g,' ').slice(0,180));
    const graph=typeof request.workflow==='string'?JSON.parse(request.workflow):request.workflow;
    const deferred=new Set((Array.isArray(result.issues)?result.issues:[]).filter(issue=>issue?.severity==='warning'&&issue.code==='reference_pending_upload'
      &&issue.field==='image'&&graph?.[issue.nodeId]?.class_type==='LoadImage'&&/^%qianmu_reference(?:_([1-9]|1[0-6]))?%$/.test(graph[issue.nodeId].inputs?.image||''))
      .map(issue=>JSON.stringify([issue.nodeId,issue.field])));
    // File contents and uploaded names are checked in the existing asset/upload path. Keep ready=false;
    // exclude only this precise deferred check from unrelated unknown-node warnings, never all warnings.
    return {...result,pendingReferenceUploads:deferred.size,unverifiedWarnings:Math.max(0,result.warnings-deferred.size)};
  }finally{clearTimeout(timer);controller.abort();}
}
