-- The revision a record was written at, in the clear, so a write can state the version it
-- expects and the store can refuse a stale one atomically. The authoritative revision remains
-- the one sealed inside the ciphertext; this column is a precondition, never a source of truth,
-- and the client refuses any row where the two disagree.
--
-- Existing rows are NULL: they were written before the column existed. A NULL skips the
-- client's agreement check, and the first CAS write to such a row states `ifRevision: null`.
ALTER TABLE vault_record ADD COLUMN revision INTEGER;
