// Variables de entorno mínimas para arrancar AppModule en las pruebas (sin base de datos real).
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.DIRECT_URL = 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = 'test-secret-with-at-least-16-chars';
process.env.JWT_EXPIRATION = '3600';
process.env.SCRAPING_DELAY_MS = '0';
process.env.WEBHOOK_SECRET = 'webhook-secret-0123456789';
process.env.DEFAULT_OWNER_USER_ID = '1';
process.env.SYNC_TZ_OFFSET = '-05:00';
