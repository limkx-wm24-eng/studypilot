// Preloaded before every test module so no database can use inherited production settings.
process.env.DATABASE_URL = '';
process.env.DB_PATH = ':memory:';
