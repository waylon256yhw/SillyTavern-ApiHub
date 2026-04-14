# bug

现象不是单纯的“429 后模型名没切过去”，而是：

1. ApiHub 当前连接在 UI 上仍然是活动连接。
2. 但 ST 实际生成请求开始读取的，已经不是这条活动连接对应的原生 chat-completion 状态。
3. 此时如果用户只在 ApiHub 里改模型，往往无法恢复，因为 ApiHub 的“改模型”逻辑只同步了模型字段，没有重新激活整条连接。

这会表现为：

- 报错前用的是 ApiHub 选中的模型。
- 报错后再次 roll，实际请求落回另一套原生 source/model。
- 继续在 ApiHub 改模型也不生效。
- 只有切回 ST 原生 UI 重新切 source/model，或者重新触发一次 ApiHub 的完整连接激活，才能恢复。

# proposal

当前最可信的根因假设是：

`ApiHub 把“活动连接”和“ST 当前原生生效状态”当成同一件事，但代码里并没有持续保证它们一致。`

更具体地说：

- `activateConnection()` 才会把一整条连接完整写回 ST 原生状态。
- 但 ApiHub 的模型切换并不会调用 `activateConnection()`，只会改一个 model 字段。
- 所以只要 ST 原生状态在别处发生漂移，ApiHub 仍然显示“当前连接是 A”，但实际发送请求时 ST 读到的却可能已经是 B。

这能解释用户描述里的核心症状：

- “报错之后下一次 roll 用的是 native 里的 Gemini”
- “这时候在 ApiHub 里选什么模型都无法切换”

因为如果 ST 当前 source 已经漂到 `makersuite`，那么 ApiHub 再改一次 Claude 模型名，只会改 `claude_model`，不会把 source 从 `makersuite` 拉回 `claude`。

我目前还不能 100% 证明“报错后到底是哪一条外部链路把原生状态改漂了”，但可以确认：

- 真正让问题持续存在的决定性缺陷，是 ApiHub 没有在关键时机重新校正活动连接。
- `auto-connect to last server` 不是最主要嫌疑，至少从 ST 主仓代码看，它不会主动切换 `chat_completion_source`。

## explored proposals

下面是我已经探索过的其他 proposal，以及当前判断。

### proposal A: `auto-connect to last server` / 自动重连把 provider 切回去了

探索结果：`弱化，暂不认为是主因`

原因：

- ST 主仓里的 `RA_autoconnect()` 只会在 `online_status === 'no_connection' && power_user.auto_connect` 时尝试重连。
- 它是按“当前 `oai_settings.chat_completion_source`”判断该点哪个 connect 按钮。
- 它没有主动把 `chat_completion_source` 从 `claude` 改成 `makersuite` 的逻辑。

当前判断：

- 它更像是“放大器”，不是“切回 Gemini”的第一触发器。
- 也就是说，如果 source 先被别的链路改漂了，自动重连可能会顺着错误 source 去连；但它不像根因。

### proposal B: Connection Manager 的 selected profile / last server 在报错后自动重载

探索结果：`暂未发现直接证据`

原因：

- Connection Manager 的 `applyConnectionProfile(profile)` 确实会完整重放 profile 里的 `api / model / api-url / preset / secret-id` 等命令。
- 但目前在它的代码里没看到“生成报错后自动重新应用 selectedProfile”的监听。
- 也没看到它监听 `GENERATION_ENDED`、请求报错或 `ONLINE_STATUS_CHANGED` 后自动 reload profile。

当前判断：

- Connection Manager 具备“如果被调用就能覆盖当前连接状态”的能力。
- 但现阶段没有证据表明“报错后就是它自动调用了这条链”。

### proposal C: `bind_preset_to_connection` 触发 preset 回写，覆盖了 ApiHub 的连接字段

探索结果：`保留为中等嫌疑`

原因：

- ST 的 `onSettingsPresetChange()` 在 `bind_preset_to_connection === true` 时，确实会把 preset 中的 connection 字段重新写回 `oai_settings`。
- 其中包含可能影响 source / model / url 的字段。
- ApiHub 的 `activateConnection()` 里专门写了补偿顺序：
  - 先 `/preset`
  - 再回写 endpoint/source/model

这说明作者自己已经知道“preset 会覆盖连接字段”这个风险。

但当前缺口是：

