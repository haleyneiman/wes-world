'use strict';

const { CosmosClient } = require('@azure/cosmos');

// Deliberately does NOT create the database or container. Creating them from
// code would provision throughput on first run, which is the usual way a "free"
// Cosmos account starts billing. The database and container are created once,
// by hand, with the free-tier discount applied; this only connects.
let cached = null;

function getContainer() {
  if (cached) return cached;
  const conn = process.env.COSMOS_CONNECTION_STRING;
  if (!conn) {
    const err = new Error('COSMOS_CONNECTION_STRING is not configured on this Static Web App.');
    err.status = 500;
    throw err;
  }
  const client = new CosmosClient(conn);
  cached = client
    .database(process.env.COSMOS_DATABASE || 'wesworld')
    .container(process.env.COSMOS_CONTAINER || 'entries');
  return cached;
}

// Shared response plumbing so every function reports failures the same way.
function ok(context, body, status) {
  context.res = {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: body === undefined ? {} : body
  };
}

function fail(context, err) {
  // A missing container surfaces from Cosmos as a 404 on every call, which is
  // far more confusing than saying so outright.
  if (err && err.code === 404 && !err.status) {
    context.log.error('Cosmos returned 404 — database/container may not exist', err.message);
    ok(context, { error: 'Cosmos database or container not found. Check COSMOS_DATABASE and COSMOS_CONTAINER.' }, 500);
    return;
  }
  const status = (err && err.status) || 500;
  if (status >= 500) context.log.error(err);
  ok(context, { error: (err && err.message) || 'Unexpected error' }, status);
}

module.exports = { getContainer, ok, fail };
