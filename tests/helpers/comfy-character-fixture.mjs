import {normalizeStoryboardShotSpec} from '../../qianmu-storyboard.js';
import {comfyWorkflowReferenceHash} from '../../qianmu-comfy-references.js';
import {CHARACTER_CASTING_SCHEMA} from '../../qianmu-character-casting.js';
const node=(class_type,inputs)=>({class_type,inputs});
export const graph={
  base:node('CheckpointLoaderSimple',{ckpt_name:'model.safetensors'}),
  lora:node('LoraLoader',{model:['base',0],clip:['base',1],lora_name:'neutral.safetensors',strength_model:0,strength_clip:0}),
  prompt:node('CLIPTextEncode',{clip:['lora',1],text:'%qianmu_prompt%'}),
  person:node('CLIPTextEncode',{clip:['lora',1],text:''}),
  negative:node('CLIPTextEncode',{clip:['lora',1],text:''}),
  combine:node('ConditioningCombine',{conditioning_1:['prompt',0],conditioning_2:['person',0]}),
  reference:node('LoadImage',{image:'%qianmu_reference_1%'}),
  encode:node('VAEEncode',{pixels:['reference',0],vae:['base',2]}),
  sampler:node('KSampler',{model:['lora',0],positive:['combine',0],negative:['negative',0],latent_image:['encode',0],seed:42,steps:28,cfg:5,sampler_name:'euler',scheduler:'normal',denoise:1}),
  decode:node('VAEDecode',{samples:['sampler',0],vae:['base',2]}),
  save:node('SaveImage',{images:['decode',0],filename_prefix:'qianmu'}),
};
const spec=(required,output,output_node=false)=>({input:{required,optional:{}},output,output_node});
export const definitions={
  CheckpointLoaderSimple:spec({ckpt_name:[['model.safetensors']]},['MODEL','CLIP','VAE']),
  LoraLoader:spec({model:['MODEL'],clip:['CLIP'],lora_name:[['neutral.safetensors','alice.safetensors']],strength_model:['FLOAT'],strength_clip:['FLOAT']},['MODEL','CLIP']),
  CLIPTextEncode:spec({clip:['CLIP'],text:['STRING']},['CONDITIONING']),
  ConditioningCombine:spec({conditioning_1:['CONDITIONING'],conditioning_2:['CONDITIONING']},['CONDITIONING']),
  LoadImage:spec({image:[['uploaded.png']]},['IMAGE','MASK']),VAEEncode:spec({pixels:['IMAGE'],vae:['VAE']},['LATENT']),
  KSampler:spec({model:['MODEL'],positive:['CONDITIONING'],negative:['CONDITIONING'],latent_image:['LATENT'],seed:['INT'],steps:['INT'],cfg:['FLOAT'],sampler_name:[['euler']],scheduler:[['normal']],denoise:['FLOAT']},['LATENT']),
  VAEDecode:spec({samples:['LATENT'],vae:['VAE']},['IMAGE']),SaveImage:spec({images:['IMAGE'],filename_prefix:['STRING']},[],true),
};
export const namespace='st-user:role-test';
export const identity={id:'workflow-1',revision:'revision-1',version:1,hash:await comfyWorkflowReferenceHash(graph)};
export const reference={url:'/user/images/alice.png',mime:'image/png',name:'Alice',bytes:70,sha256:'a'.repeat(64)};
export const implementation={version:1,name:'Alice workflow',workflow:identity,referenceSlot:1,
  loras:[{nodeId:'lora',classType:'LoraLoader',loraName:'alice.safetensors',strengthModel:.6,strengthClip:0}],
  conditioning:[{nodeId:'person',kind:'positive',text:'alice trigger'},{nodeId:'negative',kind:'negative',text:'alice exclusion'}]};
export function job(){
  const spec=normalizeStoryboardShotSpec({characters:[{id:'archive:alice',name:'Alice',archiveSnapshot:{schema:CHARACTER_CASTING_SCHEMA,archiveId:'alice',archiveVersion:1,subjectId:'archive:alice',category:'char',name:'Alice',sourceCharacterId:'C1',match:'id',negativeScope:'model_interface',negative:'NAI ONLY',
    comfyImplementation:{version:1,namespace,implementations:[implementation],reference}}}]});
  return {source:'comfy',automatic:false,profile:{model:'comfy-workflow',comfyWorkflow:JSON.stringify(graph),comfyOutputNodeId:'save',comfyCharacterEnabled:true,comfyCharacterActivation:{namespace,workflow:identity}},
    target:'gallery',shotSpec:spec,payload:{prompt:'garden',shotSpec:structuredClone(spec),parameters:{workflow:structuredClone(graph),count:1}},
    connection:{baseUrl:'https://comfy.test/api',comfyTransport:'browser',credentialId:'test-key'}};
}
export const recipe={name:'Workflow',workflow:identity,document:{workflow:JSON.stringify(graph),outputNodeId:'save'}};
