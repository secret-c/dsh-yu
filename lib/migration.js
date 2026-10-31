import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { now, truncate } from './util.js';

/**
 * Legacy Yu migration.
 *
 * Read-only on the source: nothing under the legacy root is ever written or
 * moved. The preview names every artefact it found, whether it can map it, and
 * why not; the import copies mapped text into Yu's own store with a provenance
 * header, leaving the original file in place.
 *
 * This is the "copy rehearsal" the delivery requires: the target is Yu's own
 * database, not the legacy installation.
 */
const ARTIFACTS = [
  { key: 'core', rel: 'persona/core.md', kind: 'persona', label: '核心设定' },
  { key: 'style', rel: 'persona/style.md', kind: 'persona', label: '说话风格' },
  { key: 'self', rel: 'persona/self.md', kind: 'persona', label: '自我认识' },
  { key: 'owner', rel: 'memory/owner.md', kind: 'memory', label: '主人画像' },
  { key: 'peopleIndex', rel: 'memory/people/index.json', kind: 'memory-index', label: '人物索引' },
];

export function createMigrationService({ repo, paths, settings, log, version }) {
  const root = (input) => {
    const candidate = String(input ?? '').trim();
    if (!candidate) throw new Error('请选择旧版 Yu 数据目录');
    return path.resolve(candidate);
  };

  const readIfExists = (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
  };

  const sha = (text) => crypto.createHash('sha256').update(String(text ?? '')).digest('hex');

  const scan = (legacyRoot) => {
    const base = root(legacyRoot);
    const found = [];
    for (const artifact of ARTIFACTS) {
      const full = path.join(base, artifact.rel);
      const text = readIfExists(full);
      found.push({
        ...artifact,
        path: full,
        exists: text !== null,
        bytes: text ? Buffer.byteLength(text) : 0,
        sha256: text ? sha(text) : null,
        preview: text ? truncate(text, 300) : null,
      });
    }
    const peopleDir = path.join(base, 'memory', 'people');
    let people = [];
    try {
      people = fs
        .readdirSync(peopleDir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const full = path.join(peopleDir, f);
          const text = readIfExists(full) ?? '';
          return { file: f, path: full, bytes: Buffer.byteLength(text), sha256: sha(text) };
        });
    } catch {
      people = [];
    }
    const groupsDir = path.join(base, 'memory', 'groups');
    let groups = [];
    try {
      groups = fs
        .readdirSync(groupsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      groups = [];
    }
    const knowledgeCandidates = [
      path.join(base, 'data', 'knowledge', 'knowledge.sqlite3'),
      path.join(base, 'knowledge.sqlite3'),
    ];
    const knowledge = knowledgeCandidates.find((p) => fs.existsSync(p)) ?? null;
    return { base, found, people, groups, knowledge };
  };

  const preview = (legacyRoot) => {
    const scanned = scan(legacyRoot);
    const missing = scanned.found.filter((a) => !a.exists);
    const mapped = [];
    const unmapped = [];

    for (const artifact of scanned.found) {
      if (!artifact.exists) continue;
      if (artifact.key === 'style') mapped.push({ source: artifact.path, target: 'style 版本（source=migration）' });
      else if (artifact.key === 'owner') mapped.push({ source: artifact.path, target: '记忆块 owner（类别 people）' });
      else if (artifact.key === 'core') unmapped.push({ source: artifact.path, reason: 'core 由用户在 Yu 中单独维护；迁移只提供参考副本' });
      else if (artifact.key === 'self') unmapped.push({ source: artifact.path, reason: '自我认识并入 style 正文，需人工确认后再发布' });
      else if (artifact.key === 'peopleIndex') mapped.push({ source: artifact.path, target: '记忆块 people-index（类别 people）' });
    }
    if (scanned.people.length) {
      mapped.push({ source: `${scanned.people.length} 个 memory/people/*.md`, target: '合并进记忆块 owner（人物片段）' });
    }
    if (scanned.groups.length) {
      unmapped.push({
        source: `memory/groups/*（${scanned.groups.length} 组）`,
        reason: '群聊梗词典/大事记属于派生分析结果，建议在新系统中由归档重新生成',
      });
    }
    if (scanned.knowledge) {
      mapped.push({ source: scanned.knowledge, target: '工具页 knowledge 数据库路径（只读引用，不复制）' });
    }
    return {
      legacyRoot: scanned.base,
      exists: fs.existsSync(scanned.base),
      artifacts: scanned.found,
      people: { count: scanned.people.length, sample: scanned.people.slice(0, 5) },
      groups: scanned.groups,
      knowledge: scanned.knowledge,
      mapped,
      unmapped,
      missing: missing.map((m) => m.path),
      dryRun: true,
      note: '预览不会写入任何数据，也不会修改旧目录中的任何文件。',
    };
  };

  const importData = ({ legacyRoot, includeStyle = true, includeOwner = true, includePeople = true, confirm = false }) => {
    if (!confirm) {
      const error = new Error('导入需要显式确认（confirm: true）');
      error.status = 400;
      error.code = 'CONFIRM_REQUIRED';
      throw error;
    }
    const scanned = scan(legacyRoot);
    if (!fs.existsSync(scanned.base)) {
      const error = new Error(`旧目录不存在：${scanned.base}`);
      error.status = 404;
      error.code = 'LEGACY_ROOT_MISSING';
      throw error;
    }
    const actions = [];
    const styleArtifact = scanned.found.find((a) => a.key === 'style');
    const ownerArtifact = scanned.found.find((a) => a.key === 'owner');
    const coreArtifact = scanned.found.find((a) => a.key === 'core');
    const selfArtifact = scanned.found.find((a) => a.key === 'self');

    if (includeStyle && styleArtifact?.exists) {
      const body = [
        `<!-- source: ${styleArtifact.path} sha256:${styleArtifact.sha256} imported:${new Date().toISOString()} -->`,
        readIfExists(styleArtifact.path),
        selfArtifact?.exists ? `\n\n## 自我认识\n\n${readIfExists(selfArtifact.path)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      const published = repo.style.publish({ content: body, note: 'migrated from legacy Yu', source: 'migration' });
      actions.push({ type: 'style', version: published.version, source: styleArtifact.path });
    }

    if (includeOwner && ownerArtifact?.exists) {
      const existing = repo.memory.blockBySlug('owner');
      const content = [
        `<!-- source: ${ownerArtifact.path} sha256:${ownerArtifact.sha256} imported:${new Date().toISOString()} -->`,
        readIfExists(ownerArtifact.path),
      ].join('\n');
      const block = existing
        ? repo.memory.updateBlock('owner', { ...existing, content })
        : repo.memory.createBlock({ slug: 'owner', name: '主人画像', category: 'people', content, orderIndex: 60 });
      actions.push({ type: 'memory-block', slug: block.slug, source: ownerArtifact.path });
    }

    if (includePeople && scanned.people.length) {
      const parts = scanned.people.slice(0, 60).map((person) => {
        const text = readIfExists(person.path) ?? '';
        return `#### ${person.file.replace(/\.md$/, '')}\n\n<!-- source: ${person.path} sha256:${person.sha256} -->\n\n${text}`;
      });
      const existing = repo.memory.blockBySlug('people-index');
      const content = parts.join('\n\n');
      const block = existing
        ? repo.memory.updateBlock('people-index', { ...existing, content })
        : repo.memory.createBlock({
            slug: 'people-index',
            name: '人物档案（迁移）',
            category: 'people',
            content,
            orderIndex: 70,
          });
      actions.push({ type: 'memory-block', slug: block.slug, count: scanned.people.length });
    }

    if (coreArtifact?.exists) {
      actions.push({
        type: 'skipped',
        source: coreArtifact.path,
        reason: 'core 需要在 Yu 的「设置 · 核心设定」中人工确认后再保存，避免把旧文本直接当成权威',
      });
    }

    if (scanned.knowledge) {
      try {
        settings.set('tools.knowledgeDbPath', scanned.knowledge);
        actions.push({ type: 'setting', key: 'tools.knowledgeDbPath', value: scanned.knowledge });
      } catch (error) {
        actions.push({ type: 'setting-failed', key: 'tools.knowledgeDbPath', error: error.message });
      }
    }

    repo.audit.log('migration.import', scanned.base, { actions }, 'user');
    log?.info(`legacy migration imported ${actions.length} action(s) from ${scanned.base}`);
    return {
      ok: true,
      legacyRoot: scanned.base,
      actions,
      originalsUntouched: true,
      schemaVersion: version,
      importedAt: now(),
    };
  };

  return { preview, import: importData, scan };
}
