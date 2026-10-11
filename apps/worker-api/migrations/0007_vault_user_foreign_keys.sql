-- The vault tables had no foreign key to "user", so a write that passed its session check could
-- land after the account was deleted and leave ciphertext under a dead user id for good (drafts
-- autosave every 2 s from any open tab). Each table is rebuilt with user_id REFERENCES "user" ON
-- DELETE CASCADE: a late insert now fails, and deleting a user deletes the vault with it. Nothing
-- references these three tables, so a plain create/copy/drop/rename is safe.
--
-- Rows whose user no longer exists are not copied: they are the orphans this migration exists to
-- prevent, and nothing can read them.
CREATE TABLE vault_account_with_user (
  user_id TEXT PRIMARY KEY REFERENCES "user" ("id") ON DELETE CASCADE,
  unlock_mode TEXT NOT NULL CHECK (unlock_mode IN ('password', 'passkey')),
  password_wrapped_dek TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (unlock_mode = 'password' AND password_wrapped_dek IS NOT NULL) OR
    (unlock_mode = 'passkey' AND password_wrapped_dek IS NULL)
  )
);

INSERT INTO vault_account_with_user (user_id, unlock_mode, password_wrapped_dek, created_at, updated_at)
SELECT user_id, unlock_mode, password_wrapped_dek, created_at, updated_at
FROM vault_account
WHERE user_id IN (SELECT "id" FROM "user");

DROP TABLE vault_account;
ALTER TABLE vault_account_with_user RENAME TO vault_account;

CREATE TABLE vault_passkey_wrap_with_user (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  passkey_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, passkey_id)
);

INSERT INTO vault_passkey_wrap_with_user (user_id, passkey_id, wrapped_dek, created_at, updated_at)
SELECT user_id, passkey_id, wrapped_dek, created_at, updated_at
FROM vault_passkey_wrap
WHERE user_id IN (SELECT "id" FROM "user");

DROP TABLE vault_passkey_wrap;
ALTER TABLE vault_passkey_wrap_with_user RENAME TO vault_passkey_wrap;

CREATE TABLE vault_record_with_user (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  revision INTEGER,
  PRIMARY KEY (user_id, id)
);

INSERT INTO vault_record_with_user (user_id, id, type, ciphertext, updated_at, revision)
SELECT user_id, id, type, ciphertext, updated_at, revision
FROM vault_record
WHERE user_id IN (SELECT "id" FROM "user");

DROP TABLE vault_record;
ALTER TABLE vault_record_with_user RENAME TO vault_record;

CREATE INDEX vault_record_user_type_id
  ON vault_record (user_id, type, id);
