/**
 * 路由层共用的校验失败响应。
 *
 * 只有一件事：把 zod 的 `issues` 整理成人能看懂的形状。
 *
 * 单独成文件是因为它被 `/api`（admin.ts）与 `/api/ix`（ix.ts）**两个插件**共用，
 * 而两边的 400 响应体必须逐字一致 —— 前端只写一套解析（`{error, details[]}`），
 * 两处各写一份迟早长歪，表现是某个表单的报错在界面上显示不出来。
 */

import type { z } from 'zod';

export interface BadRequestBody {
  error: string;
  details: string[];
}

/** 统一的校验失败响应。`(根)` 是给顶层 issue 用的占位，免得 path 为空时出现空冒号。 */
export function badRequest(issues: z.ZodIssue[]): BadRequestBody {
  return {
    error: '请求参数校验失败',
    details: issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`),
  };
}
