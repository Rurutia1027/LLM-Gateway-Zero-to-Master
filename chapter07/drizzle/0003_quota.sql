-- Drizzle Migration 0003: v0.6 Rate Limiting + Monthly Quotas 
-- 
-- Changes: 
-- 1. Add five columns to the keys table: 
--    qps_limit / tpm_limit / monthly_quota_micro / monthly_used_micro / quota_reset_at. 
--    These columns are used to configure rate limits and monthly quota limits 
--    at the API key level . 
-- 2. No changes to the users / orgs / usage_records / prices tables. 
--    Rate limiting is a new dimension, so we can reuse the existing 
--    two phase billing pipeline introduced in Ch5. 
-- Field descriptions:

-- qps_limit: Maximum requests per second allowed for this key. 0 = unlimited. 

-- tpm_limit: Maximum number of tokens allowed per minute (total input + output tokens). 0 = unlimited. 

-- monthly_quota_micro: Monthly spending quota limit in micro-CNY. 0 = unlimited. 
--                      Requests that exceed the quota return HTTP 402. 

-- monthly_used_micro: Total amount spend during the current month in micro-CNY.
--                      Incremented during postConsume 


-- quota_reset_at: Unix timestamp in milliseconds when the monthly usage counter was last reset. 
--                 The counter is reset when a new month begins. 


ALTER TABLE `keys` ADD COLUMN `qps_limit` integer NOT NULL DEFAULT 0; 
ALTER TABLE `keys` ADD COLUMN `tpm_limit` integer NOT NULL DEFAULT 0; 
ALTER TABLE `keys` ADD COLUMN `monthly_quota_micro` integer NOT NULL DEFAULT 0; 
ALTER TABLE `keys` ADD COLUMN `monthly_used_micro` integer NOT NULL DEFAULT 0; 
ALTER TABLE `keys` ADD COLUMN `quota_reset_at` integer NOT NULL DEFAULT 0; 