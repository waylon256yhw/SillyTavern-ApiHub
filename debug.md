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

---

# bug

这次用户反馈的现象不是“迁移出来的连接显示错了”，而是：

1. 迁移后，ApiHub 里确实出现了一条 Anthropic 连接，endpoint 是 `https://clewdr.moonlightyume.com`。
2. 但 ST 实际请求时使用的仍然是 native UI 里残留的 `https://clawdr.moonlightyume.com/code/v1`。
3. 也就是说，`ApiHub 已保存的活动连接` 和 `ST 当前原生生效运行态` 在这个 case 里是分离的。

这会表现为：

- 用户在 ApiHub 里看到的连接配置是 `clewdr...`
- 但真正发请求时走的是 `clawdr.../code/v1`
- provider 仍然是 `claude`
- 连模型也没有完全跟随 ApiHub 当前连接

# proposal

当前最可信的根因假设是：

`迁移流程只把连接“导入到 ApiHub 设置里”，但没有保证导入后的活动连接立刻接管 ST 的原生运行态；同时插件初始化恢复时，也没有把已保存的 activeConnection 重新回放到 native runtime。`

更具体地说：

- `activateConnection()` 才是“完整接管”的唯一路径。
- `migrateFromNative()` 当前只会 `saveSettingsDebounced()` + `renderUI()`，不会自动 `activateConnection()`。
- `restoreState()` 当前也只做数据清理和 `renderUI()`，不会把已保存的 `activeConnectionId` 同步回 `oai_settings`。
- 所以只要 native runtime 在迁移前已经是别的 endpoint，迁移完成后即使 ApiHub UI 里已经有了新连接，实际请求仍然可能继续走旧的 native endpoint。

这次 debug 包里最关键的事实是：

- ApiHub 的活动连接已经是 `clewdrhub`
- 但 native runtime 里的 `reverse_proxy` 仍然是 `clawdr.moonlightyume.com/code/v1`
- 同时 `claude_model` 也是旧值 `claude-opus-4-6`，而不是活动连接里的 `claude-opus-4-7`

这说明问题不是“只差一个 URL 尾巴”，而是整条 Anthropic 运行态并没有被当前活动连接接管。

## explored proposals

### proposal A: 迁移时 endpoint 本身就导错了

探索结果：`当前 debug 包不能直接证明，但代码里确实存在次级风险`

原因：

- 当前迁移逻辑对 `non-openai + profile.proxy` 的 profile，会优先取 `proxyPreset.url` 作为 endpoint。
- 如果某些 Anthropic 原生配置里，proxy preset 只是 native UI 的转发端点，而 `api-url` 才是用户真正想保留的上游地址，那么迁移出来的 endpoint 就有可能被导成内部转发地址。

但这次 case 里：

- debug 包中的 ApiHub 连接已经是 `clewdr...`
- native proxies 里同名 `自用max` 记录却是 `clawdr.../code/v1`

因此当前更稳妥的判断是：

- “当前请求走错地址”这件事，已经可以被“活动连接没有接管运行态”完整解释
- “迁移时是否还存在错误偏向 proxy URL 的问题”值得继续保留为次级风险，但这份 debug 还不足以单独坐实它就是本次主因

### proposal B: 真正的问题是迁移/恢复后没有接管 native runtime

探索结果：`这是目前最强结论`

原因：

- 这条链可以直接解释为什么 ApiHub 里显示的是 `clewdr...`，但请求仍然发到 `clawdr.../code/v1`
- 也可以解释为什么连模型都没有同步成活动连接里的 `claude-opus-4-7`
- 并且它和当前代码路径是一一对应的，不需要再额外假设“还有别的地方偷偷改了 URL”

# evidence

## 1. 当前活动连接和 native runtime 明确不一致

文件：[apihub-debug-1776933064106.json](/root/SillyTavern-ApiHub/apihub-debug-1776933064106.json:223)

调试文件里：

- ApiHub 连接 `自用max` 是 `format: "anthropic"`，endpoint 为 `https://clewdr.moonlightyume.com/`
- 另一条活动连接 `clewdrhub` 也是 `format: "anthropic"`，endpoint 为 `https://clewdr.moonlightyume.com`
- `activeConnectionId` 指向的是 `clewdrhub`

但同一个 debug 文件里 native runtime 是：

- `chat_completion_source: "claude"`
- `reverse_proxy: "https://clawdr.moonlightyume.com/code/v1"`
- `claude_model: "claude-opus-4-6"`

对应位置见：[apihub-debug-1776933064106.json](/root/SillyTavern-ApiHub/apihub-debug-1776933064106.json:277)

这已经足够说明：

- ApiHub 当前活动连接不是 native runtime 正在使用的那条 Anthropic 配置

