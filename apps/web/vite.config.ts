import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';

export default defineConfig({
  // The compiler uses CommonJS filesystem globals; preserve its native Node package.
  ssr: { external: ['typescript'] },
  plugins: [tanstackStart(), nitro({ preset: 'node-server', traceDeps: ['typescript'] }), react()],
});
