import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Dev proxy to avoid CORS when running `npm run dev` locally.
// Frontend will call `/v1/...` and Vite will proxy to your backend.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/v1': {
        target: 'http://xiaolongya.cn:8091',
        changeOrigin: true,
      },
    },
  },
  preview: {
    proxy: {
      '/v1': {
        target: 'http://xiaolongya.cn:8091',
        changeOrigin: true,
      },
    },
  },
})
