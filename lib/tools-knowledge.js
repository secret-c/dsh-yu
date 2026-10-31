import { truncate } from './util.js';

/**
 * The Arknights knowledge tools — the first real diagnostic case.
 *
 * Data source: a local, read-only SQLite corpus (documents + FTS5 + entities +
 * skill tables) built from public sources. No network at query time, so a result
 * is reproducible and its provenance can be shown.
 *
 * Every failure is returned in-band as `{ok:false,error:{code,message}}` rather
 * than thrown: the model sees why a lookup failed, which is the whole point of
 * the diagnosis page.
 */



export const COVERAGE_NOTE =
  '数据来自本地只读知识库：PRTS 文本切片 + 社区游戏数据。命中数为 0 只代表本库未索引，不代表游戏内不存在。';

const coverage = (db) => {
  const out = {};
  for (const row of db.prepare('SELECT corpus, COUNT(*) c FROM entities GROUP BY corpus').all()) {
    out[row.corpus] = row.c;
  }
  return out;
};

const sourceOf = (db, sourceId) => {
  if (!sourceId) return null;
  const row = db.prepare('SELECT id, path, sha256, kind, bytes, metadata FROM sources WHERE id = ?').get(sourceId);
  if (!row) return null;
  let metadata = null;
  try {
    metadata = row.metadata ? JSON.parse(row.metadata) : null;
  } catch {
    metadata = null;
  }
  return { id: row.id, path: row.path, sha256: row.sha256, kind: row.kind, bytes: row.bytes, metadata };
};

/** `game:char_002_amiya` -> `char_002_amiya` */
const characterIdOf = (entityId) => String(entityId ?? '').replace(/^(game|ark):/, '');

