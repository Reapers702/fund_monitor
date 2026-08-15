import { defineConfig } from 'vitest/config'

// 单测只测纯函数模块（analyzer/parse、position 算法、scheduler/time），
// 不引入 Electron 依赖（config/db 等有 electron 导入链，单独测它们需 mock）
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