## 2. `activateConnection()` 才会完整接管 source / endpoint / model / key

文件：[index.js](/root/SillyTavern-ApiHub/index.js:714)

`activateConnection()` 会：

- 标记 `activeConnectionId`
- 先应用 preset
- 再调用 `syncConnectionRuntime(conn)`
- 最后再应用 regex preset 和 prompt post-processing

而 `syncConnectionRuntime()` 会真正写回：

- `oai_settings.reverse_proxy`
- `oai_settings.proxy_password`
- `oai_settings.claude_model`
- `#chat_completion_source`

也就是说，只有走到这条路径，ST 的原生运行态才会被当前连接完整覆盖。

## 3. `migrateFromNative()` 迁移成功后并不会激活任何连接

文件：[index.js](/root/SillyTavern-ApiHub/index.js:1481)

当前迁移逻辑在导入完成后只做：

- `saveSettingsDebounced()`
- `renderUI()`
- `toastr.success(...)`

对应代码见：[index.js](/root/SillyTavern-ApiHub/index.js:1621)

这里没有：

- `activateConnection(...)`
- `syncConnectionRuntime(...)`
- 把某条迁移出的连接选中并接管当前原生运行态

因此“迁移出来了，但请求仍然走旧 native endpoint”完全符合当前实现。

## 4. 插件初始化恢复时，也不会把已保存活动连接重新写回 native runtime

文件：[index.js](/root/SillyTavern-ApiHub/index.js:2114)

`restoreState()` 当前只做：

- 首次默认连接初始化
- 旧字段清理
- `renderUI()`

它不会：

- 读取 `activeConnectionId`
- 重新 `activateConnection(activeConnectionId)`

这意味着即使上一次保存的活动连接已经是正确的 `clewdr...`，只要页面刷新或扩展初始化时 native runtime 里还残留 `clawdr.../code/v1`，两边就会继续分离。

## 5. 当前虽然有生成前修复钩子，但它不能替代初始化/迁移接管

文件：[index.js](/root/SillyTavern-ApiHub/index.js:2169)

当前代码确实注册了：

```js
eventSource.on(event_types.GENERATION_STARTED, repairActiveConnectionBeforeGeneration);
```

这说明插件作者已经意识到“运行态可能漂移”。

但这次 case 仍然暴露出两个问题：

- steady state 上，UI 和 native runtime 可以长期不一致
- 用户在真正发起请求前，并不能保证这条修复链一定已经把状态拉齐

因此迁移完成后的“立即接管”与初始化时的“恢复接管”仍然是必要修复。

## 6. 迁移逻辑对 Anthropic `proxy` 的 endpoint 选择仍值得继续审查

文件：[index.js](/root/SillyTavern-ApiHub/index.js:1540)

当前代码在 `format !== 'openai' && profile.proxy` 时，会优先使用：

```js
const proxyPreset = proxies.find(p => p.name === profile.proxy);
endpoint = proxyPreset.url.trim();
```

这意味着：

- 只要 profile 带了 `proxy`
- 且该 proxy preset 的 URL 不是用户真正想迁移的上游地址
- ApiHub 就可能把“native 转发端点”误当成最终 endpoint 保存下来

这点和本次用户描述有一定吻合度，但当前 debug 包里还缺“那条被迁移 profile 的原始 api-url / proxy 组合”，所以暂时只能记为次级风险。

# solution

建议按两层处理。

## 第一层：修复迁移后不接管运行态的问题

在 `migrateFromNative()` 成功后：

- 至少应当把第一条或最后一条迁移出的连接选中
- 并显式调用 `activateConnection(...)`

这样迁移结束时，用户看到的配置和 ST 真正发请求的运行态才能保持一致。

## 第二层：修复初始化恢复时不接管运行态的问题

在 `restoreState()` 完成 `renderUI()` 后：

- 如果存在 `activeConnectionId`
- 就重新执行一次 `activateConnection(activeConnectionId)`，或者至少 `syncConnectionRuntime(activeConn)`

这样即使刷新页面、重新载入扩展、或者 native runtime 里还残留旧的 endpoint，也能在扩展初始化时把当前活动连接重新接管回来。

## 第三层：继续审查 Anthropic 迁移时的 endpoint 选择策略

如果后续还发现“迁移出来的 endpoint 本身就错了”，优先核对：

1. 原始 CM profile 的 `api-url`
2. 原始 CM profile 的 `proxy`
3. 对应 proxy preset 的 `url`

如果 `proxyPreset.url` 是 native 内部转发地址，而 `api-url` 才是用户配置的真实 Anthropic 兼容端点，那么当前“非 openai 且有 proxy 时优先吃 proxy URL”的逻辑就需要收紧。
