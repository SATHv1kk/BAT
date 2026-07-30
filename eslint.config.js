// Flat ESLint config. The codebase had `eslint-disable` comments but no ESLint —
// so nothing was ever checked. Rules are chosen to catch the classes of bug this
// project actually hits (undeclared globals across three different runtimes,
// unused code left behind by refactors, accidental fallthrough), not to enforce
// a style.
import globals from 'globals';

const shared = {
  // 'latest' rather than a pinned year: vite.config.js uses import attributes
  // (`with { type: 'json' }`), which a pinned 2023 parser rejects outright.
  ecmaVersion: 'latest',
  sourceType: 'module'
};

const rules = {
  // Correctness
  'no-undef': 'error',
  'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-fallthrough': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-unsafe-negation': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-compare': 'error',
  // Off: the agent loop's `while (!stopRequested)` is flipped by a click handler
  // in another turn of the event loop, which this rule cannot see. It reports a
  // false positive on the single most important loop condition in the project.
  'no-unmodified-loop-condition': 'off',
  'require-atomic-updates': 'off', // too noisy against the deliberate run-state mutation in the runner
  'no-return-await': 'error',
  'no-await-in-loop': 'off',       // the agent loop is sequential on purpose
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implicit-coercion': 'off',

  // Async footguns that matter in an extension
  'no-async-promise-executor': 'error',
  'require-await': 'off',
  'no-promise-executor-return': 'error',

  // Hygiene
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  'no-throw-literal': 'error',
  'no-useless-escape': 'error',
  // An empty catch is allowed but must be a deliberate choice — see the
  // "Errors get breadcrumbs" invariant in CONTRIBUTING.md.
  'no-empty': ['error', { allowEmptyCatch: true }]
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'GITHUB/**', '.github/**'] },

  // Extension pages + service worker: ESM with chrome APIs.
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ...shared,
      globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' }
    },
    rules
  },

  // Content scripts are classic scripts injected into pages, not modules, and
  // are deliberately ES5-compatible (they run before any bundling guarantees).
  {
    files: ['src/content/**/*.js'],
    languageOptions: {
      ...shared,
      sourceType: 'script',
      globals: { ...globals.browser, ...globals.webextensions, chrome: 'readonly' }
    },
    rules: { ...rules, 'no-var': 'off', 'prefer-const': 'off' }
  },

  // browser-tools/page-tools are IIFEs that publish onto window and inject
  // functions whose bodies run in the PAGE, so page-side globals appear here.
  {
    files: ['src/lib/browser-tools.js', 'src/lib/page-tools.js', 'src/lib/extractor-exec.js'],
    rules: { ...rules, 'no-eval': 'off' }
  },

  // Tests run in Node.
  {
    files: ['test/**/*.mjs'],
    languageOptions: { ...shared, globals: { ...globals.node } },
    rules
  },

  // Build config runs in Node.
  {
    files: ['*.config.js', 'vite.config.js'],
    languageOptions: { ...shared, globals: { ...globals.node } },
    rules
  }
];
