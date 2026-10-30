-- A CLI key: the DEK wrapped to an X25519 key made on a machine, and the hash of the bearer token
-- that machine fetches the wrap with. It goes with its user, and a vault reset deletes it too.
CREATE TABLE vault_cli_key (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX vault_cli_key_user_id
  ON vault_cli_key (user_id);
