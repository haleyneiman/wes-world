'use strict';

const { authorize } = require('../shared/auth');
const { getContainer, ok, fail } = require('../shared/cosmos');
const { setAchieved } = require('../shared/store');

// POST /api/achieved  { id, date }  — date null clears the milestone.
module.exports = async function (context, req) {
  const auth = authorize(req);
  if (!auth.ok) return ok(context, auth.body, auth.status);
  const body = req.body || {};
  try {
    ok(context, await setAchieved(getContainer(), body.id, body.date === undefined ? null : body.date));
  } catch (err) {
    fail(context, err);
  }
};
