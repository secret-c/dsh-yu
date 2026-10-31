import { validateResourceReferences } from './resource-policy.js';
import {readInjection,writeInjection,migrateInjectionFiles,injectionPath} from './injection-files.js';
import { readDefinitions, normalizeDefinitions } from './trigger-definitions.js';
import fs from 'node:fs';
import { maskConfig } from './channels/manager.js';
import path from 'node:path';
import { normalizeSections, defaultSections } from './sections.js';
import { normalizeContextConfig, normalizeTaskInput, normalizeTriggerInput } from './repo.js';
import { now, stableStringify } from './util.js';

/** Configuration is an explicit merge. Missing domains/rows are preserved.
 * Channels and tool overrides are included. Credentials are opt-in on export;
 * omitted credential keys preserve the destination, explicit empty/null clears.
 * Conversation archives, long-term memory and device tokens are business data.
 * Validation precedes one database transaction; runtime sync warnings are returned.
 */

export const CONFIG_FORMAT = 'yu-config';
export const CONFIG_VERSION = 1;
export const CONFIG_FILENAME = 'yu.config.json';

/**
 * Values that still exist in old databases but are no longer part of the
 * product (the style section was retired from the prompt). They stay readable
 * for compatibility, but a fresh config document should not carry them.
 */
const DEPRECATED_SETTINGS = new Set(['prompt.styleFallback', 'memory.rules.maxStyleChars','tools.knowledgeDbPath','tools.arknightsEnabled','tools.tomimiEnabled','tools.documentsEnabled','tools.tomimiDataDir']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function trimText(value, max) {
  return String(value ?? '').slice(0, max);
}

function resetRuntimeSettings(settings) {
  settings.suppressFileWrites=true;
  try{for(const spec of settings.spec)settings.set(spec.key,spec.key==='memory.autoMaintenanceDaily'?false:spec.def);}
  finally{settings.suppressFileWrites=false;}
}

function translateLegacySources(config,settings) {
  config=translateLegacyDatabaseSources(config,settings);
  const values=config.settings;
  if(!values || Object.hasOwn(values,'tools.packages') || !['tools.tomimiEnabled','tools.tomimiDataDir','tools.documentsEnabled'].some(k=>Object.hasOwn(values,k)))return config;
  const rows=config.mode==='replace'?[]:JSON.parse(settings.get('tools.packages')||'[]');
  for(const [id,adapter,key] of [['legacy_tomimi','tomimi','tools.tomimiEnabled'],['legacy_documents','documents','tools.documentsEnabled']]) {
    if(!Object.hasOwn(values,key) && !(adapter==='tomimi'&&Object.hasOwn(values,'tools.tomimiDataDir')))continue;
    const old=rows.find(m=>m.id===id);
    const raw=values[key]??old?.enabled??settings.get(key);
    if(typeof raw!=='boolean')throw new Error('旧工具启用值必须是布尔值');
    const exposure=values['tools.exposure']??settings.get('tools.exposure');
    const enabled=Object.hasOwn(values,key)||!old ? raw&&(adapter==='tomimi'?exposure==='all':exposure!=='none') : raw;
    const m={id,name:old?.name??adapter,version:'1',adapter,enabled,config:adapter==='tomimi'?{path:values['tools.tomimiDataDir']??old?.config?.path??settings.get('tools.tomimiDataDir')??''}:{}};
    const index=rows.findIndex(m=>m.id===id);if(index<0)rows.push(m);else rows[index]=m;
  }
  return {...config,settings:{...values,'tools.packages':JSON.stringify(rows)}};
}

function translateLegacyDatabaseSources(config,settings) {
  const values=config.settings;
  if(!values || Object.hasOwn(values,'tools.databaseSources') || !['tools.knowledgeDbPath','tools.arknightsEnabled'].some(k=>Object.hasOwn(values,k)))return config;
  const file=String(values['tools.knowledgeDbPath'] ?? settings.get('tools.knowledgeDbPath') ?? '').trim();
  if(!file)return config;
  const rows=config.mode==='replace'?[]:JSON.parse(settings.get('tools.databaseSources')||'[]');
  const source={id:'legacy_arknights',name:'明日方舟（迁移）',version:'1',adapter:'arknights',config:{path:file},enabled:Boolean(values['tools.arknightsEnabled'] ?? settings.get('tools.arknightsEnabled'))};
  return {...config,settings:{...values,'tools.databaseSources':JSON.stringify([...rows.filter(s=>s.id!==source.id),source])}};
}

/** Build the document. `includeSecrets` is the only thing that can leak a password. */
export function buildConfig({ repo, settings, db, includeSecrets = false }) {
  const all = settings.all();
  const values = {};
  const secrets = {};
  for (const spec of settings.spec) {
    if (['memory.autoAbsorb','memory.autoMaintenanceDaily','memory.maintenanceAt'].includes(spec.key)) continue;
    if (spec.key === 'prompt.sections') continue; // represented by inject.sections
    if (DEPRECATED_SETTINGS.has(spec.key)) continue;
    if (spec.secret) {
      if (includeSecrets && all[spec.key]) secrets[spec.key] = all[spec.key];
      continue;
    }
    values[spec.key] = all[spec.key];
  }

  const registry = (() => {
    try {
      const raw = JSON.parse(settings.get('prompt.sections') || '[]');
      const normalized = normalizeSections(raw);
      return normalized.problems.length ? defaultSections() : normalized.sections;
    } catch {
      return defaultSections();
    }
  })();

  const blocks = repo.memory.blocks().map((block) => ({
    slug: block.slug,
    name: block.name,
    category: block.category,
    orderIndex: block.orderIndex,
    enabled: block.enabled,
    content: (()=>{const section=registry.find(s=>s.legacyMemorySlug===block.slug);const file=section?readInjection(settings,section):null;return file?.status==='ok'?file.text:block.content;})(),
  }));

  if(values['triggers.library'])values['triggers.library']=JSON.stringify(translateChannels(JSON.parse(values['triggers.library']),id=>({name:repo.channels.get(id)?.name??id})));
  const contexts = repo.contexts.list().map((context) => ({
    name: context.name,
    description: context.description,
    config: context.config ?? {},
  }));
  const contextNames = new Map(repo.contexts.list().map((context) => [context.id, context.name]));

  const projects = repo.projects.list().map((project) => ({
    id: project.id,
    name: project.name,
    kind: project.kind,
    state: project.state,
  }));

  const tasks = repo.tasks.list({ includeDeleted: false }).map((task) => ({
    name: task.name,
    kind: task.kind,
    description: task.description,
    enabled: task.enabled,
    goal: task.goal,
    inputTemplate: task.inputTemplate,
    executionTarget:task.executionTarget,
    deliveryTarget:task.deliveryTarget,
    memoryPolicy:task.memoryPolicy,
    conversationMode: task.conversationMode,
    conversationId: task.conversationId ?? null,
    context: task.contextId ? contextNames.get(task.contextId) ?? null : null,
    projectId: task.projectId,
    maxRuntimeMs: task.maxRuntimeMs,
    archivePolicy: task.archivePolicy,
    toolPolicy: task.toolPolicy,
    injection: task.injection,
    triggers: (task.triggers ?? []).map((trigger) => {
      const spec = clone(trigger.spec ?? {});
      // A webhook token is a credential, like a password. Without it a new
      // trigger gets a new URL, which is the correct default for a shared file.
      if (!includeSecrets && trigger.type === 'webhook') delete spec.token;
      return {
        type: trigger.type,
        label: trigger.label,
        enabled: trigger.enabled,
        spec,
        misfirePolicy: trigger.misfirePolicy,
      };
    }),
  }));

  return {
    ...(repo.dshLinks?{dsh:repo.dshLinks.exportConfig()}:{}),
    ...(db?{initialization:exportInitialization(db,repo),libraryPolicies:JSON.parse(db.getMeta('memory.libraries.policies')||'{}')}:{}),
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: new Date(now()).toISOString(),
    settings: values,
    ...(includeSecrets && Object.keys(secrets).length ? { secrets } : {}),
    inject: { sections: registry.map(s=>s.source&&path.isAbsolute(s.source.path)?{...s,source:{path:`injections/${s.id}.md`,format:'utf8'}}:s), contents:Object.fromEntries(registry.filter(s=>s.source).map(s=>[s.id,readInjection(settings,s).text])) },
    memory: { blocks },
    contexts,
    projects,
    tasks: translateChannels(tasks, id=>({name:repo.channels.get(id)?.name??id})),
    channels: repo.channels.list().map(({name,type,config,enabled}) => ({name,type,enabled,config: includeSecrets ? config : maskConfig(config)})),
    tools: { overlays: repo.tools.overlays().map(({updatedAt,...entry}) => entry) },
    mode: 'merge',
    notes: [
      '这是 Yu 的配置文档：改完点「校验」再「应用」。',
      '导入是合并：任务与上下文按名称匹配，项目按 id，触发器按 type+label；文档里没有的不会被删除。',
      includeSecrets
        ? '包含凭据：请把这份文本当密码对待。'
        : '未包含凭据（SMTP 密码、webhook 令牌）。导入时会保留目标实例已有的值 / 为新触发器生成新令牌。',
      '对话、归档、长期记忆库与设备登录不在文档里；渠道凭据默认省略。',
    ],
  };
}

export function renderConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function parseConfigText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) throw Object.assign(new Error('配置文本是空的'), { code: 'CONFIG_EMPTY', status: 400 });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`JSON 解析失败：${error.message}`), { code: 'CONFIG_JSON_INVALID', status: 400 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw Object.assign(new Error('配置文档必须是一个 JSON 对象'), { code: 'CONFIG_SHAPE', status: 400 });
  }
  if (parsed.format && parsed.format !== CONFIG_FORMAT) {
    throw Object.assign(new Error(`不认识的格式：${parsed.format}`), { code: 'CONFIG_FORMAT', status: 400 });
  }
  if (parsed.version !== undefined && Number(parsed.version) > CONFIG_VERSION) {
    throw Object.assign(new Error(`配置版本 ${parsed.version} 比当前 Yu 新（支持到 ${CONFIG_VERSION}）`), {
      code: 'CONFIG_VERSION',
      status: 400,
    });
  }
  return parsed;
}

