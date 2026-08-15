import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    // Process CSS (ui-primitives pulls katex styles) instead of leaving
    // node to choke on .css imports from externalized dependencies.
    css: true,
    server: {
      deps: {
        // Inline ui-primitives so vite transforms its CSS imports.
        inline: ['@deepseek-ai/dsh-client-ui-primitives'],
      },
    },
  },
})
