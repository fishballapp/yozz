-- Better Auth 1.7.3 restored account identity to (providerId, accountId) and no longer writes
-- issuer. Rebuild the table to the library's current schema; keeping issuer NOT NULL would make
-- every new credential or OAuth account fail at insert time.
CREATE TABLE "account_without_issuer" (
  "id" text not null primary key,
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

INSERT INTO "account_without_issuer" ("id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt")
SELECT "id", "accountId", "providerId", "userId", "accessToken", "refreshToken", "idToken", "accessTokenExpiresAt", "refreshTokenExpiresAt", "scope", "password", "createdAt", "updatedAt"
FROM "account";

DROP TABLE "account";
ALTER TABLE "account_without_issuer" RENAME TO "account";

CREATE INDEX "account_userId_idx" ON "account" ("userId");

