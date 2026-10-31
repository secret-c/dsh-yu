import test from 'node:test';
import assert from 'node:assert/strict';
import {createKnowledgeTools} from '../lib/tools-knowledge.js';
test('knowledge adapter requires explicit managed provider and cannot discover legacy files',()=>{
 const service=createKnowledgeTools({settings:{get:()=>'/any/legacy.sqlite'},paths:{dataDir:'/legacy',files:'/legacy/files'}});
 assert.equal(service.search({query:'test'}).error.code,'SOURCE_DISABLED');
 assert.equal(service.status().error.code,'SOURCE_DISABLED');
 assert.deepEqual(service.definitions.map(d=>d.name),['arknights_lookup','arknights_relics']);
});
