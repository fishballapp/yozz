/**
 * Everything stored for one user, in one batch (D1 runs a batch as a transaction), so nothing of
 * them is left in the database. Every table is named rather than left to `ON DELETE CASCADE`, which
 * is what actually backs them up (migrations 0002, 0006 and 0007 give `session`, `account`,
 * `passkey` and the three vault tables a foreign key to `user`): the statements say what an
 * account is. The user row goes last. `delete-account.test.ts` walks the whole schema and fails for
 * a table this list does not reach.
 *
 * The same foreign keys refuse a write that passed its session check and lands after the batch.
 *
 * `verification` has no user column, and only its ownership fields say whose a row is: the
 * identifier (a token, or the address itself for email verification and password reset), `$.email`
 * (a pending magic link or sign-up) and `$.userData.id` (a passkey challenge). Nothing else is read,
 * so a row that merely mentions the address, such as another person's `name`, is never touched.
 */
export const deleteAccount = async (
  db: D1Database,
  { userId, email }: { userId: string; email: string },
): Promise<void> => {
  await db.batch([
    db.prepare('DELETE FROM vault_record WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_passkey_wrap WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM vault_account WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM passkey WHERE userId = ?').bind(userId),
    db.prepare('DELETE FROM account WHERE userId = ?').bind(userId),
    db.prepare('DELETE FROM session WHERE userId = ?').bind(userId),
    db
      .prepare(
        `DELETE FROM verification
           WHERE identifier = ? OR lower(identifier) = lower(?)
              OR (json_valid(value)
                  AND (json_extract(value, '$.userData.id') = ?
                    OR lower(json_extract(value, '$.email')) = lower(?)))`,
      )
      .bind(userId, email, userId, email),
    db.prepare('DELETE FROM user WHERE id = ?').bind(userId),
  ]);
};