/**
 * Work out what applying this document would do, without writing anything.
 * Validation happens here: settings are coerced through the real spec, a task
 * and a trigger go through the same normalizers the API uses.
 */
export function planConfig({ repo, settings, config }) {
  config=translateLegacySources(config,settings);
  const problems = [];
  if(config.tasks!==undefined&&!Array.isArray(config.tasks))problems.push('tasks 必须是数组');
  const channelIds=new Map((config.mode==='replace'?[]:repo.channels.list()).map(c=>[c.name,c.id]));
  for(const c of Array.isArray(config.channels)?config.channels:[])if(!channelIds.has(c.name))channelIds.set(c.name,'config-channel:'+c.name);
  const resolveChannel=ref=>{
    if(typeof ref==='object') {if(!channelIds.has(ref.name))problems.push('渠道引用不存在：'+ref.name);return channelIds.get(ref.name)??'missing-channel';}
    if(!repo.channels.get(ref))problems.push('渠道引用不存在：'+ref);
    return ref;
  };
  config={...config,tasks:(Array.isArray(config.tasks)?config.tasks:[]).map(t=>({...t,deliveryTarget:translateChannels(t.deliveryTarget,resolveChannel),triggers:Array.isArray(t.triggers)?t.triggers.map(r=>({...r,spec:translateChannels(r.spec,resolveChannel)})):t.triggers})),...(config.initialization?{initialization:{...config.initialization,selection:translateChannels(config.initialization.selection,resolveChannel)}}:{})};
  if(config.initialization){
    const raw=config.initialization;
    if(!['managed','shared'].includes(raw.mode)||!raw.roles||Object.keys(raw.roles).length!==7||Object.keys(raw.roles??{}).some(k=>!['morning','night','activity','private','group','journal','maintenance'].includes(k))||!raw.selection)problems.push('初始化配置不完整');
    for(const name of Object.values(raw.roles??{}))if(!(config.tasks??[]).some(t=>t.name===name)&&!repo.tasks.list().some(t=>t.name===name))problems.push('初始化任务不存在：'+name);
  }
  if(config.libraryPolicies!==undefined){
    if(!config.libraryPolicies||typeof config.libraryPolicies!=='object'||Array.isArray(config.libraryPolicies))problems.push('libraryPolicies 必须是对象');
    else for(const policy of Object.values(config.libraryPolicies))if(!policy||typeof policy!=='object'||Array.isArray(policy)||Object.entries(policy).some(([k,v])=>!['enabled','retrieval','autoWrite'].includes(k)||typeof v!=='boolean'))problems.push('记忆库策略无效');
  }
  if(config.settings?.['triggers.library']){
    try {config={...config,settings:{...config.settings,'triggers.library':JSON.stringify(translateChannels(JSON.parse(config.settings['triggers.library']),resolveChannel))}};}catch(error){problems.push('触发库：'+error.message);}
  }
  if(config.settings?.['triggers.library'] !== undefined && config.mode !== 'replace') {
    const merged = new Map(readDefinitions(settings).map(d=>[d.id,d]));
    for(const d of normalizeDefinitions(config.settings['triggers.library']))merged.set(d.id,d);
    config={...config,settings:{...config.settings,'triggers.library':JSON.stringify([...merged.values()])}};
  }
  const warnings = [];
  const summary = {
    channels: [],
    overlays: [],
    settings: [],
    secrets: [],
    sections: { entries: 0, current: 0 },
    blocks: { create: [], update: [] },
    contexts: { create: [], update: [] },
    projects: { create: [], update: [] },
    tasks: { create: [], update: [] },
    triggers: { create: 0, update: 0 },
    triggerOps: [],
  };

  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const keys = (value, allowed, label) => {
    if (!object(value)) { problems.push(label + ' 必须是对象'); return; }
    for (const key of Object.keys(value)) if (!allowed.includes(key)) problems.push(label + ' 未知字段：' + key);
  };
  keys(config, ['format','version','exportedAt','settings','secrets','inject','memory','contexts','projects','tasks','channels','tools','mode','notes','dsh','initialization','libraryPolicies'], '文档');
  if (config.mode !== undefined && !['merge','replace'].includes(config.mode)) problems.push('mode 仅支持 merge 或 replace');
  for (const [field, allowed] of [['inject',['sections','contents']],['memory',['blocks']],['tools',['overlays']]]) if (config[field] !== undefined) keys(config[field],allowed,field);
  for (const [field, rows, allowed] of [
    ['contexts',config.contexts,['name','description','config']],
    ['projects',config.projects,['id','name','kind','state']],
    ['tasks',config.tasks,['name','kind','description','enabled','goal','inputTemplate','conversationMode','conversationId','context','projectId','maxRuntimeMs','archivePolicy','toolPolicy','executionTarget','deliveryTarget','memoryPolicy','injection','triggers']],
    ['memory.blocks',config.memory?.blocks,['slug','name','category','orderIndex','enabled','content']],
    ['channels',config.channels,['name','type','config','enabled']],
    ['tools.overlays',config.tools?.overlays,['name','enabled','description','example','config']],
  ]) if (rows !== undefined) {
    if (!Array.isArray(rows)) problems.push(field + ' 必须是数组');
    else for (const row of rows) keys(row,allowed,field);
  }
  for (const [label, rows, key] of [['memory.blocks', config.memory?.blocks, 'slug'], ['contexts', config.contexts, 'name'], ['projects', config.projects, 'id'], ['tasks', config.tasks, 'name'], ['channels',config.channels,'name'], ['tools.overlays',config.tools?.overlays,'name']]) {
    if (!Array.isArray(rows)) continue;
    const seen = new Set();
    for (const row of rows) {
      const identity = String(row?.[key] ?? '').trim();
      const canonical = label === 'memory.blocks' ? identity.toLowerCase() : identity;
      if (seen.has(canonical)) problems.push(label + ' 重复标识：' + identity);
      seen.add(canonical);
      if (label === 'tasks' && row?.triggers !== undefined && !Array.isArray(row.triggers)) problems.push('任务 ' + identity + ' triggers 必须是数组');
    }
  }
  // ---- settings ------------------------------------------------------
  if (config.settings !== undefined) {
    if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) {
      problems.push('settings 必须是一个对象');
    } else {
      for (const [key, value] of Object.entries(config.settings)) {
        if(['memory.autoAbsorb','memory.autoMaintenanceDaily','memory.maintenanceAt'].includes(key)){problems.push(key+' 已迁移，请改用 tasks 中记忆同步任务的触发规则');continue;}
        const spec = settings.spec.find((item) => item.key === key);
        if (!spec) {
          problems.push(`未知设置项：${key}`);
          continue;
        }
        if (spec.secret) {
          problems.push(`${key} 是凭据，请放在 secrets 中`);
          continue;
        }
        if (key === 'prompt.sections') { problems.push('prompt.sections 请放在 inject.sections 中'); continue; } // inject.sections wins
        try {
          const before = settings.get(key);
          const coerced = settings.coerce(key, value);
          if (JSON.stringify(before) !== JSON.stringify(coerced)) summary.settings.push({ key, before, after: coerced });
        } catch (error) {
          problems.push(`${key}：${error.message}`);
        }
      }
    }
  }
  if (config.secrets !== undefined) {
    if (!config.secrets || typeof config.secrets !== 'object' || Array.isArray(config.secrets)) {
      problems.push('secrets 必须是一个对象');
    } else {
      for (const [key, value] of Object.entries(config.secrets)) {
        const spec = settings.spec.find((item) => item.key === key);
        if (!spec || !spec.secret) {
          problems.push(`不是凭据设置项：${key}`);
          continue;
        }
        if (value !== null && typeof value !== 'string') { problems.push(`${key} 凭据必须是字符串或 null`); continue; }
        summary.secrets.push({ key, after: value === null ? '' : String(value) });
      }
    }
  }

  if(config.inject?.contents!==undefined) {
    if(!object(config.inject.contents))problems.push('inject.contents须为资源ID到文本的对象');
    else for(const [id,text] of Object.entries(config.inject.contents))if(typeof text!=='string'||text.length>400000||!config.inject.sections?.some(s=>s.id===id&&s.source))problems.push('无效注入文件内容：'+id);
  }

  // ---- inject sections ----------------------------------------------
  const incomingSections = config.inject?.sections;
  if (incomingSections !== undefined) {
    const { sections, problems: sectionProblems } = normalizeSections(incomingSections);
    for (const problem of sectionProblems) problems.push(`注入段：${problem}`);
    let current = [];
    try {
      current = normalizeSections(JSON.parse(settings.get('prompt.sections') || '[]')).sections;
    } catch {
      current = [];
    }
    const changed = stableStringify(current) !== stableStringify(sections);
    summary.sections = {
      entries: sections.length,
      current: current.length,
      changed,
      ...(changed ? { replace: sections } : {}),
    };
  }

  // ---- memory blocks -------------------------------------------------
  if (config.memory?.blocks !== undefined) {
    if (!Array.isArray(config.memory.blocks)) {
      problems.push('memory.blocks 必须是数组');
    } else {
      const existing = new Map(repo.memory.blocks().map((block) => [block.slug, block]));
      for (const raw of config.memory.blocks) {
        const slug = String(raw?.slug ?? '').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(slug)) {
          problems.push(`记忆块 slug 不合法：${raw?.slug ?? '（空）'}`);
          continue;
        }
        const name = trimText(raw?.name ?? slug, 120).trim();
        if (!name) {
          problems.push(`记忆块 ${slug} 缺少名称`);
          continue;
        }
        const category = repo.constants.MEMORY_CATEGORIES.includes(String(raw?.category))
          ? String(raw.category)
          : 'custom';
        if (raw?.category && category !== String(raw.category)) {
          warnings.push(`记忆块 ${slug} 的类别「${raw.category}」不认识，按 custom 处理`);
        }
        const entry = {
          slug,
          name,
          category,
          orderIndex: Number.isFinite(Number(raw?.orderIndex)) ? Number(raw.orderIndex) : 99,
          enabled: raw?.enabled !== false,
          content: trimText(raw?.content ?? '', 400_000),
        };
        const current = existing.get(slug);
        if (!current) {
          summary.blocks.create.push(entry);
          continue;
        }
        const unchanged =
          current.name === entry.name &&
          current.category === entry.category &&
          current.orderIndex === entry.orderIndex &&
          current.enabled === entry.enabled &&
          String(current.content ?? '') === entry.content;
        if (!unchanged) summary.blocks.update.push(entry);
      }
    }
  }

  // ---- projects ------------------------------------------------------
  if (config.projects !== undefined) {
    if (!Array.isArray(config.projects)) {
      problems.push('projects 必须是数组');
    } else {
      for (const raw of config.projects) {
        const projectId = String(raw?.id ?? '').trim();
        if (!projectId) {
          problems.push('项目缺少 id');
          continue;
        }
        const entry = {
          id: projectId,
          name: trimText(raw?.name ?? projectId, 200),
          kind: trimText(raw?.kind ?? 'reading', 40),
          state: raw?.state && typeof raw.state === 'object' ? raw.state : (repo.projects.get(projectId)?.state ?? repo.projects.savedProgress()[projectId] ?? {}),
        };
        const current = repo.projects.get(projectId);
        if (!current) {
          summary.projects.create.push(entry);
          continue;
        }
        const unchanged =
          current.name === entry.name &&
          current.kind === entry.kind &&
          stableStringify(current.state ?? {}) === stableStringify(entry.state);
        if (!unchanged) summary.projects.update.push(entry);
      }
    }
  }

  // ---- contexts ------------------------------------------------------
  if (config.contexts !== undefined) {
    if (!Array.isArray(config.contexts)) {
      problems.push('contexts 必须是数组');
    } else {
      const existing = new Map(repo.contexts.list().map((context) => [context.name, context]));
      for (const raw of config.contexts) {
        const name = trimText(raw?.name ?? '', 200).trim();
        if (!name) {
          problems.push('上下文缺少名称');
          continue;
        }
        let normalized;
        try {
          normalized = normalizeContextConfig(raw?.config ?? {});
        } catch (error) {
          problems.push(`上下文「${name}」：${error.message}`);
          continue;
        }
        const entry = { name, description: trimText(raw?.description ?? '', 2000), config: normalized };
        const current = existing.get(name);
        if (!current) {
          summary.contexts.create.push(entry);
          continue;
        }
        const configChanged = stableStringify(current.config) !== stableStringify(normalized);
        const descriptionChanged = String(current.description ?? '') !== entry.description;
        if (!configChanged && !descriptionChanged) continue;
        summary.contexts.update.push({ ...entry, id: current.id, configChanged });
      }
    }
  }

  // ---- tasks + triggers ---------------------------------------------
  const contextIdByName = new Map(repo.contexts.list().map((context) => [context.name, context.id]));
  const knownContextNames = new Set(contextIdByName.keys());
  for (const context of summary.contexts.create) knownContextNames.add(context.name);
  if (config.tasks !== undefined) {
    if (!Array.isArray(config.tasks)) {
      problems.push('tasks 必须是数组');
    } else {
      const existing = new Map(repo.tasks.list().map((task) => [task.name, task]));
      for (const raw of config.tasks) {
        const name = trimText(raw?.name ?? '', 200).trim();
        if (!name) {
          problems.push('任务缺少名称');
          continue;
        }
        if (raw?.context && !knownContextNames.has(String(raw.context))) {
          problems.push(`任务「${name}」引用的上下文「${raw.context}」不存在`);
        }
        if (raw?.projectId && !repo.projects.get(raw.projectId) && !summary.projects.create.concat(summary.projects.update).some(p=>p.id === raw.projectId)) problems.push('任务项目不存在：' + raw.projectId);
        const current = existing.get(name) ?? null;
        let normalized;
        try {
          normalized = normalizeTaskInput({
            name,
            kind: raw?.kind,
            description: raw?.description,
            enabled: raw?.executionTarget?.mode==='dsh-session'?false:raw?.enabled,
            goal: raw?.goal,
            inputTemplate: raw?.inputTemplate,
            executionTarget:raw?.executionTarget,
            deliveryTarget:raw?.deliveryTarget,
            memoryPolicy:raw?.memoryPolicy ?? current?.memoryPolicy,
            conversationMode: raw?.conversationMode,
            conversationId: Object.hasOwn(raw, 'conversationId') ? raw.conversationId : current?.conversationId ?? null,
            projectId: raw?.projectId ?? null,
            maxRuntimeMs: raw?.maxRuntimeMs,
            archivePolicy: raw?.archivePolicy,
            toolPolicy: raw?.toolPolicy,
            injection: raw?.injection,
          });
          if (normalized.executionTarget.mode==='yu' && normalized.conversationMode === 'reuse' && normalized.conversationId) {
            const target = repo.conversations.get(normalized.conversationId);
            if (!target || target.archivedAt) throw new Error(`引用的会话不存在或已归档，请重新选择：${normalized.conversationId}`);
            repo.conversations.assertBindable(normalized.conversationId);
          }
        } catch (error) {
          problems.push(`任务「${name}」：${error.message}`);
          continue;
        }
        const contextId = raw?.context ? contextIdByName.get(String(raw.context)) ?? null : null;
        const triggerOps = [];
        const triggerKeys = new Set();
        for (const triggerRaw of (Array.isArray(raw?.triggers) ? raw.triggers : [])) {
          try {
            keys(triggerRaw,['type','label','enabled','spec','misfirePolicy'],'trigger');
            const trigger = normalizeTriggerInput(triggerRaw);
            const identity = trigger.spec.definitionId ? 'definition:' + trigger.spec.definitionId : trigger.type + ':' + trigger.label;
            if (triggerKeys.has(identity)) problems.push('任务触发器重复：' + identity);
            triggerKeys.add(identity);
            const match = (current?.triggers ?? []).find(
              (item) => trigger.spec.definitionId ? item.spec?.definitionId === trigger.spec.definitionId : item.type === trigger.type && item.label === trigger.label,
            );
            // A webhook URL is a credential. Export without `includeSecrets`
            // omits the token, and the normalizer generates a fresh one — which
            // must not rotate a URL that scripts already call. Keep the current
            // token when the document did not carry one.
            if (trigger.type === 'webhook' && triggerRaw?.spec?.token === undefined && match?.spec?.token) {
              trigger.spec.token = match.spec.token;
            }
            if(match?.spec?.definitionId&&!trigger.spec.definitionId) {
              if(Object.keys(trigger.spec).some(key=>stableStringify(trigger.spec[key])!==stableStringify(match.spec[key])))throw new Error('该触发器已迁入共享规则库，请导出新配置后编辑对应规则定义');
              trigger.spec.definitionId=match.spec.definitionId;
              trigger.spec.localEnabled=match.spec.localEnabled??match.enabled;
            }
            // Compare normalized shapes, not stored ones. A live trigger may
            // carry legacy spec keys or be missing a default the normalizer
            // fills in; an unchanged document must not look like it is changing
            // them (and a no-op apply should stay a no-op).
            const currentTrigger = match
              ? normalizeTriggerInput({
                  type: match.type,
                  label: match.label,
                  spec: match.spec ?? {},
                  enabled: match.enabled,
                  misfirePolicy: match.misfirePolicy,
                })
              : null;
            const specSame = Object.keys(trigger.spec ?? {}).every(
              (key) =>
                stableStringify(currentTrigger?.spec?.[key] ?? null) ===
                stableStringify(trigger.spec[key] ?? null),
            );
            const unchanged = Boolean(
              match &&
                specSame &&
                match.enabled === trigger.enabled &&
                (match.misfirePolicy ?? 'skip') === (trigger.misfirePolicy ?? 'skip'),
            );
            if (unchanged) continue;
            triggerOps.push({ taskName: name, currentId: current?.id ?? null, matchId: match?.id ?? null, trigger });
            if (match) summary.triggers.update += 1;
            else summary.triggers.create += 1;
          } catch (error) {
            problems.push(`任务「${name}」的触发器：${error.message}`);
          }
        }

        const comparable = [
          'kind',
          'description',
          'enabled',
          'goal',
          'inputTemplate',
          'executionTarget',
          'deliveryTarget',
          'memoryPolicy',
          'conversationMode',
          'conversationId',
          'projectId',
          'maxRuntimeMs',
          'toolPolicy',
          'archivePolicy',
          'injection',
        ];
        const fieldsChanged =
          !current ||
          comparable.some(
            (key) => stableStringify(current[key] ?? null) !== stableStringify(normalized[key] ?? null),
          ) ||
          (current.contextId ?? null) !== contextId || Boolean(raw?.context && !contextId && knownContextNames.has(String(raw.context)));
        if (fieldsChanged) {
          summary.tasks[current ? 'update' : 'create'].push({
            ...normalized,
            context: raw?.context ?? null,
            currentId: current?.id ?? null,
            triggerOps,
          });
        }
        summary.triggerOps.push(...triggerOps);
      }
    }
  }

  for (const raw of Array.isArray(config.channels) ? config.channels : []) {
    if (!raw?.name || String(raw.name).length > 120 || !['web','napcat','snowluma','qq-official','onebot'].includes(raw.type) || !object(raw.config ?? {})) { problems.push('渠道名称、类型或 config 无效'); continue; }
    const current = repo.channels.list().find(c => c.name === raw.name);
    if (current && current.type !== raw.type) { problems.push('渠道类型不能修改：' + raw.name); continue; }
    const patch = Object.fromEntries(Object.entries(raw.config ?? {}).filter(([k]) => !k.endsWith('__set')));
    const entry = { name:raw.name, type:raw.type, config:{...(current?.config ?? {}),...patch}, enabled:raw.enabled === undefined ? (current?.enabled ?? false) : raw.enabled === true };
    if (!current || stableStringify({name:current.name,type:current.type,config:current.config,enabled:current.enabled}) !== stableStringify(entry)) summary.channels.push({...entry,id:current?.id});
  }
  for (const raw of Array.isArray(config.tools?.overlays) ? config.tools.overlays : []) {
    if (!raw?.name || typeof raw.name !== 'string' || !object(raw.config ?? {})) { problems.push('工具覆盖 name 或 config 无效'); continue; }
    const entry = {name:raw.name,enabled:raw.enabled !== false,description:raw.description ?? null,example:raw.example ?? null,config:raw.config ?? {}};
    const current = repo.tools.overlay(raw.name);
    if (!current || stableStringify({...current,updatedAt:undefined}) !== stableStringify(entry)) summary.overlays.push(entry);
  }
  try {
    const definitions = new Set((config.settings?.['triggers.library'] !== undefined ? normalizeDefinitions(config.settings['triggers.library']) : readDefinitions(settings)).map(d=>d.id));
    const incoming = (config.tasks ?? []).flatMap(t=>t.triggers ?? []);
    for (const trigger of incoming) if (trigger.spec?.definitionId && !definitions.has(trigger.spec.definitionId)) problems.push('触发引用不存在：'+trigger.spec.definitionId);
    if (config.settings?.['triggers.library'] !== undefined) {
      for (const trigger of repo.triggers.listAll()) if (trigger.spec?.definitionId && !definitions.has(trigger.spec.definitionId)) problems.push('触发库不能移除仍被任务使用的ID：'+trigger.spec.definitionId);
    }
  } catch(error) { problems.push('触发库：'+error.message); }
  const ids = new Set((config.inject?.sections ?? JSON.parse(settings.get('prompt.sections')||'[]')).map(s=>s.id));
  const effectiveContexts = new Map((config.mode==='replace'?[]:repo.contexts.list()).map(c=>[c.name,c]));
  for(const c of config.contexts??[])effectiveContexts.set(c.name,c);
  const effectiveTasks = new Map((config.mode==='replace'?[]:repo.tasks.list()).map(t=>[t.name,t]));
  for(const t of config.tasks??[])effectiveTasks.set(t.name,t);
  for(const [label,items]of [['上下文',effectiveContexts],['任务',effectiveTasks]])for(const [name,row]of items) {
    if(label!=='上下文'&&row.executionTarget?.mode==='dsh-session')continue;
    try { validateResourceReferences(label==='上下文'?row.config?.tools:row.toolPolicy, JSON.parse(config.settings?.['tools.packages'] ?? (config.mode==='replace'?'[]':settings.get('tools.packages')||'[]')), JSON.parse(config.settings?.['tools.databaseSources'] ?? (config.mode==='replace'?'[]':settings.get('tools.databaseSources')||'[]'))); } catch(error){problems.push(`${label}「${name}」：${error.message}`);}
    const bindings = label==='上下文'?row.config?.injection:row.injection;
    for(const binding of Array.isArray(bindings)?bindings:[])if(!ids.has(typeof binding==='string'?binding:binding.id))problems.push(`${label}「${name}」引用不存在的注入资源：${typeof binding==='string'?binding:binding.id}`);
  }
  return { summary, problems, warnings };
}

