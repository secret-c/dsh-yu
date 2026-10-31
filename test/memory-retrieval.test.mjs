import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMemories, tokenize } from '../lib/memories.js';

/**
 * Retrieval used to read only the newest 2,000 rows, which made the search page
 * and the model disagree: the page found a fact, the prompt never saw it. The
 * candidate pool is now explicit and the scoring pass receives it.
 */
test('retrieval reads the configured candidate pool, not the page-sized list', () => {
  const row = {
    id: 'm_old',
    kind: 'fact',
    subject: '思华年',
    text: '明日方舟肉鸽玩家，研究不期节点和轴',
    tags: [],
    hits: 1,
    weight: 1,
    status: 'active',
    firstSeenAt: 1,
    lastSeenAt: 2,
    sourceArchiveId: null,
  };
  let seenLimit = null;
  const repo = {
    memories: {
      searchCandidates({ limit }) {
        seenLimit = limit;
        return [row];
      },
    },
  };
  const hits = searchMemories(repo, { query: '明日方舟今天有什么活动', limit: 6, searchPool: 18000 });
  assert.equal(seenLimit, 18000);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, 'm_old');
});

test('the CJK tokenizer keeps whole short runs and bigrams for scoring', () => {
  const terms = tokenize('明日方舟');
  assert.ok(terms.includes('明日方舟') || terms.includes('明日'));
  assert.ok(terms.includes('方舟'));
});