export function createKnowledgeTools({ dbProvider, log }) {
  const withDb = (fn) => {
    const db = dbProvider?.();
    if (!db) return {ok:false,error:{code:'SOURCE_DISABLED',message:'数据源未启用'}};
    const resolved = {};
    try {
      return fn(db, resolved);
    } catch (error) {
      log?.warn(`knowledge query failed: ${error.message}`);
      return { ok: false, error: { code: 'KNOWLEDGE_QUERY_FAILED', message: error.message } };
    }
  };

  const resolveCharacter = (db, nameOrId) => {
    const raw = String(nameOrId ?? '').trim();
    if (!raw) return { ok: false, error: { code: 'CHARACTER_REQUIRED', message: '需要角色名或 character_id' } };
    if (/^char_/.test(raw)) {
      const hit = db.prepare("SELECT id, name FROM entities WHERE id = ? OR id = ?").get(`game:${raw}`, `ark:${raw}`);
      return { ok: true, characterId: raw, displayName: hit?.name ?? raw };
    }
    const rows = db
      .prepare("SELECT id, name, corpus FROM entities WHERE name = ? AND kind = 'character'")
      .all(raw)
      .filter((r) => String(r.id).startsWith('game:char_'));
    const aliasRows = db
      .prepare('SELECT a.alias, e.id, e.name FROM aliases a JOIN entities e ON e.id = a.entity_id WHERE a.alias = ?')
      .all(raw)
      .filter((r) => String(r.id).startsWith('game:char_'));
    const merged = [...rows, ...aliasRows.map((a) => ({ id: a.id, name: a.name }))];
    const unique = [...new Map(merged.map((r) => [r.id, r])).values()];
    if (!unique.length) {
      return { ok: false, error: { code: 'CHARACTER_NOT_FOUND', message: `知识库里没有找到「${raw}」的游戏数据` } };
    }
    if (unique.length > 1) {
      return {
        ok: false,
        error: {
          code: 'AMBIGUOUS_CHARACTER',
          message: `「${raw}」对应多个角色，请指定 character_id`,
          candidates: unique.map((r) => ({ character_id: characterIdOf(r.id), name: r.name })),
        },
      };
    }
    return { ok: true, characterId: characterIdOf(unique[0].id), displayName: unique[0].name };
  };

  const search = (args) => {
    const query = String(args?.query ?? '').trim();
    const limit = Math.min(50, Math.max(1, Number(args?.limit ?? 5)));
    const corpus = args?.corpus ? String(args.corpus) : null;
    if (!query) return { ok: false, error: { code: 'QUERY_REQUIRED', message: '需要 query' } };
    return withDb((db) => {
      const entities = db
        .prepare(
          "SELECT id, name, kind, corpus FROM entities WHERE name LIKE ? OR id LIKE ? ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END LIMIT ?",
        )
        .all(`%${query}%`, `%${query}%`, query, 10)
        .map((row) => {
          const entity = { id: row.id, name: row.name, kind: row.kind, corpus: row.corpus };
          // `undefined` is not lossless JSON: a trap entity without a game
          // character id made the whole lookup fail in the harness. Omit the
          // key instead; the UI and the model can treat absence as "not a
          // playable character".
          if (String(row.id).startsWith('game:char_')) entity.character_id = characterIdOf(row.id);
          return entity;
        });

      let hits = [];
      let searchMode = 'fts';
      try {
        const terms = query
          .split(/[\s,，。、]+/)
          .filter(Boolean)
          .map((t) => `"${t.replace(/"/g, '""')}"`)
          .join(' OR ');
        hits = db
          .prepare(
            `SELECT d.id, d.corpus, d.title, d.locator, d.evidence_type, d.event_date, d.url,
                    snippet(docs_fts, 1, '<b>', '</b>', '…', 24) AS snippet
             FROM docs_fts f JOIN documents d ON d.rowid = f.rowid
             WHERE docs_fts MATCH ? ${corpus ? 'AND d.corpus = ?' : ''}
             ORDER BY rank LIMIT ?`,
          )
          .all(...(corpus ? [terms || `"${query}"`, corpus, limit] : [terms || `"${query}"`, limit]));
      } catch {
        hits = [];
      }
      if (!hits.length) {
        searchMode = 'like';
        hits = db
          .prepare(
            `SELECT id, corpus, title, locator, evidence_type, event_date, url,
                    substr(text, 1, 400) AS snippet
             FROM documents WHERE (title LIKE ? OR text LIKE ?) ${corpus ? 'AND corpus = ?' : ''} LIMIT ?`,
          )
          .all(...(corpus ? [`%${query}%`, `%${query}%`, corpus, limit] : [`%${query}%`, `%${query}%`, limit]));
      }

      return {
        ok: true,
        corpus,
        query,
        searchMode,
        total: hits.length,
        hits: hits.map((row) => ({
          id: row.id,
          corpus: row.corpus,
          title: row.title,
          locator: row.locator,
          evidenceType: row.evidence_type,
          date: row.event_date,
          url: row.url,
          snippet: truncate(String(row.snippet ?? '').replace(/<\/?b>/g, ''), 400),
        })),
        entities,
        coverage: coverage(db),
        coverageNote: COVERAGE_NOTE,
      };
    });
  };

  const skill = (args) => {
    const level = Number(args?.level ?? 0);
    const skillIndex = Number(args?.skill_index ?? 0);
    if (!Number.isInteger(skillIndex) || skillIndex < 1) {
      return { ok: false, error: { code: 'SKILL_INDEX_REQUIRED', message: 'skill_index 必须是 1 起的整数' } };
    }
    if (!Number.isInteger(level) || level < 1 || level > 12) {
      return { ok: false, error: { code: 'LEVEL_REQUIRED', message: 'level 必须是 1..12 的整数' } };
    }
    return withDb((db) => {
      const resolved = resolveCharacter(db, args?.character_id);
      if (!resolved.ok) return resolved;
      const ref = db
        .prepare('SELECT * FROM skill_refs WHERE character_id = ? AND skill_index = ?')
        .get(resolved.characterId, skillIndex);
      if (!ref) {
        const available = db
          .prepare('SELECT skill_index, form FROM skill_refs WHERE character_id = ? ORDER BY skill_index')
          .all(resolved.characterId);
        return {
          ok: false,
          error: {
            code: 'SKILL_NOT_FOUND',
            message: `角色 ${resolved.characterId} 没有第 ${skillIndex} 个技能`,
            available: available.map((r) => ({ skill_index: r.skill_index, form: r.form })),
          },
        };
      }
      const levelRow = db.prepare('SELECT * FROM skill_levels WHERE skill_id = ? AND level = ?').get(ref.skill_id, level);
      if (!levelRow) {
        const levels = db
          .prepare('SELECT level FROM skill_levels WHERE skill_id = ? ORDER BY level')
          .all(ref.skill_id)
          .map((r) => r.level);
        return {
          ok: false,
          error: {
            code: 'LEVEL_NOT_FOUND',
            message: `${ref.skill_id} 在数据库中只有等级 ${levels.join(', ')}`,
            availableLevels: levels,
          },
        };
      }
      let payload = null;
      try {
        payload = JSON.parse(levelRow.payload);
      } catch {
        payload = { raw: levelRow.payload };
      }
      return {
        ok: true,
        corpus: 'arknights_game_data',
        coverage: coverage(db),
        item: [
          {
            character_id: resolved.characterId,
            character_name: resolved.displayName,
            form: ref.form,
            skill_index: skillIndex,
            skill_id: ref.skill_id,
            level,
            level_data: {
              name: payload?.name ?? null,
              description: payload?.description ?? null,
              skillType: payload?.skillType ?? null,
              duration: payload?.duration ?? null,
              spData: payload?.spData ?? null,
              blackboard: payload?.blackboard ?? [],
            },
            skill_source: sourceOf(db, ref.source_id),
            skill_locator: ref.locator,
            level_source: sourceOf(db, levelRow.source_id),
            level_locator: levelRow.locator,
          },
        ],
        coverageNote: COVERAGE_NOTE,
      };
    });
  };

  /** Levels this skill actually has, so the model can see mastery entries exist. */
  const levelsOf = (db, skillId) =>
    db
      .prepare('SELECT level FROM skill_levels WHERE skill_id = ? ORDER BY level')
      .all(skillId)
      .map((row) => row.level);

  /** The requested level, else the closest one the corpus has. */
  const levelRowFor = (db, skillId, level) => {
    const exact = db.prepare('SELECT * FROM skill_levels WHERE skill_id = ? AND level = ?').get(skillId, level);
    if (exact) return exact;
    return (
      db
        .prepare('SELECT * FROM skill_levels WHERE skill_id = ? ORDER BY ABS(level - ?) LIMIT 1')
        .get(skillId, level) ?? null
    );
  };

  const skills = (args) => {
    return withDb((db) => {
      const resolved = resolveCharacter(db, args?.character_id);
      if (!resolved.ok) return resolved;
      // The corpus stores 1–7 plus mastery 8–10; the old clamp to 7 meant the
      // mastery rows were unreachable even though they were in the database.
      const requested = Number(args?.level ?? 7);
      const level = Math.max(1, Math.min(12, Number.isFinite(requested) ? requested : 7));
      const refs = db
        .prepare('SELECT * FROM skill_refs WHERE character_id = ? ORDER BY skill_index')
        .all(resolved.characterId);
      const entries = refs.map((ref) => {
        const levelRow = levelRowFor(db, ref.skill_id, level);
        let payload = null;
        try {
          payload = levelRow ? JSON.parse(levelRow.payload) : null;
        } catch {
          payload = null;
        }
        return {
          skill_index: ref.skill_index,
          form: ref.form,
          skill_id: ref.skill_id,
          name: payload?.name ?? null,
          description: payload?.description ?? null,
          level: levelRow ? levelRow.level : null,
          availableLevels: levelsOf(db, ref.skill_id),
          source: sourceOf(db, ref.source_id),
          locator: ref.locator,
        };
      });
      return {
        ok: true,
        character_id: resolved.characterId,
        character_name: resolved.displayName,
        requestedLevel: level,
        total: entries.length,
        entries,
        coverage: coverage(db),
        coverageNote: COVERAGE_NOTE,
      };
    });
  };

  const status = () => {
    return withDb((db, info) => ({
      ok: true,
      configured: true,
      path: info.resolvedPath,
      coverage: coverage(db),
      documents: db.prepare('SELECT COUNT(*) c FROM documents').get().c,
      sources: db.prepare('SELECT COUNT(*) c FROM sources').get().c,
      skillLevels: db.prepare('SELECT COUNT(*) c FROM skill_levels').get().c,
      hasFts: Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='docs_fts'").get()),
      coverageNote: COVERAGE_NOTE,
    }));
  };

  /**
   * One natural-language door.
   *
   * The three low-level tools asked the model to know a character_id, a skill
   * index and a level before it could answer "银灰三技能是什么". That is a lot
   * of protocol for a companion that just heard a name. This lookup takes the
   * words the user actually said and returns the pieces in one call: resolved
   * entity, the character's skills with level data, and document hits.
   */
  const findSkillCharacter = (query) =>
    withDb((db) => {
      const row = db
        .prepare(
          `SELECT r.character_id
           FROM skill_levels l JOIN skill_refs r ON r.skill_id = l.skill_id
           WHERE l.payload LIKE ? LIMIT 1`,
        )
        .get(`%${query}%`);
      if (!row) return { ok: false };
      const resolved = resolveCharacter(db, row.character_id);
      return resolved.ok ? { ok: true, characterId: resolved.characterId, displayName: resolved.displayName } : { ok: false };
    });

  const lookup = (args) => {
    const query = String(args?.query ?? '').trim();
    const level = Math.max(1, Math.min(12, Number(args?.level ?? 7) || 7));
    const corpus = args?.corpus ? String(args.corpus) : null;
    if (!query) {
      return { ok: false, error: { code: 'QUERY_REQUIRED', message: '需要 query，例如「银灰」或「真银斩」' } };
    }
    const found = search({ query, limit: 6, corpus });
    if (!found.ok) return found;
    const entities = found.entities ?? [];
    const exact = entities.find((entity) => entity.name === query && entity.character_id);
    let characterEntity = exact ?? entities.find((entity) => entity.character_id) ?? null;
    if (!characterEntity) {
      // A skill name is not an entity name. Resolve it through skill_levels so
      // "真银斩" still returns 银灰's three skills instead of an empty result.
      const bySkill = findSkillCharacter(query);
      if (bySkill?.ok) {
        characterEntity = { name: bySkill.displayName, character_id: bySkill.characterId };
      }
    }
    let character = null;
    if (characterEntity) {
      const overview = skills({ character_id: characterEntity.character_id, level });
      if (!overview.ok) {
        character = { character_id: characterEntity.character_id, name: characterEntity.name, error: overview.error };
      } else {
        const details = (overview.entries ?? [])
          .map((entry) => {
            const one = skill({
              character_id: characterEntity.character_id,
              skill_index: entry.skill_index,
              level,
            });
            return one.ok ? one.item?.[0] ?? null : null;
          })
          .filter(Boolean);
        character = {
          character_id: characterEntity.character_id,
          name: characterEntity.name,
          level,
          skills: details,
        };
      }
    }
    // A character's own material (profile sections, voice lines, modules) is
    // linked through `document_entities`; FTS rank alone would bury a profile
    // under whatever line happens to repeat the name. Older corpus copies do not
    // have that table yet, so a missing one degrades to plain search.
    let owned = [];
    if (characterEntity?.character_id) {
      try {
        const rows = withDb((db) =>
          db
            .prepare(
              `SELECT d.id, d.corpus, d.title, d.locator, substr(d.text, 1, 300) AS snippet
                 FROM document_entities de JOIN documents d ON d.id = de.document_id
                WHERE de.entity_id = ? AND de.role = 'owner'
                ORDER BY CASE d.corpus WHEN 'arknights_profile' THEN 0 WHEN 'arknights_voice' THEN 1 ELSE 2 END
                LIMIT 8`,
            )
            .all(`game:${characterEntity.character_id}`),
        );
        owned = Array.isArray(rows) ? rows : [];
      } catch {
        owned = [];
      }
    }
    const documents = [
      ...owned,
      ...(found.hits ?? []).filter((hit) => !owned.some((row) => row.id === hit.id)),
    ].slice(0, 12);
    return {
      ok: true,
      query,
      corpus,
      entities,
      character,
      documents,
      coverage: found.coverage,
      coverageNote: found.coverageNote,
    };
  };

  /**
   * Relic mechanics, not relic prose.
   *
   * Attack relics fall into distinct buckets in the game data: percentages that
   * share one multiplier, a "提升至X倍" final multiplier, flat additions, and
   * conditional/aura effects. The import keeps them in `relic_effects`; this tool
   * answers "which attack relics does 树海 have, and which of them multiply".
   */
  const TOPIC_ALIASES = {
    树海: 'rogue_6',
    黑流树海: 'rogue_6',
    沉沦者的黑流树海: 'rogue_6',
    傀影: 'rogue_1',
    水月: 'rogue_2',
    萨米: 'rogue_3',
    萨卡兹: 'rogue_4',
    岁: 'rogue_5',
    界园: 'rogue_5',
  };

  const normalizeTopic = (value) => {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^rogue_[1-6]$/.test(raw)) return raw;
    if (TOPIC_ALIASES[raw]) return TOPIC_ALIASES[raw];
    for (const [alias, topic] of Object.entries(TOPIC_ALIASES)) {
      if (raw.includes(alias)) return topic;
    }
    return raw;
  };

  const relics = (args) => {
    const attribute = String(args?.attribute ?? 'atk').trim() || 'atk';
    const mode = args?.mode ? String(args.mode).trim() : null;
    const phase = args?.phase ? String(args.phase).trim() : null;
    const damageType = args?.damage_type ? String(args.damage_type).trim() : null;
    const topic = normalizeTopic(args?.topic);
    const keyword = args?.keyword ? String(args.keyword).trim() : null;
    const limit = Math.min(100, Math.max(1, Number(args?.limit ?? 40)));
    return withDb((db) => {
      const hasTable = db
        .prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name='relic_effects'")
        .get();
      if (!hasTable) {
        return {
          ok: false,
          error: { code: 'RELIC_EFFECTS_MISSING', message: '这版知识库还没有 relic_effects 表，需要重新导入藏品机制数据。' },
        };
      }
      const where = ['e.attribute = ?'];
      const params = [attribute];
      if (topic) {
        where.push('e.topic = ?');
        params.push(topic);
      }
      if (phase) {
        where.push('e.phase = ?');
        params.push(phase);
      }
      if (mode) {
        where.push('e.mode = ?');
        params.push(mode);
      }
      if (keyword) {
        where.push('e.relic_name LIKE ?');
        params.push(`%${keyword}%`);
      }
      if (damageType) {
        where.push('e.damage_type = ?');
        params.push(damageType);
      }
      const rows = db
        .prepare(
          `SELECT e.topic, e.relic_id, e.relic_name, e.phase, e.mode, e.trigger, e.amount, e.scope, e.note,
                  e.damage_type, substr(coalesce(d.text, ''), 1, 220) AS usage
             FROM relic_effects e
             LEFT JOIN documents d ON d.id = 'rogue:' || e.topic || ':item:' || e.relic_id
            WHERE ${where.join(' AND ')}
            ORDER BY e.phase, e.mode, e.relic_name
            LIMIT ?`,
        )
        .all(...params, limit);
      const counts = db
        .prepare(
          `SELECT e.phase, e.mode, COUNT(*) n FROM relic_effects e
            WHERE e.attribute = ? ${topic ? 'AND e.topic = ?' : ''}
            GROUP BY e.phase, e.mode ORDER BY e.phase, e.mode`,
        )
        .all(...(topic ? [attribute, topic] : [attribute]));
      const byPhase = {};
      const byMode = {};
      for (const row of counts) {
        byPhase[row.phase] = (byPhase[row.phase] ?? 0) + row.n;
        byMode[row.mode] = (byMode[row.mode] ?? 0) + row.n;
      }
      return {
        ok: true,
        topic,
        attribute,
        phase,
        mode,
        keyword,
        byPhase,
        byMode,
        damageType,
        total: rows.length,
        effects: rows.map((row) => ({
          topic: row.topic,
          relic: row.relic_name || row.relic_id,
          relic_id: row.relic_id,
          phase: row.phase,
          mode: row.mode,
          trigger: row.trigger,
          damage_type: row.damage_type ?? null,
          amount: row.amount,
          scope: row.scope,
          note: row.note,
          usage: truncate(String(row.usage ?? '').replace(/\n+/g, ' / '), 220),
        })),
        coverageNote:
          '局外＝面板加成：多个局外百分比先相加，再与局内整体相乘；局内＝战斗内加成：与干员技能加攻是同一个乘区，直接相加。' +
          '相乘＝独立乘区（如「攻击力提升至140%」）。damage 属性下 damage_type 区分 物理/法术/元素/真实/通用。',
      };
    });
  };

  const output = (label) => ({
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: `${label}\n${JSON.stringify(value, null, 2)}` }],
  });

  const definitions = [
    {
      name: 'arknights_lookup',
      description:
        '查询本地明日方舟知识库。用户提到干员、技能、语音、档案、模组、肉鸽（集成战略）、卫戍协议（自走棋）或关卡时优先用这一个工具：' +
        'query 直接填用户说的名字或词（如「银灰」「真银斩」「静音小队」「黑流树海」），不要自己编 character_id 或 skill_index；' +
        'level 可选 1-12，默认 7：1-7 是技能等级，8-10 是专精一至三。' +
        '用户问「专精三」「满配」「M3」的数值时传 10；技能条目里的 availableLevels 会告诉你哪个技能有专精数据。' +
        'corpus 可选，用来只看某一类：arknights_voice（干员语音）、arknights_profile（干员档案）、arknights_module（模组）、' +
        'arknights_rogue（肉鸽主题/关卡/藏品/事件）、arknights_autochess（卫戍协议羁绊/组合/首领/提示）。' +
        '一次返回匹配实体、该干员的技能与数值、以及文档命中（会优先给该干员自己的档案与语音）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '用户提到的词，例如「银灰」「真银斩」「黑流树海」' },
          level: { type: 'integer', description: '技能等级 1-12，默认 7', minimum: 1, maximum: 12 },
          corpus: {
            type: 'string',
            enum: [
              'arknights_voice',
              'arknights_profile',
              'arknights_module',
              'arknights_rogue',
              'arknights_autochess',
              'arknights_text',
              'hot_archive',
            ],
            description: '只看某一类文档；不传则全文检索所有语料',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: output('arknights_lookup'),
      execute: async (args) => lookup(args),
    },
    {
      name: 'arknights_relics',
      description:
        '查询集成战略（肉鸽）藏品的机制，而不是只查名字。用户问「某主题有哪些加攻藏」「这个藏品是局内还是局外」时用。' +
        'phase：局外＝面板加成，多个局外百分比先相加、再与局内整体相乘（指中狼、发泡胶、圆石祭坛、剑锤）；' +
        '局内＝战斗内加成，与干员技能加攻同一个乘区、直接相加（叙拉古人的愤怒、黑色郁金香、悲伤的红）。' +
        'mode：相加（同层百分比累加）/相乘（独立乘区，如「攻击力提升至140%」）。' +
        'topic 支持 树海/黑流树海/傀影/水月/萨米/萨卡兹/岁/界园 或 rogue_6；attribute 默认 atk。',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: '主题名或 rogue_6；不传则所有主题' },
          phase: { type: 'string', enum: ['局内', '局外'], description: '按作用层过滤' },
          mode: { type: 'string', enum: ['相加', '相乘'], description: '按算术方式过滤' },
          attribute: {
            type: 'string',
            enum: ['atk', 'def', 'max_hp', 'attack_speed', 'damage'],
            description: '属性，默认 atk（攻击力）；damage 表示伤害乘区',
          },
          damage_type: {
            type: 'string',
            enum: ['物理', '法术', '元素', '真实', '通用', '物理/法术'],
            description: 'attribute=damage 时按伤害类型过滤',
          },
          keyword: { type: 'string', description: '按藏品名过滤，如「剑锤」' },
          limit: { type: 'integer', description: '最多返回条数，默认 40', minimum: 1, maximum: 100 },
        },
        additionalProperties: false,
      },
      output: output('arknights_relics'),
      execute: async (args) => relics(args),
    },
  ];

  return {
    definitions,
    lookup,
    search,
    skill,
    skills,
    relics,
    status,
    resolveKnowledgeDb: () => resolveKnowledgeDb({ settings, paths, log }),
  };
}
