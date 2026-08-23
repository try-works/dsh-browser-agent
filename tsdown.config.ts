/**
 * tsdown config for dsh-browser-agent — two build faces in one artifact dir:
 *
 * 1. The server half (lib/index.js): an ESM Node build mirroring
 *    dsh-cloudflare / dsh-recursive-mode. `@deepseek-ai/*` peers are
 *    host-provided at load time and stay external; `puppeteer-core` is a real
 *    runtime dependency resolved from this package's own node_modules, so it
 *    stays external too. The tsc step (tsconfig.build.json,
 *    emitDeclarationOnly) emits the .d.ts files.
 *
 * 2. The client half (lib/client.js): the browser pane bundle, served by the
 *    DSH client-modules host at /plugins/<id>/client.js and adopted by the
 *    client kernel. It follows the harness client-bundle contract: CJS output
 *    wrapped as a `window.__ModuleLoader__.load({ id, factory })` closure,
 *    with `react` external (a shell-seeded platform module; the loader module
 *    table answers it) and everything else inlined.
 */
import { isBuiltin } from 'node:module'
import { defineConfig } from 'tsdown'

const CLIENT_ID = '@try-works/dsh-browser-agent'

const isHostExternal = (specifier: string): boolean =>
  /^@deepseek-ai\//.test(specifier) || specifier === 'puppeteer-core'

const isClientExternal = (specifier: string): boolean =>
  specifier === 'react' || specifier.startsWith('react/')

const host = defineConfig({
  name: CLIENT_ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['es'],
  platform: 'node',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  clean: false,
  deps: {
    neverBundle: isHostExternal,
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isHostExternal(specifier),
  },
  outputOptions: {
    entryFileNames: '[name].js',
  },
})

const client = defineConfig({
  name: `${CLIENT_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isClientExternal,
    alwaysBundle: (specifier: string) => !isClientExternal(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    // Closure-factory artifact, mirroring the harness clientBundle preset:
    // executing the bundle only REGISTERS the factory; every module-body side
    // effect runs at materialization, with externals resolved through the
    // injected require (the loader module table).
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [host, client]
