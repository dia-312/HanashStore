import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

// SPEC section 14: layouts are RTL, so only logical Tailwind utilities (ms-, pe-, start-, ...) are allowed.
const PHYSICAL_CLASS =
  /(^|\s)-?(m[lr]|p[lr]|left|right)-\S+|(^|\s)(text-(left|right)|float-(left|right)|border-[lr]|rounded-[lr](-\S+)?|border-[lr]-\S+)(\s|$)/

const rtl = {
  rules: {
    'no-physical-classes': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const check = (node, value) => {
          if (typeof value === 'string' && PHYSICAL_CLASS.test(value)) {
            context.report({
              node,
              message:
                'Physical Tailwind direction class in an RTL app. Use logical utilities: ms-/me-, ps-/pe-, start-/end-, text-start/text-end.',
            })
          }
        }
        return {
          Literal: (node) => check(node, node.value),
          TemplateElement: (node) => check(node, node.value.cooked),
        }
      },
    },
  },
}

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'coverage', 'public'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, rtl },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'rtl/no-physical-classes': 'error',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js'],
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' } },
  },
)
