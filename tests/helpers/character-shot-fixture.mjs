import * as storyboard from '../../qianmu-storyboard.js';
import {CHARACTER_CASTING_SCHEMA} from '../../qianmu-character-casting.js';
const copy=structuredClone;
const archive=id=>({schema:CHARACTER_CASTING_SCHEMA,archiveId:id,archiveVersion:1,subjectId:`archive:${id}`,category:'char',name:id,sourceCharacterId:id,match:'id',negativeScope:'model_interface',negative:`no ${id} red hair`});
export function snapshot(source='novel'){
  const state=storyboard.createStoryboardDefaults(),profile={...state.profiles[source],model:source==='novel'?'nai-diffusion-5-full':'gpt-image-1'},shot=storyboard.normalizeStoryboardShotSpec({scene:'kitchen',promptAtoms:{global:['warm light']},
    characters:[{id:'archive:alice',name:'Alice',identity:['black hair'],outfit:['no coat'],action:['cuts carrots'],spatial:{region:'left',center:[.25,.5]},archiveSnapshot:archive('alice')},
      {id:'archive:bob',name:'Bob',identity:['red hair'],outfit:['white shirt'],action:['holds a spoon'],spatial:{region:'right',center:[.75,.5]},archiveSnapshot:archive('bob')}]});
  const compiled=storyboard.compileStoryboardPrompt({providerId:source,remoteModelId:profile.model,capabilityModelId:profile.capabilityModelId,shot,artistString:'artist:test',modelPositive:'quality prefix'});
  return {source,profile,shotSpec:copy(shot),payload:{shotSpec:copy(shot),prompt:compiled.prompt,negative:'keep global negatives',artistString:'artist:test',compiledPrompt:copy(compiled),parameters:{providerOptions:copy(compiled.providerOptions)}}};
}
