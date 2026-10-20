/* ============================================================
   server/routes/config.ts —— GET /api/config
   ============================================================ */
import { Hono } from 'hono';
import { configResp } from '../env.js';

export const configRoute = new Hono();

configRoute.get('/', (c) => c.json(configResp()));
