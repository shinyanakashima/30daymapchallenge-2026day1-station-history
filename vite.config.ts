import { defineConfig } from 'vite';

// GitHub Pages のサブパスでも動くよう相対パスで出力する
export default defineConfig({
  base: './',
});
