// null inherits; [] grants nothing. An explicit instance never grants future operations.
export function normalizeResourceSelection(value) {
  if (value == null) return null;
  if (!Array.isArray(value) || value.length > 200) throw Object.assign(new Error('资源授权必须为数组或 null'),{status:400});
  const ids = new Set();
  return value.map(row => {
    if (!row || typeof row.id !== 'string' || !row.id || ids.has(row.id)) throw Object.assign(new Error('资源授权 ID 无效或重复'),{status:400});
    ids.add(row.id);
    if (!Array.isArray(row.operations) || row.operations.some(o => typeof o !== 'string' || !o)) throw Object.assign(new Error('显式资源授权需要 operations 数组'),{status:400});
    return {id:row.id,operations:[...new Set(row.operations)]};
  });
}
export function resolveResourcePolicy(task, context) {
  return Object.fromEntries(['packages','sources'].map(key => [key, normalizeResourceSelection(task?.[key] ?? context?.[key] ?? null)]));
}
export function filterResources(rows, selection) {
  if (selection == null) return rows;
  return rows.flatMap(row => {
    const grant = selection.find(g => g.id === row.id);
    return grant ? [{...row,operations:row.operations.filter(o => grant.operations.includes(o.name))}] : [];
  });
}
export function assertResourceCall(selection, id, operation) {
  if (selection != null && !selection.some(g => g.id === id && g.operations.includes(operation))) {
    throw Object.assign(new Error('当前任务未授权该资源操作'), {code:'RESOURCE_FORBIDDEN'});
  }
}
export function validateResourceReferences(policy, packages, sources) {
  for (const [key, rows] of [['packages',packages],['sources',sources]]) {
    for (const grant of normalizeResourceSelection(policy?.[key]) ?? []) {
      const resource = rows.find(r => r.id === grant.id);
      if (!resource) throw Object.assign(new Error(`授权引用不存在：${key}/${grant.id}`),{status:400});
      const known = resource.operations ?? ({
        calculator:['calculate'],documents:['yu_document_search','yu_document_read'],tomimi:['tomimi'],
        'sqlite-readonly':['query'],arknights:['arknights_lookup','arknights_relics'],
      }[resource.adapter] ?? []).map(name=>({name:(key==='packages'?'package_':'source_')+resource.id+'_'+name}));
      if (known && grant.operations.some(op => !known.some(o => o.name === op))) throw Object.assign(new Error(`授权操作不存在：${key}/${grant.id}`),{status:400});
    }
  }
}
