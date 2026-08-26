-- Better Auth 1.7: an account is identified by (issuer, accountId), not by providerId alone.
-- SQLite cannot add a NOT NULL column without a default, and a default ('') would let a worker
-- still on 1.6 write an identity-less row between this migration and its own deploy. So the table
-- is rebuilt with `issuer` NOT NULL and no default: such a write fails instead. The backfill
-- follows the 1.7 upgrade guide: credential rows are `local:credential` keyed by the user id,
-- Google rows carry Google's OIDC issuer, every other OAuth provider gets the synthetic
-- `local:oauth:<providerId>` namespace. The unique index is the collision check: the migration
-- fails, and rolls back, if two rows share an identity.
CREATE TABLE "account_new" (
  "id" text not null primary key,
  "issuer" text not null,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

INSERT INTO "account_new" ("id", "issuer", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
SELECT "id",
  CASE "providerId"
    WHEN 'credential' THEN 'local:credential'
    WHEN 'google' THEN 'https://accounts.google.com'
    ELSE 'local:oauth:' || "providerId"
  END,
  CASE WHEN "providerId" = 'credential' THEN "userId" ELSE "accountId" END,
  "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "account_new" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" ("issuer", "accountId");
