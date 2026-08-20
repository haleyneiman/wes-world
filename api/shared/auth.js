'use strict';

// Static Web Apps validates the sign-in at the edge and passes the identity to
// the API as a base64 JSON header. So the API never verifies a token itself —
// its job is deciding whether THIS identity is allowed near Wesley's data.
//
// Any Microsoft or GitHub account in the world can complete the SWA login, so
// "is signed in" is NOT enough. Access requires the custom `family` role, which
// is granted per-person through the Static Web Apps invite system.
const FAMILY_ROLE = 'family';

function principalFrom(req) {
  const headers = (req && req.headers) || {};
  const raw = headers['x-ms-client-principal'] || headers['X-MS-CLIENT-PRINCIPAL'];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (!parsed || !parsed.userId) return null;
    return {
      userId: parsed.userId,
      userDetails: parsed.userDetails || '',
      identityProvider: parsed.identityProvider || '',
      roles: Array.isArray(parsed.userRoles) ? parsed.userRoles : []
    };
  } catch (err) {
    return null;
  }
}

// The 403 deliberately echoes the caller's own user id: that is the value you
// need to paste into the SWA invite screen to grant yourself the role, and it
// is the caller's own identity, not a leak of anyone else's.
function authorize(req) {
  const principal = principalFrom(req);
  if (!principal) return { ok: false, status: 401, body: { error: 'Not signed in' } };
  if (!principal.roles.includes(FAMILY_ROLE)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'This account is not on the family list yet.',
        userId: principal.userId,
        userDetails: principal.userDetails,
        needsRole: FAMILY_ROLE
      }
    };
  }
  return { ok: true, principal };
}

module.exports = { FAMILY_ROLE, principalFrom, authorize };
