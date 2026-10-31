import { readSections, sectionName } from './sections.js';

// Compatibility only: old block pickers and per-turn lists are translated into
// the same bindings the resource picker edits. Explicit [] always wins.
export function unifiedContextConfig(config = {}, sections = []) {
  const turn = new Set(config.turnSections ?? []);
  const legacyMemory = config.memory?.mode && config.memory.mode !== 'global';
  const needsBindings = legacyMemory || [...turn].some(name => name !== 'yu:project');
  let injection = config.injection;
  if (!Array.isArray(injection) && needsBindings) {
    injection = sections.filter(s => s.enabled && (!s.legacyMemorySlug ||
      (!legacyMemory || (config.memory.mode === 'select' && config.memory.slugs?.includes(s.legacyMemorySlug)))))
      .filter(s => !(s.kind === 'memory' && config.memory?.mode === 'none'))
      .map(s => ({id:s.id, order:s.order}));
  }
  if (Array.isArray(injection)) injection = injection.map(binding => {
    const item = typeof binding === 'string' ? {id:binding} : binding;
    const section = sections.find(s => s.id === item.id);
    return item.scope === undefined && section && turn.has(sectionName(section)) ? {...item,scope:'turn'} : {...item};
  });
  return {...config, injection:injection ?? null, turnSections:[], projectProgress:{enabled:false,projectId:config.projectProgress?.projectId ?? ''}};
}

// Append versions, never rewrite historical configs or remove user material.
// Run after the file migration so legacy block slugs have stable resource ids.
export function migrateContextPolicies({repo,settings}) {
  const {sections} = readSections(settings);
  let migrated = 0;
  for (const profile of repo.contexts.list()) {
    const config = profile.config ?? {};
    if (!(config.turnSections?.length || config.projectProgress?.enabled ||
      (config.memory?.mode && config.memory.mode !== 'global'))) continue;
    const next = unifiedContextConfig(config,sections);
    next.memory = {mode:'global',slugs:null};
    repo.contexts.saveVersion(profile.id,{config:next,expectedVersion:profile.currentVersion,
      note:'统一注入选择；项目快照自动注入已停用，原配置保留在历史版本'});
    migrated++;
  }
  return migrated;
}
