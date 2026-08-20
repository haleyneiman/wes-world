#!/usr/bin/env node
'use strict';

// Moves a Firebase Realtime Database export into the Cosmos container.
//
//   1. Firebase console → Realtime Database → ⋮ → Export JSON
//   2. node tools/migrate-from-firebase.js <export.json>            (dry run)
//   3. node tools/migrate-from-firebase.js <export.json> --write    (for real)
//
// Firebase push keys are reused as Cosmos document ids, and the write is an
// upsert, so running it twice imports the same history once — safe to re-run if
// it stops half way.

const fs = require('fs');
const path = require('path');

const BUCKET_TO_KIND = { feedLogs: 'feed', sleepLogs: 'sleep', weightLogs: 'weight' };
const RESERVED = new Set(['id', 'kind', '_rid', '_self', '_etag', '_attachments', '_ts', '_key']);

// Cosmos ids cannot contain / \ ? #, and Firebase push keys can contain '-'
// which is fine — but a hand-edited key might not be.
function safeId(key) {
  return String(key).replace(/[\/\\?#]/g, '_');
}

function toDocs(exported) {
  const root = exported && (exported.wesworld || exported);
  const docs = [];
  const problems = [];

  Object.keys(BUCKET_TO_KIND).forEach(bucket => {
    const rows = root[bucket];
    if (!rows) return;
    Object.keys(rows).forEach(key => {
      const val = rows[key];
      if (!val || typeof val !== 'object') {
        problems.push(bucket + '/' + key + ': not an object, skipped');
        return;
      }
      const doc = { id: safeId(key), kind: BUCKET_TO_KIND[bucket] };
      Object.keys(val).forEach(f => {
        if (RESERVED.has(f)) return;
        if (val[f] !== undefined && val[f] !== null) doc[f] = val[f];
      });
      docs.push(doc);
    });
  });

  if (root.achieved && typeof root.achieved === 'object') {
    const map = {};
    Object.keys(root.achieved).forEach(k => { map[k] = root.achieved[k]; });
    docs.push({ id: 'achieved', kind: 'meta', map: map });
  }
  return { docs: docs, problems: problems };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find(a => !a.startsWith('--'));
  const write = args.includes('--write');
  if (!file) {
    console.error('usage: node tools/migrate-from-firebase.js <export.json> [--write]');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const { docs, problems } = toDocs(raw);

  const counts = docs.reduce((acc, d) => { acc[d.kind] = (acc[d.kind] || 0) + 1; return acc; }, {});
  console.log('Parsed ' + docs.length + ' documents:', counts);
  problems.forEach(p => console.warn('  ! ' + p));

  if (!write) {
    console.log('\nDry run — nothing written. Sample document:');
    console.log(JSON.stringify(docs[0], null, 2));
    console.log('\nRe-run with --write to load these into Cosmos.');
    return;
  }

  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    console.error('Set COSMOS_CONNECTION_STRING before running with --write.');
    process.exit(1);
  }
  const { CosmosClient } = require('@azure/cosmos');
  const container = new CosmosClient(conn)
    .database(process.env.COSMOS_DATABASE || 'wesworld')
    .container(process.env.COSMOS_CONTAINER || 'entries');

  let done = 0;
  for (const doc of docs) {
    await container.items.upsert(doc);
    done++;
    if (done % 25 === 0 || done === docs.length) {
      process.stdout.write('\r  wrote ' + done + '/' + docs.length);
    }
  }
  console.log('\nDone.');
}

module.exports = { toDocs, safeId };

if (require.main === module) {
  main().catch(err => { console.error('\n' + (err && err.message || err)); process.exit(1); });
}
