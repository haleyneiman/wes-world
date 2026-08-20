'use strict';

// Runs with plain `node` — no Azure resources, no test framework. A fake
// container stands in for Cosmos so the data mapping and the access rules can
// be verified before anything is provisioned.
const assert = require('assert');
const store = require('../shared/store');
const { authorize, principalFrom } = require('../shared/auth');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok  ' + name);
  } catch (err) {
    console.error('  FAIL  ' + name + '\n        ' + err.message);
    process.exitCode = 1;
  }
}

function fakeContainer(seed) {
  const docs = new Map((seed || []).map(d => [d.kind + '::' + d.id, JSON.parse(JSON.stringify(d))]));
  const key = (id, kind) => kind + '::' + id;
  return {
    _docs: docs,
    items: {
      query() {
        return { fetchAll: async () => ({ resources: Array.from(docs.values()) }) };
      },
      async create(doc) {
        if (docs.has(key(doc.id, doc.kind))) {
          const e = new Error('Conflict'); e.code = 409; throw e;
        }
        docs.set(key(doc.id, doc.kind), doc);
        return { resource: doc };
      },
      async upsert(doc) {
        docs.set(key(doc.id, doc.kind), doc);
        return { resource: doc };
      }
    },
    item(id, kind) {
      return {
        async read() {
          const found = docs.get(key(id, kind));
          if (!found) { const e = new Error('Not found'); e.code = 404; throw e; }
          return { resource: found };
        },
        async replace(doc) { docs.set(key(id, kind), doc); return { resource: doc }; },
        async delete() {
          if (!docs.has(key(id, kind))) { const e = new Error('Not found'); e.code = 404; throw e; }
          docs.delete(key(id, kind));
          return {};
        }
      };
    }
  };
}

const principalHeader = p => Buffer.from(JSON.stringify(p), 'utf8').toString('base64');
const reqWith = p => ({ headers: p ? { 'x-ms-client-principal': principalHeader(p) } : {} });

