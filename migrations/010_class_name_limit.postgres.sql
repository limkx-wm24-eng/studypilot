-- NOT VALID preserves legacy rows while enforcing new inserts and updates.
ALTER TABLE classes ADD CONSTRAINT classes_name_length
CHECK (char_length(btrim(name)) BETWEEN 1 AND 60) NOT VALID;
