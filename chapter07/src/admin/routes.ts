// Admin HTTP API
//
// Routes from v0.4 (kept):
//   POST   /admin/orgs                  Create an org
//   POST   /admin/users                 Create a user
//   POST   /admin/keys                  Issue an API key
//   GET    /admin/keys?userId=          List keys (masked + v0.6 limit settings / monthly quota)
//   DELETE /admin/keys/:id              Revoke a key
//
// Routes from v0.5 (kept):
//   POST   /admin/users/:id/balance     Adjust user balance
//   POST   /admin/users/:id/multiplier  Set user pricing multiplier
//   GET    /admin/prices                List price table
//   POST   /admin/prices                Update prices
//   GET    /admin/usage                 Query usage records
//
// New routes in v0.6:
//   POST   /admin/keys/:id/limits       Set key-level rate limits / monthly quota
//                                       body: { qpsLimit?, tpmLimit?, monthlyQuotaCny? }
//   GET    /admin/keys/:id/usage-window Get key's current-second QPS / current-minute TPM / monthly balance
//
// All routes are protected by requireAdminToken().

