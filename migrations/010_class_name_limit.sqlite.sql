-- Preserve existing rows; enforce the limit on new and renamed classes.
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