/** Apply a plan. Validation already passed; each helper is individually atomic. */
export function applyConfig({ repo, settings, config, actor = 'user', afterApply = null, afterRollback = null }) {
  config=translateLegacySources(config,settings);
  const registry = JSON.parse(settings.get('prompt.sections')||'[]');
  const files = new Set([...registry,...(config.inject?.sections??[])].filter(s=>s.source?.path).map(s=>injectionPath(settings,s.source.path)));
  for(const block of config.memory?.blocks??[])files.add(injectionPath(settings,`memory/short-term/${String(block.slug).replace(/[^a-z0-9._-]/gi,'_')}.md`));
  for(const id of ['core','rules'])files.add(injectionPath(settings,`injections/${id}.md`));
  const snapshots = new Map([...files].map(file=>[file,fs.existsSync(file)?fs.readFileSync(file):null]));
  try { return repo.memory.deferProjection(()=>repo.transaction(()=>{const result=applyConfigInner({repo,settings,config,actor});afterApply?.();return result;})); }
  catch(error) {
    const failures=[];
    for(const [file,content]of snapshots)try {if(content===null){if(fs.existsSync(file))fs.rmSync(file,{force:true});}else {fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content);}}catch(restore){failures.push(restore.message);}
    settings.reload();
    try{afterRollback?.();}catch(restore){failures.push(restore.message);}
    if(failures.length)error.message+='；文件恢复失败：'+failures.join('；');
    throw error;
  }
}

