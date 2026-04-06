# API Hub — SillyTavern 统一 API 连接管理

API Hub 把 SillyTavern 原本分散在多个 Source、Reverse Proxy、Connection Profile、API Key 表单里的配置流程，整理成一套面向协议的统一前端。

核心目标很简单：

- 用 `OpenAI Compatible / Anthropic / Google Gemini` 三种协议视角管理连接
- 让端点、模型、参数、预设、密钥切换都能跟着连接一起保存和切换
- 尽量复用 SillyTavern 原生能力，而不是重造一套后端

当前版本：`v1.1.0`

## 支持的格式

| 格式 | 适用场景 | 对应原生 Source |
|------|----------|-----------------|
| OpenAI Compatible | 绝大部分第三方中转、反代、兼容接口 | Custom |
| Anthropic | Claude 官方 / Anthropic 协议反代 | Claude |
| Google Gemini | Google AI Studio / Gemini 协议反代 | Google AI Studio |

## 安装

在酒馆扩展管理器中通过 URL 安装：

```text
https://github.com/waylon256yhw/SillyTavern-ApiHub
```

或者手动克隆到扩展目录：

```bash
cd SillyTavern/public/scripts/extensions/third-party
git clone https://github.com/waylon256yhw/SillyTavern-ApiHub
```

刷新页面即可。

## 当前功能

### 1. 统一连接管理

- 多连接配置，切换即生效
- 每个连接独立保存端点、模型、请求参数、请求头、密钥信息
- 支持新建、重命名、复制、删除
- 保存时会快照当前预设状态

### 2. 三种协议格式统一处理

- `OpenAI Compatible` 自动按 `/v1` 规则归一化 URL
- `Anthropic` 使用 Claude 原生设置链路
- `Gemini` 对官方 `v1beta` 场景走专门逻辑，不强行套 OpenAI 兼容实现
- 端点末尾加 `#` 可进入直连模式，跳过 URL 自动归一化

### 3. 模型管理

- 支持从接口拉取模型列表
- 支持手动添加和删除模型
- 非官方端点统一按 `/v1/models` 拉取
- 官方 Gemini 走 SillyTavern 原生 connect 流程

### 4. 自定义请求参数

- 排除默认 body 参数
- 添加自定义 body 参数
- 添加自定义请求头

适合处理不同中转或反代的兼容性差异。

### 5. 预设联动

切换连接时会联动切换：

- Chat Completion Preset
- Regex Preset
- Prompt Post-Processing

行为上尽量贴近原生 Connection Profile，但配置入口更集中。

### 6. 原生密钥库集成

这是 `v1.1.0` 的重点能力。

- 连接现在可以直接绑定 SillyTavern 原生密钥库中的某个 `secretId`
- 切换连接时，会同步切换对应密钥槽的 active key
- 如果当前槽里已经存在相同明文密钥，会优先复用，不重复写入
- 对 Anthropic / Gemini 这类运行时必须读出密钥明文的格式，插件会在需要时读取原生密钥值
- 对 OpenAI Compatible，允许只绑定 `secretId` 跟随原生 active key 切换

### 7. 原生密钥库批量工具

插件会前端 patch 原生密钥管理弹窗，新增：

- 批量选中
- 全选 / 清空
- 批量导入
- 批量导出
- 批量删除

同时保留原生单项操作：

- 设为 active
- 复制 ID
- 复制明文
- 重命名
- 删除

### 8. 导入 / 导出 / 调试

- 连接配置支持完整导出和导入
- 调试导出会脱敏，方便反馈问题
- 原生密钥库批量导出使用独立 JSON 格式
- 原生密钥库批量导入会按“密钥明文值”去重，避免重复导入持续生成新条目

### 9. 原生配置迁移

支持从 SillyTavern 当前原生配置迁移：

- Connection Manager Profiles
- 未被 Profile 引用的 Proxy Presets
- 原生 secret 绑定关系

迁移已做去重处理，重复执行不会无限复制连接。

## 与原生功能的关系

API Hub 主要接管这些原生配置入口：

- Chat Completion Source 选择器
- Reverse Proxy 配置面板
- Connection Profile 选择器
- 各 Source 的 API Key 输入区
- Additional Parameters 配置流

以下原生能力仍然保留并继续使用：

- Prompt Post-Processing
- Test Message
- SillyTavern 原生密钥库
- SillyTavern 原生后端请求链路

## 重要前提

### `allowKeysExposure`

如果你要完整使用“原生密钥库绑定”和“密钥库批量导出/按值去重导入”，需要在当前运行实例的 `config.yaml` 中开启：

```yaml
allowKeysExposure: true
```

然后完整重启该实例。

注意是实际运行时使用的 `config.yaml`，不是 `default/config.yaml`。

### 为什么需要它

SillyTavern 默认不允许前端读取原生密钥明文。不开启时：

- 可以使用原生密钥槽本身
- 但前端无法读取某个 secret 的真实值
- 因此插件无法可靠完成部分绑定、导出、按值去重判断

## 已知边界

- 原生密钥库“按值去重”和“批量导出”依赖 `allowKeysExposure=true`
- 插件是纯前端扩展，不修改 SillyTavern core 文件
- 当前目标是覆盖最常见的 OpenAI Compatible / Anthropic / Gemini 工作流，不追求把所有原生 provider 一次性抽象完

## 安全说明

- API Hub 连接导出文件可能包含明文密钥
- 原生密钥库批量导出文件同样包含明文密钥
- 请把这些导出文件视为敏感信息妥善保管

## 适合分享给用户的定位

如果你在 SillyTavern 里主要使用：

- OpenAI 兼容中转
- Claude 反代
- Gemini / Google AI Studio

并且你希望：

- 用统一界面管理多个连接
- 让连接切换时自动带上模型、预设、密钥状态
- 顺手管理 SillyTavern 原生密钥库

那么 API Hub 现在已经可以作为正式可用版本使用和分享。
