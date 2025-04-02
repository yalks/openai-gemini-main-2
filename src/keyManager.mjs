import fs from 'node:fs/promises';
import path from 'node:path';

// 配置默认值
const DEFAULT_CONFIG = {
  maxRetries: 3,           // 最大重试次数
  coolingTime: 300000,     // 冷却时间(毫秒) - 默认5分钟
  coolingCheckInterval: 60000, // 冷却恢复检查间隔(毫秒) - 默认1分钟
  logLevel: 'info'         // 日志级别: debug, info, warn, error
};

// 适配不同环境的文件读取
async function readKeyFile() {
  const keyFilePath = './key.json';
  
  try {
    // 尝试使用Node.js的fs模块
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const resolvedPath = path.resolve(keyFilePath);
      return await fs.readFile(resolvedPath, 'utf-8');
    }
    // 尝试使用Deno的API
    else if (typeof Deno !== 'undefined') {
      return await Deno.readTextFile(keyFilePath);
    }
    // 尝试使用Bun的API
    else if (typeof Bun !== 'undefined') {
      return await Bun.file(keyFilePath).text();
    }
    // 网络环境，使用fetch (可能需要调整路径)
    else {
      const response = await fetch(keyFilePath);
      if (!response.ok) {
        throw new Error(`Failed to fetch key file: ${response.status}`);
      }
      return await response.text();
    }
  } catch (error) {
    console.error('Error reading key file:', error);
    throw error;
  }
}

export class KeyManager {
  constructor(config = {}) {
    this.keyPool = [];
    this.keyMap = new Map(); // 通过ID快速查找密钥
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.metrics = new KeyMetrics();
    
    // 启动冷却恢复检查定时器
    this.recoveryTimer = setInterval(() => {
      this.checkKeyRecovery();
    }, this.config.coolingCheckInterval);
    
    this.logger = this.createLogger();
  }
  
  // 创建适合环境的日志记录器
  createLogger() {
    return {
      debug: (...args) => this.config.logLevel === 'debug' && console.debug('[KeyManager]', ...args),
      info: (...args) => ['debug', 'info'].includes(this.config.logLevel) && console.info('[KeyManager]', ...args),
      warn: (...args) => ['debug', 'info', 'warn'].includes(this.config.logLevel) && console.warn('[KeyManager]', ...args),
      error: (...args) => console.error('[KeyManager]', ...args)
    };
  }
  
  // 加载密钥
  async loadKeys() {
    try {
      const keyData = await readKeyFile();
      const keys = JSON.parse(keyData);
      
      this.keyPool = keys.map((k, index) => {
        const keyInfo = new KeyInfo(
          `key-${index}`, // 生成ID代替使用实际密钥，避免密钥泄露
          k.key,
          k.rate,
          k.time
        );
        this.keyMap.set(keyInfo.id, keyInfo);
        return keyInfo;
      });
      
      this.logger.info(`Loaded ${this.keyPool.length} API keys`);
      return true;
    } catch (error) {
      this.logger.error('Failed to load API keys:', error);
      return false;
    }
  }
  
  // 获取可用的密钥(使用组合策略)
  getAvailableKey() {
    this.metrics.recordRequest();
    
    // 过滤出所有可用的密钥
    const availableKeys = this.keyPool.filter(k => k.isAvailable());
    
    if (availableKeys.length === 0) {
      this.logger.warn('No available API keys!');
      throw new Error('所有API密钥都不可用，请稍后再试');
    }
    
    // 按使用次数分组
    const keysByUsage = new Map();
    let minUsage = Infinity;
    
    availableKeys.forEach(key => {
      const usage = key.usageCount;
      if (usage < minUsage) minUsage = usage;
      
      if (!keysByUsage.has(usage)) {
        keysByUsage.set(usage, []);
      }
      keysByUsage.get(usage).push(key);
    });
    
    // 从使用次数最少的组中随机选择
    const leastUsedKeys = keysByUsage.get(minUsage);
    const selectedKey = leastUsedKeys[Math.floor(Math.random() * leastUsedKeys.length)];
    
    selectedKey.use();
    this.logger.debug(`Selected API key: ${selectedKey.id}, usage: ${selectedKey.usageCount}`);
    
    return selectedKey;
  }
  
  // 标记密钥已成功使用
  markKeyUsed(keyInfo, responseTime) {
    if (!keyInfo) return;
    
    keyInfo.recordSuccess(responseTime);
    this.metrics.recordSuccess(responseTime);
    
    this.logger.debug(`Key ${keyInfo.id} used successfully, response time: ${responseTime}ms`);
  }
  
  // 标记密钥进入冷却状态
  markKeyCooling(keyInfo) {
    if (!keyInfo) return;
    
    keyInfo.recordFailure();
    keyInfo.startCooling();
    this.metrics.recordFailure();
    
    this.logger.warn(`Key ${keyInfo.id} marked as cooling`);
  }
  
  // 检查冷却中的密钥，尝试恢复
  checkKeyRecovery() {
    let recoveredCount = 0;
    
    this.keyPool.forEach(key => {
      if (key.cooling && key.checkRecovery(this.config.coolingTime)) { // 传递冷却时间
        recoveredCount++;
        this.logger.info(`Key ${key.id} recovered from cooling`);
      }
    });
    
    if (recoveredCount > 0) {
      this.logger.info(`Recovered ${recoveredCount} keys from cooling`);
    }
  }
  
  // 获取所有密钥的统计信息
  getKeyStats() {
    return this.keyPool.map(key => key.getStats());
  }
  
  // 获取全局统计信息
  getGlobalStats() {
    return this.metrics.getStats();
  }
  
