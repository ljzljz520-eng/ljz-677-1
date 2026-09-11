// 全局配置
export const PORT = process.env.PORT || 3000;
export const BATCH_SIZE = 200;                 // 每批校验/上送行数
export const BATCH_DELAY_MS = 12;              // 每批模拟耗时（让前端可观察进度）
export const PLATFORM_TIMEOUT_RATE = 0.004;    // 平台模拟：网络超时概率（可重试）
export const MAX_UPLOAD_MB = 60;

// 监管平台基础药品库（模拟）：编码前缀 -> 名称/规格/厂家备案信息
// 真实场景由监管平台返回，这里用确定性哈希模拟，无需穷举
export const HINT = 'DEMO';

// 任务文件存放
export const DIR_UPLOAD = new URL('../uploads/', import.meta.url).pathname;
export const DIR_REPORT = new URL('../reports/', import.meta.url).pathname;
