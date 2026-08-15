/**
 * Build both halves of the ui-settings-skills plugin:
 * - lib/index.js  — node half (ESM, for the host loader)
 * - lib/client.js — browser half (CJS closure factory handed to
 *                   window.__ModuleLoader__.load, externals resolved from the
 *                   platform module table; mirrors the harness clientBundle
 *                   contract: CSS modules compiled by lightningcss, the class
 *                   map exported and the css text injected as one
 *                   <style data-plugin> tag at factory execution).
 */

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { build } from 'esbuild'
import { transform } from 'lightningcss'

const PKG_ID = 'ui-settings-skills'

/** The browser module table the shell seeds (harness PLATFORM_MODULES). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Inline CSS Modules as JS modules: hashed class map + injected style tag. */
const cssModulesPlugin = {
  name: 'dsh-css-modules-inline',
  setup(build) {
    build.onResolve({ filter: /\.module\.css$/ }, (args) => ({
      path: CSS_VIRTUAL_PREFIX + args.path + CSS_VIRTUAL_SUFFIX,
      namespace: 'dsh-css',
      pluginData: { resolveDir: args.resolveDir },
    }))
    build.onLoad({ filter: /.*/, namespace: 'dsh-css' }, async (args) => {
      const file = args.path.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      const abs = resolve(args.pluginData.resolveDir, file)
      const source = await readFile(abs)
      const { code, exports: cssExports } = transform({
        filename: abs,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap = {}
      for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
      const tagId = `${PKG_ID}/${basename(abs)}`
      const contents = [
        `const css = ${JSON.stringify(code.toString())};`,
        `const tagId = ${JSON.stringify(tagId)};`,
        `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {`,
        '  const tag = document.createElement(\'style\');',
        `  tag.dataset.plugin = ${JSON.stringify(PKG_ID)};`,
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
      return { contents, loader: 'js' }
    })
  },
}

const nodeEnv = process.env.NODE_ENV ?? 'production'

// Node half: lib/index.js (ESM). Value imports are type-only today, so the
// bundle carries no bare specifiers the profile must resolve.
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  define: { 'process.env.NODE_ENV': JSON.stringify(nodeEnv) },
})

// Browser half: lib/client.js (CJS closure factory). Externals stay in the
// module table; everything else inlines (the purity rule is that cross-plugin
// collaboration happens through cordis services, so only platform modules and
// type-only imports may name @deepseek-ai packages).
await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: PLATFORM_MODULES,
  define: {
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
    'import.meta.env.MODE': JSON.stringify(nodeEnv),
    'import.meta.env': JSON.stringify({ MODE: nodeEnv }),
  },
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  plugins: [cssModulesPlugin],
})

console.log('built lib/index.js and lib/client.js')
