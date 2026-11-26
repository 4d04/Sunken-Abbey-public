import { defineConfig } from 'vite';

// the browser client: `npm run web` serves it on http://localhost:5173 (passkeys accept localhost as a secure origin)
export default defineConfig({
    server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
    build: { outDir: 'dist-web', target: 'es2022' },
    // which chain the build talks to: ABBEY_CHAIN_ID=<id> npm run build:web (default 2, the playtest chain)
    define: {
        __ABBEY_CHAIN_ID__: JSON.stringify(process.env.ABBEY_CHAIN_ID || '2'),
        __ABBEY_NETWORK_ID__: JSON.stringify(process.env.ABBEY_NETWORK_ID || '1')
    }
});
