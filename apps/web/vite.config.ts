import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    // The container filesystem does not deliver inotify events for host bind
    // mounts on macOS and Windows, so the watcher has to poll.
    watch: { usePolling: true, interval: 300 },
  },
});
