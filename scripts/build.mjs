/**
 * 跨平台前端构建入口。
 *
 * 不直接执行 node_modules/esbuild/bin/esbuild，因为该路径在 Linux 容器中
 * 可能是 ELF 原生可执行文件，不能作为 JavaScript 交给 node 解释。
 */

import { build } from 'esbuild';

await build({
  entryPoints: ['app.js'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  outfile: 'app.bundle.js',
  logLevel: 'info'
});