function applyConfigInner({ repo, settings, config, actor = 'user' }) {
  if(config.mode === 'replace') {
    try {return repo.transaction(()=>{
      repo.clearConfiguration();
      resetRuntimeSettings(settings);
      settings.set('prompt.sections','[]');
      return applyConfigInner({repo,settings,actor,config:{...config,mode:'merge',inject:config.inject??{sections:[]}}});
    });}catch(error){settings.reload();throw error;}
  }
  let { summary, problems, warnings } = planConfig({ repo, settings, config });
  if (problems.length) {
    throw Object.assign(new Error(problems.join('；')), { code: 'CONFIG_INVALID', status: 400 });
  }
  return repo.memory.deferProjection(() => {
  let result;
  try { result = repo.transaction(() => {
  const channelCount=summary.channels.length;
  for(const e of summary.channels){if(e.id)repo.channels.update(e.id,e);else repo.channels.create(e);}
  ({summary}=planConfig({repo,settings,config}));
  const applied = {
    channels: channelCount, overlays: 0,
    settings: 0,
    secrets: 0,
    sections: 0,
    blocks: 0,
    contexts: 0,
    projects: 0,
    tasks: 0,
    triggers: 0,
  };

  if (summary.settings.length) {
    settings.setMany(Object.fromEntries(summary.settings.map((item) => [item.key, item.after])), actor);
    applied.settings = summary.settings.length;
  }
  for (const secret of summary.secrets) {
    settings.set(secret.key, secret.after);
    applied.secrets += 1;
  }
  if (summary.sections.replace) {
    settings.setMany({ 'prompt.sections': JSON.stringify(summary.sections.replace) }, actor);
    applied.sections = summary.sections.entries;
  }

  for (const block of summary.blocks.create) {
    repo.memory.createBlock(block);
    applied.blocks += 1;
  }
  for (const block of summary.blocks.update) {
    repo.memory.updateBlock(block.slug, block);
    applied.blocks += 1;
  }

  for (const project of summary.projects.create.concat(summary.projects.update)) {
    repo.projects.upsert(project);
    applied.projects += 1;
  }

  const contextIdByName = new Map(repo.contexts.list().map((context) => [context.name, context.id]));
  for (const context of summary.contexts.create) {
    const created = repo.contexts.create({ ...context, note: 'config import' });
    contextIdByName.set(created.name, created.id);
    applied.contexts += 1;
  }
  for (const context of summary.contexts.update) {
    const id = context.id ?? contextIdByName.get(context.name);
    if (!id) continue;
    repo.contexts.rename(id, { name: context.name, description: context.description });
    if (context.configChanged !== false) {
      repo.contexts.saveVersion(id, { config: context.config, note: 'config import' });
    }
    applied.contexts += 1;
  }

  const taskIds = new Map(repo.tasks.list().map((task) => [task.name, task.id]));
  for (const task of summary.tasks.create.concat(summary.tasks.update)) {
    const contextId = task.context ? contextIdByName.get(task.context) ?? null : null;
    const fields = {
      name: task.name,
      kind: task.kind,
      description: task.description,
      enabled: task.enabled,
      goal: task.goal,
      inputTemplate: task.inputTemplate,
      executionTarget:task.executionTarget,
    deliveryTarget:task.deliveryTarget,
    memoryPolicy:task.memoryPolicy,
      conversationMode: task.conversationMode,
      conversationId: task.conversationId,
      contextId,
      projectId: task.projectId,
      maxRuntimeMs: task.maxRuntimeMs,
      archivePolicy: task.archivePolicy,
      toolPolicy: task.toolPolicy,
    injection: task.injection,
    };
    const saved = task.currentId ? repo.tasks.update(task.currentId, fields) : repo.tasks.create(fields);
    taskIds.set(saved.name, saved.id);
    applied.tasks += 1;
  }
  for (const op of summary.triggerOps ?? []) {
    const taskId = op.currentId ?? taskIds.get(op.taskName);
    if (!taskId) continue;
    if (op.matchId) repo.triggers.update(op.matchId, op.trigger);
    else repo.triggers.create(taskId, op.trigger);
    applied.triggers += 1;
  }

  for (const entry of summary.channels) { if (entry.id) repo.channels.update(entry.id,entry); else repo.channels.create(entry); applied.channels++; }
  for (const entry of summary.overlays) { repo.tools.setOverlay(entry.name,entry); applied.overlays++; }
  repo.audit.log('config.apply', 'yu.config', applied, actor);
  return { ...applied, warnings, effectiveFrom: '立即写入；注入段与任务从下一次运行 / 下一个会话生效；工具开放范围及工具注册变化需重启生效' };
  }); } catch(error) { settings.reload(); throw error; }
  for(const section of config.inject?.sections??[])if(section.source && Object.hasOwn(config.inject?.contents??{},section.id))writeInjection(settings,section,config.inject.contents[section.id]);
  migrateInjectionFiles({repo,settings});
  return result;
  });
}

