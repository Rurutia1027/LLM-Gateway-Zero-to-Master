import { defineConfig } from 'drizzle-kit'; 
import process from 'process';

export default defineConfig({
    schema: './src/db/schema.ts', 
    out: './drizzle', 
    dialect: 'sqlite', 
    dbCredentials: {
        url: process.env.DATABASE_URL ?? './data/gateway.db', 
    }
}); 