  // 重置指定密钥的状态
  resetKey(keyId) {
    const key = this.keyMap.get(keyId);
    if (key) {
      key.reset();
      this.logger.info(`Manually reset key ${keyId}`);
      return true;
    }
    return false;
  }
  
  // 获取或更新配置
  getConfig() {
    return { ...this.config };
  }
  
  updateConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    
    // 如果冷却检查间隔有变化，重启定时器
    if (newConfig.coolingCheckInterval && newConfig.coolingCheckInterval !== this.config.coolingCheckInterval) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = setInterval(() => {
        this.checkKeyRecovery();
      }, this.config.coolingCheckInterval);
    }
    
    this.logger.info('Config updated:', this.config);
    return this.config;
  }
  
  // 清理资源
  destroy() {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
    }
  }
}

// 表示单个API密钥及其状态
class KeyInfo {
  constructor(id, key, rate, time) {
    this.id = id;
    this.key = key;
    this.rate = rate;          // 时间窗口内的最大请求次数
    this.time = time * 1000;   // 时间窗口(秒转为毫秒)
    
    this.usageCount = 0;       // 当前时间窗口内的使用次数
    this.lastReset = Date.now(); // 上次重置计数器的时间
    this.cooling = false;      // 是否处于冷却状态
    this.coolingStartTime = 0; // 开始冷却的时间
    
    // 统计数据
    this.successCount = 0;
    this.failureCount = 0;
    this.totalResponseTime = 0;
    this.lastUsedTime = 0;
  }
  
  // 检查是否可用
  isAvailable() {
    // 如果在冷却中，不可用
    if (this.cooling) return false;
    
    // 检查是否需要重置计数器(新的时间窗口)
    const now = Date.now();
    if (now - this.lastReset >= this.time) {
      this.usageCount = 0;
      this.lastReset = now;
    }
    
    // 检查是否超过了限流阈值
    return this.usageCount < this.rate;
  }
  
  // 标记为已使用
  use() {
    this.usageCount++;
    this.lastUsedTime = Date.now();
  }
  
  // 记录成功请求
  recordSuccess(responseTime) {
    this.successCount++;
    this.totalResponseTime += responseTime;
  }
  
  // 记录失败请求
  recordFailure() {
    this.failureCount++;
  }
  
  // 重置状态
  reset() {
    this.usageCount = 0;
    this.lastReset = Date.now();
    this.cooling = false;
    this.coolingStartTime = 0;
  }
  
  // 进入冷却状态
  startCooling() {
    this.cooling = true;
    this.coolingStartTime = Date.now();
  }
  
  // 检查是否可以从冷却状态恢复
  checkRecovery(coolingTime) { // 接收冷却时间作为参数
    if (!this.cooling) return false;
    
    const now = Date.now();
    const coolingDuration = now - this.coolingStartTime;
    
    if (coolingDuration >= coolingTime) {
      this.cooling = false;
      this.usageCount = 0; // 重置使用计数
      this.lastReset = now;
      return true;
    }
    
    return false;
  }
  
  // 获取此密钥的统计信息
  getStats() {
    const totalRequests = this.successCount + this.failureCount;
    const successRate = totalRequests > 0 ? (this.successCount / totalRequests * 100).toFixed(2) : '100.00';
    const avgResponseTime = this.successCount > 0 ? (this.totalResponseTime / this.successCount).toFixed(2) : '0.00';
    
    return {
      id: this.id,
      // 不返回实际密钥，防止泄露
      rate: this.rate,
      timeWindow: this.time / 1000, // 转回秒
      currentUsage: this.usageCount,
      status: this.cooling ? 'cooling' : 'available',
      successRate: `${successRate}%`,
      totalRequests,
      successCount: this.successCount,
      failureCount: this.failureCount,
      avgResponseTime: `${avgResponseTime}ms`,
      lastUsed: this.lastUsedTime ? new Date(this.lastUsedTime).toISOString() : 'never',
      coolingTimeElapsed: this.cooling ? (Date.now() - this.coolingStartTime) : 0
    };
  }
}

// 全局指标统计
class KeyMetrics {
  constructor() {
    this.requestCount = 0;
    this.successCount = 0;
    this.failureCount = 0;
    this.retryCount = 0;
    this.totalResponseTime = 0;
    this.startTime = Date.now();
  }
  
  recordRequest() {
    this.requestCount++;
  }
  
  recordSuccess(responseTime) {
    this.successCount++;
    this.totalResponseTime += responseTime;
  }
  
  recordFailure() {
    this.failureCount++;
  }
  
  recordRetry() {
    this.retryCount++;
  }
  
  getStats() {
    const totalTime = Date.now() - this.startTime;
    const totalRequests = this.successCount + this.failureCount;
    const successRate = totalRequests > 0 ? (this.successCount / totalRequests * 100).toFixed(2) : '100.00';
    const avgResponseTime = this.successCount > 0 ? (this.totalResponseTime / this.successCount).toFixed(2) : '0.00';
    
    return {
      uptime: this.formatDuration(totalTime),
      totalRequests: this.requestCount,
      successCount: this.successCount,
      failureCount: this.failureCount,
      retryCount: this.retryCount,
      successRate: `${successRate}%`,
      avgResponseTime: `${avgResponseTime}ms`
    };
  }
  
  formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    return `${days}d ${hours % 24}h ${minutes % 60}m ${seconds % 60}s`;
  }
}

// 创建单例实例
const keyManager = new KeyManager();
// 注意：在模块作用域内直接设置globalThis可能在某些环境中不安全或不推荐
// 更好的方式是在需要的地方传递keyManager实例或其配置
// 但为了简化KeyInfo访问配置，暂时保留
globalThis.keyManager = keyManager; 
export default keyManager;