// Local configuration checks before LLM spending; no remote readiness or paid probe is implied.
import {prepareComfyWorkflow} from './qianmu-comfy-workflow.js';
import {auditComfyWorkflow,requireComfyExecution} from './qianmu-comfy-audit.js';
export function checkComfyConfiguration({workflow,parameters={},model='',outputNodeId='',automatic=false,referenceCount=0}={}) {
  const template=prepareComfyWorkflow(workflow,{prompt:'qianmu-local-preflight',negativePrompt:'',parameters,model,referenceCount});
  const execution={version:1,automatic:Boolean(automatic),outputNodeIds:outputNodeId?[outputNodeId]:[],maxImages:automatic?1:8,allowUnverified:!automatic};
  const graph=template.bind(Array.from({length:referenceCount},(_,index)=>`qianmu-preflight-reference-${index+1}.png`));
  const report=auditComfyWorkflow(graph,execution,{referenceLoadNodeIds:template.referenceLoadNodeIds});requireComfyExecution(report,execution);
  return Object.freeze({localConfigurationReady:true,remoteExecutionVerified:false,requiresManualQuantityReview:!report.verified||!report.automaticSafe,report});
}
