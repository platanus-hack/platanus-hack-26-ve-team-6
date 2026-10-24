import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { nitro } from 'nitro/vite';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // The compiler uses CommonJS filesystem globals; preserve its native Node package.
  ssr: { external: ['typescript'] },
  plugins: [tailwindcss(), tanstackStart(), nitro({ preset: 'node-server', traceDeps: ['typescript'] }), react()],
});