- 我还没找到“429 或 API 错误后，为什么会再次触发 preset 应用”的直接证据。

当前判断：

- 这是一个合理嫌疑链。
- 它可以解释“为什么 native 状态会漂移”。
- 但暂时还只是候选，不是已证实根因。

### proposal D: `CHAT_COMPLETION_SETTINGS_READY` 这类请求前事件改坏了 generate_data，导致后续状态异常

探索结果：`基本排除为主因`

原因：

- ApiHub 在这个事件上只做 `applyActiveConnectionExclusions(generateData)`。
- 这段逻辑只会按 `excludeBody` 删除请求体字段。
- 它不会改 `chat_completion_source`、不会改 `model`、不会改 `custom_url/reverse_proxy`。

当前判断：

- 这条链不解释“报错后 source 落回 Gemini”。
- 即使这里有 bug，也更可能是请求体参数兼容性问题，不是当前模型切换失效的核心。

### proposal E: `saveModelList()` / 状态检查返回的模型列表把当前模型覆盖了

探索结果：`部分成立，但不足以解释完整现象`

原因：

- ST 的 `saveModelList()` 在不同 source 下，确实会根据返回模型列表修正当前选中的 model。
- 例如模型不存在时，会回退到列表里的第一个模型。

但限制是：

- 这只能在“当前 source 已经确定”的前提下，修正该 source 下的模型。
- 它不能把 `claude` 直接切成 `makersuite`。

当前判断：

- 它可能解释“同一 provider 内模型被回退”。
- 不能解释“provider 级别切回 Gemini”。

### proposal F: ST 的请求报错处理本身直接重置了 `oai_settings.chat_completion_source`

探索结果：`目前未发现`

原因：

- 我追过 `sendOpenAIRequest()`、`createGenerationParameters()`、流式/非流式报错分支，以及 `script.js` 中生成错误处理路径。
- 当前没找到一段明确代码在 429/非 2xx 时直接把 `chat_completion_source` 改成别的 provider。

当前判断：

- “报错”是稳定触发条件。
- 但“报错处理代码直接切 provider”目前没有证据支持。

### proposal G: 真正的问题不是“报错后发生了什么”，而是“ApiHub 没有能力从 native 状态漂移中恢复”

探索结果：`这是目前最强 proposal`

原因：

- 这条链不依赖我们先找到外部触发器，也能完整解释用户现象。
- 只要 native source 被任何链路改漂，ApiHub 继续只改 model 就一定会出现“选什么都不生效”。

当前判断：

- 这是当前最值得优先修复的点。
- 即使未来再找到真正的外部触发器，这个修复仍然是必要的。

# evidence

## 1. 只有 `activateConnection()` 会完整激活一条连接

文件：[index.js](/root/SillyTavern-ApiHub/index.js)

关键逻辑在 `activateConnection()`：

- 写入 `oai_settings.custom_url / reverse_proxy / proxy_password`
- 写入 `oai_settings.custom_model / claude_model / google_model`
- 执行 `$('#chat_completion_source').val(targetSource).trigger('change')`
- 在 source 切换后再次重写 model
- 重新应用 preset / regex preset / prompt-post-processing

也就是说，只有这条路径会把 “source + endpoint + secret + model + preset相关状态” 整体拉齐。

## 2. ApiHub 的“改模型”并不会重新激活连接

文件：[index.js](/root/SillyTavern-ApiHub/index.js)

`#apihub_model_select` 的处理逻辑是：

```js
$('#apihub_model_select').on('change', async function () {
    const conn = getSelectedConnection();
    if (!conn) return;
    updateConnection(conn.id, { model: $(this).val() });
    syncModelToNative(conn);
    renderUrlPreview();
});
```

这里调用的是 `syncModelToNative(conn)`，而不是 `activateConnection(conn.id)`。

`syncModelToNative()` 只做这几件事：

- `oai_settings.custom_model = conn.model`
- 或 `oai_settings.claude_model = conn.model`
- 或 `oai_settings.google_model = conn.model`

它不会重设：

- `oai_settings.chat_completion_source`
- `oai_settings.custom_url`
- `oai_settings.reverse_proxy`
- `oai_settings.proxy_password`
- preset / regex / prompt-post-processing

所以一旦当前 ST 原生 source 已经漂了，单改 model 根本不够。

## 3. ST 实际发请求时完全依赖当前 `oai_settings`

