-- Forward repair for old, incorrectly recorded or partially installed 010 guards.
-- The migration runner executes this DDL and its ledger insertion atomically.
-- Existing data, including legacy names, is never rewritten.
DROP TRIGGER IF EXISTS classes_name_insert_limit;
DROP TRIGGER IF EXISTS classes_name_update_limit;
CREATE TRIGGER classes_name_insert_limit BEFORE INSERT ON classes
WHEN length(trim(NEW.name)) NOT BETWEEN 1 AND 60
BEGIN
  SELECT RAISE(ABORT, 'Class names must have 1 to 60 characters');
END;
CREATE TRIGGER classes_name_update_limit BEFORE UPDATE OF name ON classes
WHEN length(trim(NEW.name)) NOT BETWEEN 1 AND 60
BEGIN
  SELECT RAISE(ABORT, 'Class names must have 1 to 60 characters');
END;