export function createConfigService({
  db,
  repo,
  settings,
  paths,
  log,
  refreshSchedules = null,
  syncChannels = null,
  syncMaintenance = null,
  syncSources = null,
  validateSources = null,
  validatePackages = null,
  writeMemoryFiles = null,
}) {
  // Resolved per call: the data root can move while Yu is running.
  const filePath = () => path.join(paths.dataDir, CONFIG_FILENAME);
  const checkSources = config => {
    if(config.dsh)repo.dshLinks?.validateConfig(config.dsh);
    config=translateLegacySources(config,settings);
    const raw = config.settings?.['tools.databaseSources'] ?? (config.mode==='replace'?'[]':settings.get('tools.databaseSources')??'[]');
    validateSources?.(typeof raw==='string'?JSON.parse(raw):raw);
    const packages=config.settings?.['tools.packages'] ?? (config.mode==='replace'?'[]':settings.get('tools.packages')??'[]');
    validatePackages?.(typeof packages==='string'?JSON.parse(packages):packages);
  };

  return {
    get filePath() {
      return filePath();
    },
    exportText({ includeSecrets = false } = {}) {
      const config = buildConfig({ repo, settings, db, includeSecrets: Boolean(includeSecrets) });
      return { config, text: renderConfig(config), bytes: Buffer.byteLength(renderConfig(config)) };
    },
    preview({ text }) {
      const config = parseConfigText(text);
      const plan = planConfig({ repo, settings, config });
      try{checkSources(config);}catch(error){plan.problems.push('数据源：'+error.message);}
      const { sections, triggerOps, ...rest } = plan.summary;
      return {
        ok: plan.problems.length === 0,
        summary: {
          ...rest,
          sections: { entries: sections.entries, current: sections.current, changed: sections.changed },
        },
        problems: plan.problems,
        warnings: plan.warnings,
        note: plan.problems.length ? '有问题，未应用。' : '校验通过，可以应用。',
      };
    },
    apply({ text, confirm = false }) {
      if (!confirm) {
        throw Object.assign(new Error('应用配置需要显式确认（confirm: true）'), { code: 'CONFIRM_REQUIRED', status: 400 });
      }
      const config = parseConfigText(text);
      checkSources(config);
      const result = applyConfig({ repo, settings, config, afterApply:()=>{syncSources?.();      if(db&&config.libraryPolicies)db.setMeta('memory.libraries.policies',JSON.stringify(config.libraryPolicies));
      if(db&&config.initialization)importInitialization(db,repo,config.initialization);
}, afterRollback:syncSources });
      try { syncChannels?.(); } catch(error) { result.warnings.push('配置已提交，渠道同步失败：' + error.message); }
      // New or changed triggers must enter the scheduler now, or a migration
      // would appear to succeed and then simply not fire until the next restart.
      try {
        // The nightly maintenance task's trigger follows `memory.maintenanceAt`;
        // re-point it before refreshing the rest of the schedule.
        syncMaintenance?.();
      } catch (error) {
        result.warnings.push('配置已提交，维护调度同步失败：' + error.message);
        log?.warn(`re-pointing the maintenance schedule after config import failed: ${error.message}`);
      }
      try {
        refreshSchedules?.();
      } catch (error) {
        result.warnings.push('配置已提交，调度同步失败：' + error.message);
        log?.warn(`refreshing schedules after config import failed: ${error.message}`);
      }
      // Short-term memory is mirrored to text files; an import that only wrote
      // the database would be overwritten by the next "read from files".
      try {
        writeMemoryFiles?.();
      } catch (error) {
        result.warnings.push('配置已提交，记忆投影失败：' + error.message);
        log?.warn(`writing memory files after config import failed: ${error.message}`);
      }
      if(config.dsh)repo.dshLinks?.importConfig(config.dsh);
      else if(config.mode==='replace')repo.dshLinks?.clear();
      const target = filePath();
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, renderConfig(config), { mode: 0o600 });
      } catch (error) {
        result.warnings.push('配置已提交，配置文件写入失败：' + error.message);
        log?.warn(`writing ${CONFIG_FILENAME} after apply failed: ${error.message}`);
      }
      return { ok: true, ...result, filePath: target };
    },
    clear({ confirm = false } = {}) {
      if (!confirm) throw Object.assign(new Error('清空需要 confirm: true'), {status:400});
      try { repo.transaction(() => {
        repo.clearConfiguration();
        repo.dshLinks?.clear();
        resetRuntimeSettings(settings);
        settings.set('prompt.sections','[]');
        repo.audit.log('config.clear','yu.config',{preserved:'memory, conversations, archives, project progress, devices'});
      }); } catch(error) { settings.reload(); throw error; }
      const warnings = [];
      for (const sync of [syncChannels,refreshSchedules,syncSources]) try { sync?.(); } catch(error) { warnings.push('清空已提交，运行同步失败：' + error.message); }
      try { fs.rmSync(filePath(),{force:true}); } catch(error) { warnings.push('数据库已清空，配置文件删除失败：' + error.message); }
      return {ok:true,warnings,effectiveFrom:'渠道与调度立即停止；工具注册变化需重启',preserved:['独立人格文件','短期/长期记忆','对话与归档','项目进度（相同 id 且省略 state 的 JSON 可恢复）','设备登录'],note:'设置恢复内建默认；自动维护关闭，避免重建任务。'};
    },
    readFile() {
      const target = filePath();
      try {
        const text = fs.readFileSync(target, 'utf8');
        return { exists: true, text, path: target, bytes: Buffer.byteLength(text) };
      } catch (error) {
        return { exists: false, text: '', path: target, error: error.code === 'ENOENT' ? null : error.message };
      }
    },
    writeFile({ text }) {
      parseConfigText(text);
      const target = filePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, `${String(text).trimEnd()}\n`, { mode: 0o600 });
      return { ok: true, path: target, bytes: Buffer.byteLength(text) };
    },
  };
}

