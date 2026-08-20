'use strict';

const { authorize } = require('../shared/auth');
const { getContainer, ok, fail } = require('../shared/cosmos');
const { createEntry, updateEntry, deleteEntry } = require('../shared/store');

// POST   /api/entries/{kind}       — add a feed / sleep / weight row
// PATCH  /api/entries/{kind}/{id}  — edit one
// DELETE /api/entries/{kind}/{id}  — remove one
module.exports = async function (context, req) {
  const auth = authorize(req);
  if (!auth.ok) return ok(context, auth.body, auth.status);

  const kind = context.bindingData.kind;
  const id = context.bindingData.id;
  const method = (req.method || '').toUpperCase();

  try {
    const container = getContainer();
    // `id` in the body is optional and, when present, makes the create
    // idempotent; sanitize() keeps it out of the stored fields.
    if (method === 'POST') {
      const body = req.body || {};
      return ok(context, await createEntry(container, kind, body, body.id), 201);
    }
    if (method === 'PATCH') return ok(context, await updateEntry(container, kind, id, req.body));
    if (method === 'DELETE') return ok(context, await deleteEntry(container, kind, id));
    ok(context, { error: 'Unsupported method ' + method }, 405);
  } catch (err) {
    fail(context, err);
  }
};
