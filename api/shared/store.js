'use strict';

const { randomUUID } = require('crypto');

// One Cosmos container holds everything, partitioned by `kind`. The three log
// kinds map onto the arrays the app already expects, and achieved milestones
// live in a single `meta` document rather than one document per milestone.
const KIND_TO_BUCKET = { feed: 'feedLogs', sleep: 'sleepLogs', weight: 'weightLogs' };
const ACHIEVED_ID = 'achieved';
const META_KIND = 'meta';

function isKind(kind) {
  return Object.prototype.hasOwnProperty.call(KIND_TO_BUCKET, kind);
}

class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// Cosmos bookkeeping fields and the routing fields are owned by the server, so
// a client payload is never allowed to set them.
const RESERVED = new Set(['id', 'kind', '_rid', '_self', '_etag', '_attachments', '_ts', '_key']);
function sanitize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new BadRequest('Entry body must be an object');
  }
  const out = {};
  Object.keys(data).forEach(k => {
    if (RESERVED.has(k)) return;
    if (data[k] !== undefined) out[k] = data[k];
  });
  return out;
}

// Strips Cosmos internals and re-exposes the document id as `_key`, which is
// the name the app already uses to identify a log row.
function toClient(doc) {
  const out = {};
  Object.keys(doc).forEach(k => {
    if (RESERVED.has(k)) return;
    out[k] = doc[k];
  });
  out._key = doc.id;
  return out;
}

async function getState(container) {
  const { resources } = await container.items.query({ query: 'SELECT * FROM c' }).fetchAll();
  const state = { feedLogs: [], sleepLogs: [], weightLogs: [], achieved: {} };
  resources.forEach(doc => {
    if (doc.kind === META_KIND) {
      if (doc.id === ACHIEVED_ID) state.achieved = doc.map || {};
      return;
    }
    const bucket = KIND_TO_BUCKET[doc.kind];
    if (bucket) state[bucket].push(toClient(doc));
  });
  // Newest first, matching the order the app's own objToArr used to produce —
  // the rendering code was written against that contract.
  Object.keys(KIND_TO_BUCKET).forEach(kind => {
    state[KIND_TO_BUCKET[kind]].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  });
  return state;
}

// The id may be supplied by the client so a create is idempotent: if the write
// succeeded but the response was lost on bad wifi, the retry upserts the same
// document instead of logging the feed twice.
async function createEntry(container, kind, data, id) {
  if (!isKind(kind)) throw new BadRequest('Unknown entry kind: ' + kind);
  const docId = id ? String(id) : randomUUID();
  const doc = Object.assign(sanitize(data), { kind, id: docId });
  const { resource } = await container.items.upsert(doc);
  return { id: (resource && resource.id) || docId };
}

function notFound() {
  const err = new Error('Entry not found');
  err.status = 404;
  return err;
}

// A missing document shows up two different ways depending on SDK version and
// call: an undefined resource, or a thrown error carrying code 404. The other
// parent deleting a row while this one has it open is a normal race, so both
// have to resolve to a clean 404 rather than an alarming 500.
function isMissing(err) {
  return err && (err.code === 404 || err.statusCode === 404);
}

async function readEntry(container, kind, id) {
  try {
    const res = await container.item(id, kind).read();
    if (!res || !res.resource) throw notFound();
    return res.resource;
  } catch (err) {
    if (isMissing(err)) throw notFound();
    throw err;
  }
}

async function updateEntry(container, kind, id, data) {
  if (!isKind(kind)) throw new BadRequest('Unknown entry kind: ' + kind);
  if (!id) throw new BadRequest('Missing entry id');
  const existing = await readEntry(container, kind, id);
  const merged = Object.assign({}, existing, sanitize(data), { kind, id });
  await container.item(id, kind).replace(merged);
  return { id };
}

async function deleteEntry(container, kind, id) {
  if (!isKind(kind)) throw new BadRequest('Unknown entry kind: ' + kind);
  if (!id) throw new BadRequest('Missing entry id');
  try {
    await container.item(id, kind).delete();
  } catch (err) {
    // Deleting something already gone is the desired end state, so treat it as
    // success — otherwise a retried offline delete fails forever.
    if (isMissing(err)) return { id, alreadyGone: true };
    throw err;
  }
  return { id };
}

// Milestones toggle on and off, so a null date removes the key rather than
// storing an empty value the app would then have to treat as "not achieved".
async function setAchieved(container, milestoneId, date) {
  if (milestoneId === undefined || milestoneId === null || milestoneId === '') {
    throw new BadRequest('Missing milestone id');
  }
  const key = String(milestoneId);
  const item = container.item(ACHIEVED_ID, META_KIND);
  let doc = null;
  try {
    const res = await item.read();
    doc = res.resource || null;
  } catch (err) {
    if (err && err.code !== 404) throw err;
  }
  if (!doc) doc = { id: ACHIEVED_ID, kind: META_KIND, map: {} };
  if (!doc.map) doc.map = {};
  if (date === null || date === undefined || date === false) delete doc.map[key];
  else doc.map[key] = date;
  await container.items.upsert(doc);
  return { achieved: doc.map };
}

module.exports = {
  KIND_TO_BUCKET, ACHIEVED_ID, META_KIND, BadRequest,
  isKind, sanitize, toClient,
  getState, createEntry, updateEntry, deleteEntry, setAchieved
};