文件：[openai.js](/root/SillyTavern/public/scripts/openai.js)

请求链是：

1. `sendOpenAIRequest()`
2. `const model = getChatCompletionModel(oai_settings);`
3. `createGenerationParameters(oai_settings, model, ...)`

而 `getChatCompletionModel()` 明确按当前 source 取模型：

- `CLAUDE -> settings.claude_model`
- `MAKERSUITE -> settings.google_model`
- `CUSTOM -> settings.custom_model`

这说明：

- 如果当前 `oai_settings.chat_completion_source` 已经变成 `makersuite`
- 那么请求会直接去读 `google_model`
- 此时你在 ApiHub 里改 `claude_model` 没意义

这和用户现象完全一致。

## 4. ApiHub 没有任何“原生状态漂移后自动校正”的监听

文件：[index.js](/root/SillyTavern-ApiHub/index.js)

当前只看到这些会触发完整激活：

- 切换连接
- 切换格式
- 修改 endpoint
- 修改 api key
- 手动保存

没看到这些保护：

- 生成开始前校正活动连接
- 生成报错后重新校正活动连接
- 原生 source/model 被外部改动后自动重新激活

因此只要 ST 原生状态在别处改掉，ApiHub 这边会长期处于“UI 还显示活动连接，但实际请求不走它”的状态。

## 5. “auto-connect to last server” 不是首要根因

文件：[RossAscends-mods.js](/root/SillyTavern/public/scripts/RossAscends-mods.js)

`RA_autoconnect()` 的行为是：

- 当 `online_status === 'no_connection' && power_user.auto_connect`
- 按当前 `main_api` 和当前 `oai_settings.chat_completion_source`
- 去触发对应 connect 按钮

它不会主动把 source 从 `claude` 改成 `makersuite`，更像是“按当前 source 重新连一次”。

所以它可能放大问题，但不像是“把 Claude 切回 Gemini”的第一触发点。

## 6. 报错后“外部漂移触发器”目前还没锁死

这部分我还没有找到直接铁证，当前只能确认：

- `sendOpenAIRequest()` 在 429/非 2xx 时会抛错
- 但我还没在主仓里找到一段非常直接的“报错后把 source 改回别的 provider”的代码

因此现在更稳妥的结论是：

- “报错”是用户稳定复现问题的触发条件
- 但真正导致问题持续存在的，是 ApiHub 缺少对 native 状态漂移的修复机制

# solution

建议按两层处理。

## 第一层：修复决定性缺陷

把所有“模型变化”入口从“只同步 model 字段”改成“重新激活整条连接”。

也就是这些场景不要再只走 `syncModelToNative()`：

- `#apihub_model_select` 变更
- Default models
- 手动 add model
- delete model

而是统一走：

```js
await activateConnection(conn.id);
```

这样即使 source/url/proxy 已经漂了，用户只要重新选一次模型，也能恢复。

## 第二层：在生成前做兜底校正

在 `GENERATION_STARTED` 或更早的合适时机，加一个检查：

- 如果 ApiHub UI 当前处于接管状态
- 且存在 `activeConnectionId`
- 但当前 `oai_settings` 与活动连接不一致
- 就先 `activateConnection(activeConnectionId)`，再让本次生成继续

这层是为了处理：

- 用户没有重新切模型，直接 roll
- 但上一轮报错后原生状态已经漂了

这样可以把“报错后下一次 roll 直接落回 native 模型”的问题堵住。

## 第三层：如果还要继续深挖，优先查这几条触发链

1. 报错后的 ST 原生 source 是否真的发生了变化  
   建议在浏览器控制台打印：
   - `oai_settings.chat_completion_source`
   - `oai_settings.claude_model`
   - `oai_settings.google_model`
   - `oai_settings.custom_model`
   - `extension_settings.apiHub.activeConnectionId`

2. `bind_preset_to_connection` 是否在报错后又套了一次 preset  
   这条链值得查，因为 ST 的 preset 加载确实能覆盖 connection 相关字段，而 ApiHub 自己已经在 `activateConnection()` 里专门写了“先套 preset，再回写连接字段”的补偿逻辑。

3. 是否有别的扩展、脚本、slash command、profile 流程在改 native source  
   目前 Connection Manager 本身没看到“报错后自动切 last server”的直接证据，但外部链路仍然可能存在。
