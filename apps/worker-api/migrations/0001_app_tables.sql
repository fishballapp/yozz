CREATE TABLE vault_account (
  user_id TEXT PRIMARY KEY,
  unlock_mode TEXT NOT NULL CHECK (unlock_mode IN ('password', 'passkey')),
  password_wrapped_dek TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (unlock_mode = 'password' AND password_wrapped_dek IS NOT NULL) OR
    (unlock_mode = 'passkey' AND password_wrapped_dek IS NULL)
  )
);

CREATE TABLE vault_passkey_wrap (
  user_id TEXT NOT NULL,
  passkey_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, passkey_id)
);

CREATE TABLE vault_record (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE INDEX vault_record_user_type_id
  ON vault_record (user_id, type, id);
