// Preloaded before every test module so no database can use inherited production settings.
process.env.DATABASE_URL = '';
process.env.DB_PATH = ':memory:';
process.env.STUDYPILOT_TEST_POSTGRES = '';
process.env.INGRESS_MODE = 'direct';
process.env.TRUSTED_PROXY_CIDRS = '';
