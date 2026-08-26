CREATE TRIGGER prevent_user_email_update
BEFORE UPDATE OF email ON user
FOR EACH ROW
WHEN NEW.email <> OLD.email
BEGIN
  SELECT RAISE(ABORT, 'user email is immutable');
END;
