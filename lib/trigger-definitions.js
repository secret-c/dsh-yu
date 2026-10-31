import { normalizeTriggerInput } from './repo.js';

export function normalizeDefinitions(raw) {
  const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(rows)) throw new Error('触发器库须为数组');
  const ids = new Set();
  return rows.map(row => {
    const id = String(row?.id ?? '').trim();
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id) || ids.has(id)) throw new Error('触发器ID须唯一且仅含字母数字下划线和连字符');
    ids.add(id);
    const trigger = normalizeTriggerInput(row);
    delete trigger.spec.definitionId;
    delete trigger.spec.localEnabled;
    // URLs belong to each binding, never a reusable definition.
    if (trigger.type === 'webhook') delete trigger.spec.token;
    return { id, ...trigger, label: String(row.label || id).slice(0,200) };
  });
}
export const readDefinitions = settings => normalizeDefinitions(settings.get('triggers.library') || '[]');

export function syncTriggerDefinitions({repo,settings}) {
  // Preserve each legacy binding independently; identical rules need not share future edits.
  const legacy = repo.triggers.listAll().filter(binding => !binding.spec?.definitionId);
  if (legacy.length) {
    const rows = readDefinitions(settings);
    const ids = new Set(rows.map(d => d.id));
    const additions = legacy.map(binding => {
      let id = 'legacy_' + binding.id;
      while (ids.has(id)) id += '_';
      ids.add(id);
      const spec = {...binding.spec};
      delete spec.token;
      return {id, type:binding.type, label:binding.label, spec, enabled:true, misfirePolicy:binding.misfirePolicy};
    });
    repo.transaction(() => {
      settings.set('triggers.library', JSON.stringify([...rows, ...additions]));
      legacy.forEach((binding, i) => repo.triggers.attachDefinition(binding.id, additions[i].id));
    });
  }
  const definitions = new Map(readDefinitions(settings).map(d => [d.id,d]));
  for (const binding of repo.triggers.listAll()) {
    const id = binding.spec?.definitionId;
    if (!id) continue;
    const def = definitions.get(id);
    if (!def) {
      if (binding.enabled) repo.triggers.update(binding.id, {enabled:false});
      repo.triggers.setSchedule(binding.id,{nextFireAt:null});
      continue;
    }
    const localEnabled = binding.spec.localEnabled ?? binding.enabled;
    const spec = {...def.spec,definitionId:id,localEnabled};
    if (def.type === 'webhook' && binding.type === 'webhook') spec.token = binding.spec.token;
    const next = normalizeTriggerInput({...def, spec, enabled: localEnabled && def.enabled});
    if (binding.type !== next.type || binding.label !== next.label || JSON.stringify(binding.spec) !== JSON.stringify(next.spec) || binding.misfirePolicy !== next.misfirePolicy || binding.enabled !== next.enabled) {
      repo.triggers.update(binding.id,next);
    }
  }
}
