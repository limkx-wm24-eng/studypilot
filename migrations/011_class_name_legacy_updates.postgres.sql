-- One statement/implicit transaction: failure restores the old CHECK and any
-- preceding DDL. The table lock prevents concurrent writes during replacement.
DO $migration$
BEGIN
  LOCK TABLE classes IN ACCESS EXCLUSIVE MODE;
  CREATE OR REPLACE FUNCTION enforce_class_name_length()
  RETURNS trigger LANGUAGE plpgsql AS $function$
  BEGIN
    IF char_length(btrim(NEW.name)) NOT BETWEEN 1 AND 60 THEN
      RAISE EXCEPTION 'Class names must have 1 to 60 characters'
        USING ERRCODE = '23514', CONSTRAINT = 'classes_name_length';
    END IF;
    RETURN NEW;
  END;
  $function$;
  DROP TRIGGER IF EXISTS classes_name_insert_limit ON classes;
  DROP TRIGGER IF EXISTS classes_name_update_limit ON classes;
  CREATE TRIGGER classes_name_insert_limit BEFORE INSERT ON classes
    FOR EACH ROW EXECUTE FUNCTION enforce_class_name_length();
  CREATE TRIGGER classes_name_update_limit BEFORE UPDATE OF name ON classes
    FOR EACH ROW EXECUTE FUNCTION enforce_class_name_length();
  ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_name_length;
END;
$migration$;
