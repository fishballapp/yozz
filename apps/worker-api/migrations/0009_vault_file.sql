-- A file in the R2 bucket, under <user_id>/<file_id>: what counts it against the user's cap, and all
-- the Worker knows of it. `size` is the ciphertext's. It goes with its user.
CREATE TABLE vault_file (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, file_id)
);
