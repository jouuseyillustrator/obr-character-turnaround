import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    base: '/obr-character-turnaround/',
    allowedHosts: true,
    cors: true,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  },
});