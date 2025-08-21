// 轻量全局声明，避免在未安装 @types/node 时的类型报错
// 注意：生产项目建议安装 @types/node 并在 tsconfig 中启用 "types": ["node"]
declare const process: {
  env: Record<string, string | undefined>;
};