console.log('\nauth');
test('no header is rejected as not signed in', () => {
  const r = authorize(reqWith(null));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
});
test('signed in WITHOUT the family role is refused', () => {
  const r = authorize(reqWith({ userId: 'abc', userDetails: 'someone@example.com', userRoles: ['anonymous', 'authenticated'] }));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403, 'any Microsoft/GitHub account must not get in');
  assert.strictEqual(r.body.userId, 'abc', 'echoes own id so it can be pasted into the invite screen');
});
test('signed in WITH the family role is allowed', () => {
  const r = authorize(reqWith({ userId: 'abc', userRoles: ['authenticated', 'family'] }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.principal.userId, 'abc');
});
test('a malformed header does not throw', () => {
  assert.strictEqual(principalFrom({ headers: { 'x-ms-client-principal': 'not-base64-json' } }), null);
});

console.log('\nsanitize');
test('client cannot set server-owned fields', () => {
  const out = store.sanitize({ amt: 3.5, id: 'hack', kind: 'weight', _etag: 'x', _key: 'y' });
  assert.deepStrictEqual(out, { amt: 3.5 });
});
test('non-object body is rejected', () => {
  assert.throws(() => store.sanitize('nope'), /must be an object/);
});

console.log('\ngetState');
testAsync('maps kinds to buckets, exposes _key, strips internals, sorts by ts', async () => {
  const c = fakeContainer([
    { id: 'f2', kind: 'feed', ts: 200, amt: 4, _etag: 'e', _rid: 'r' },
    { id: 'f1', kind: 'feed', ts: 100, amt: 3 },
    { id: 's1', kind: 'sleep', ts: 50, hours: 8 },
    { id: 'w1', kind: 'weight', ts: 10, kg: 4.2 },
    { id: 'achieved', kind: 'meta', map: { '3': 'Jul 1' } }
  ]);
  const s = await store.getState(c);
  assert.deepStrictEqual(s.feedLogs.map(f => f._key), ['f2', 'f1'], 'newest first, matching objToArr');
  assert.strictEqual(s.feedLogs[0].amt, 4);
  assert.strictEqual(s.feedLogs[0]._etag, undefined, 'Cosmos internals stripped');
  assert.strictEqual(s.feedLogs[0].id, undefined, 'raw id replaced by _key');
  assert.strictEqual(s.feedLogs[0].kind, undefined, 'routing field not leaked to client');
  assert.strictEqual(s.sleepLogs.length, 1);
  assert.strictEqual(s.weightLogs.length, 1);
  assert.deepStrictEqual(s.achieved, { '3': 'Jul 1' }, 'meta doc becomes the achieved map');
});
testAsync('empty container yields empty buckets, not undefined', async () => {
  const s = await store.getState(fakeContainer([]));
  assert.deepStrictEqual(s, { feedLogs: [], sleepLogs: [], weightLogs: [], achieved: {} });
});

console.log('\nentries');
testAsync('create assigns an id and the kind', async () => {
  const c = fakeContainer([]);
  const r = await store.createEntry(c, 'feed', { amt: 3.2, ts: 1 });
  assert.ok(r.id && r.id.length > 10, 'got a generated id');
  const s = await store.getState(c);
  assert.strictEqual(s.feedLogs.length, 1);
  assert.strictEqual(s.feedLogs[0].amt, 3.2);
});
testAsync('a client-supplied id makes create idempotent, so a retry cannot duplicate', async () => {
  const c = fakeContainer([]);
  await store.createEntry(c, 'feed', { amt: 3.2, ts: 1 }, 'fixed-id');
  await store.createEntry(c, 'feed', { amt: 3.2, ts: 1 }, 'fixed-id');
  const s = await store.getState(c);
  assert.strictEqual(s.feedLogs.length, 1, 'retried write did not create a second feed');
  assert.strictEqual(s.feedLogs[0]._key, 'fixed-id');
});
testAsync('create rejects an unknown kind', async () => {
  await assert.rejects(() => store.createEntry(fakeContainer([]), 'diapers', {}), /Unknown entry kind/);
});
testAsync('update merges rather than replacing wholesale', async () => {
  const c = fakeContainer([{ id: 'f1', kind: 'feed', amt: 3, ts: 5, by: 'Haley' }]);
  await store.updateEntry(c, 'feed', 'f1', { amt: 4.5 });
  const s = await store.getState(c);
  assert.strictEqual(s.feedLogs[0].amt, 4.5, 'changed field applied');
  assert.strictEqual(s.feedLogs[0].by, 'Haley', 'untouched field preserved');
});
testAsync('update of a missing row is a 404', async () => {
  const c = fakeContainer([]);
  await assert.rejects(() => store.updateEntry(c, 'feed', 'nope', { amt: 1 }), err => err.status === 404);
});
testAsync('delete removes the row', async () => {
  const c = fakeContainer([{ id: 'f1', kind: 'feed', amt: 3, ts: 1 }]);
  await store.deleteEntry(c, 'feed', 'f1');
  assert.strictEqual((await store.getState(c)).feedLogs.length, 0);
});
testAsync('delete needs an id', async () => {
  await assert.rejects(() => store.deleteEntry(fakeContainer([]), 'feed', undefined), /Missing entry id/);
});
testAsync('deleting an already-gone row succeeds, so a retried offline delete settles', async () => {
  const r = await store.deleteEntry(fakeContainer([]), 'feed', 'vanished');
  assert.strictEqual(r.alreadyGone, true);
});
testAsync('update surfaces a thrown Cosmos 404 as a clean 404', async () => {
  // read() throwing (rather than returning an undefined resource) is the case
  // that previously escaped as a confusing 500.
  const c = fakeContainer([]);
  await assert.rejects(() => store.updateEntry(c, 'feed', 'gone', { amt: 1 }), err => err.status === 404);
});

console.log('\nachieved');
testAsync('sets a milestone when the meta doc does not exist yet', async () => {
  const c = fakeContainer([]);
  await store.setAchieved(c, 7, 'Jul 30');
  assert.deepStrictEqual((await store.getState(c)).achieved, { '7': 'Jul 30' });
});
testAsync('clearing a milestone removes the key entirely', async () => {
  const c = fakeContainer([{ id: 'achieved', kind: 'meta', map: { '7': 'Jul 30', '8': 'Jul 31' } }]);
  await store.setAchieved(c, 7, null);
  const s = await store.getState(c);
  assert.deepStrictEqual(s.achieved, { '8': 'Jul 31' });
  assert.ok(!('7' in s.achieved), 'key gone, not left as empty/false');
});
testAsync('milestone id is required', async () => {
  await assert.rejects(() => store.setAchieved(fakeContainer([]), '', 'Jul 1'), /Missing milestone id/);
});

process.on('exit', () => {
  console.log('\n' + passed + ' passed' + (process.exitCode ? ', SOME FAILED' : '') + '\n');
});
