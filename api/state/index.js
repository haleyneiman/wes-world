'use strict';

const { authorize } = require('../shared/auth');
const { getContainer, ok, fail } = require('../shared/cosmos');
const { getState } = require('../shared/store');

// GET /api/state — the whole dataset in the shape the app already renders.
// Small enough to send whole (a few thousand short rows), which keeps the
// client's polling logic to a single request.
module.exports = async function (context, req) {
  const auth = authorize(req);
  if (!auth.ok) return ok(context, auth.body, auth.status);
  try {
    ok(context, await getState(getContainer()));
  } catch (err) {
    fail(context, err);
  }
};
