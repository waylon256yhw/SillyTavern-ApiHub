# API Hub — SillyTavern 统一 API 连接管理

酒馆原生有 24 个 Chat Completion Source，但实际上只有 3 种 API 协议格式。配置一个新的 API 连接，你需要：先从 24 个选项里猜对渠道商，再搞清楚 URL 怎么拼，密钥填哪个框，模型列表在哪选。

API Hub 把这一切简化成：**选格式 → 填地址 → 填密钥 → 选模型 → 用。**

## 支持的格式

| 格式 | 适用场景 | 对应原生 Source |
|------|----------|-----------------|
| OpenAI Compatible | 绝大部分第三方反代、中转站 | Custom |
| Anthropic | Claude 官方 / 原生协议反代 | Claude |
| Google Gemini | Google AI Studio / Vertex 反代 | Google AI Studio |

## 安装

在酒馆的扩展管理器中，通过 URL 安装：

```
https://github.com/waylon256yhw/SillyTavern-ApiHub
```

或者手动克隆到扩展目录：

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/waylon256yhw/SillyTavern-ApiHub
```

刷新页面即可。

## 功能一览

### 连接管理

- 多个连接配置，随时切换（切换即生效）
- 每个连接独立保存：端点 URL、API 密钥、模型、自定义参数
- 保存按钮快照当前完整状态（包括提示词预设、正则预设的关联）
- 复制 / 重命名 / 删除

### 模型管理

- **Fetch 拉取**：自动请求端点的 `/models` 接口获取可用模型列表
- **手动添加 / 删除**：Fetch 不到的模型可以手动填写
- 非官方端点统一走 OpenAI 兼容的 `/v1/models` 拉取，官方端点走原生协议

### URL 预览

输入端点后实时显示最终请求 URL，方便确认拼接是否正确。末尾加 `#` 可进入直连模式（跳过自动归一化）。

### 自定义请求参数

- **排除参数**：勾选即可从请求体中移除（temperature、top_p 等）
- **自定义参数**：键值对形式添加额外的请求体参数
- **自定义请求头**：键值对形式添加额外的 HTTP 头

### 预设联动

切换连接时自动联动切换：
- 提示词预设（Chat Completion Preset）
- 正则预设（Regex Preset）
- 提示词后处理模式（Prompt Post-Processing）

和原版 Connection Profile 的行为一致，保存时自动快照当前状态。

### 迁移

一键从酒馆原生配置迁移：
- 读取 Connection Manager 的 Profile 数据（主要数据源）
- 读取 Proxy Presets 中未被 Profile 引用的条目
- 自动识别 API 格式（Custom → OpenAI, Claude → Anthropic, Google → Gemini）
- 密钥从 Proxy Password 迁移，重复配置自动去重

### 导出 / 导入 / 调试

- **导出**：完整备份（含密钥明文），可在其他设备导入还原
- **导入**：从备份文件还原连接配置，自动拒绝调试文件
- **调试**：导出脱敏的诊断信息（含原生配置和 Connection Manager 数据），用于排查问题

### 原生 UI 切换

右上角切换按钮可随时在 API Hub 界面和酒馆原生界面之间切换，方便对比和调试。

## 和原生功能的关系

API Hub 接管了以下原生 UI：

| 被替换 | 说明 |
|--------|------|
| Chat Completion Source 选择器 | 由格式选择替代 |
| Reverse Proxy 面板 | 由端点 URL 输入替代 |
| Connection Profile 选择器 | 由连接列表替代 |
| 各 Source 的 API Key 表单 | 由统一的密钥输入替代 |
| Additional Parameters 按钮 | 由自定义请求参数面板替代 |

**未替换**的原生功能（保持可见）：
- Prompt Post-Processing 选择器
- Test Message 按钮
- 密钥管理器（通过钥匙图标访问）

## 注意事项

- 密钥以明文存储在 SillyTavern 的 `settings.json` 中（和原生行为一致）
- 导出的备份文件包含明文密钥，请妥善保管
- 重置功能会清除所有 API Hub 数据，不影响酒馆原生配置
- 目前不支持的渠道商格式（OpenRouter、Vertex AI 等）在迁移时会被跳过