function translateChannels(value,translate){
 if(Array.isArray(value))return value.map(v=>translateChannels(v,translate));
 if(!value||typeof value!=='object')return value;
 return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,k==='channelId'&&v?translate(v):translateChannels(v,translate)]));
}
function exportInitialization(db,repo){
 const state=JSON.parse(db.getMeta('onboarding.v1')||'null');if(!state?.mode)return null;
 return {mode:state.mode,selection:translateChannels(state.selection,id=>({name:repo.channels.get(id)?.name??id})),roles:Object.fromEntries(Object.entries(state.taskIds??{}).map(([role,id])=>[role,repo.tasks.get(id)?.name]))};
}
function importInitialization(db,repo,raw){
 const ids={};for(const [role,name]of Object.entries(raw.roles??{})){const t=repo.tasks.list().find(t=>t.name===name);if(!t)throw new Error('初始化任务不存在：'+name);ids[role]=t.id;}
 const selection=translateChannels(raw.selection,ref=>repo.channels.list().find(c=>c.name===ref.name)?.id);
 if(raw.mode==='shared')for(const id of Object.values(ids))repo.tasks.setEnabled(id,false);
 selection.authorizeHistory=false;
 db.setMeta('companion.roles.v1',JSON.stringify(Object.fromEntries(Object.entries(ids).filter(([k])=>k!=='maintenance'))));
 if(ids.maintenance)db.setMeta('memory.sync.task.v2',ids.maintenance);
 db.setMeta('onboarding.v1',JSON.stringify({mode:raw.mode,status:raw.mode==='managed'?'ready':'needs-confirmation',selection,taskIds:ids}));
}
