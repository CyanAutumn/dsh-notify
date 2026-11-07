# dsh-notify

> DeepSeek Harness 的桌面提醒插件：任务完成、agent 提问、工具授权时提醒你，点一下通知就回到那个会话。

纯插件实现，不修改 DSH 本体，升级 DSH 不受影响。提醒走两条通道：**Windows 系统通知**（可点击回跳）和**应用内浮层卡片**。

## 特性

- **任务完成 / 出错提醒** —— 一个回合结束时提醒你回来看结果，出错时说明原因。
- **提问与授权提醒** —— agent 需要你回答问题、工具等待批准时提醒；只是旁听，不会打断或改变正常交互。
- **点击即回跳** —— 点系统通知或应用内卡片，DSH 会回到前台并切到发起这条通知的会话，不用再自己翻会话列表。
- **`/goal` 目标模式不啰嗦** —— 目标多轮续跑期间不打扰，只有目标真正完成或受阻时才提醒一次。
- **前台不打扰** —— DSH 窗口就在眼前时只出应用内卡片，不弹系统通知。
- **可配置** —— 各类提醒开关、系统通知是否要声音、卡片停留时长都能按需调整。
- **零额外依赖** —— 系统通知用的是 Windows 自带能力，不需要额外安装服务或运行时。

## 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | Desktop 版 0.1.7-rc.2 及以上 |
| 系统 | Windows 10 / 11（系统通知通道仅 Windows 提供；其它平台只出应用内卡片） |
| Node.js | 已随 DSH 提供，无需单独安装 |

## 安装

```powershell
git clone https://github.com/CyanAutumn/dsh-notify.git "$env:USERPROFILE\Desktop\dsh-notify"
pwsh -File "$env:USERPROFILE\Desktop\dsh-notify\install.ps1"
```

`install.ps1` 会完成三件事：把插件登记到当前 profile、安装依赖、注册 `dshnotify:` 链接协议（只写当前用户，不需要管理员权限）。

装完**重启 DeepSeek Harness**，再**刷新页面（Ctrl+R）**。然后在 DevTools 控制台执行：

```js
dshNotify.test({ force: true });  // 应该同时出现应用内卡片和 Windows 系统通知
```

点击那条系统通知，DSH 应该被拉到前台并停在你当前所在的会话——这就是「点击回跳」在正常工作。

## 什么时候会提醒

| 时机 | 说明 | 应用内卡片 | 系统通知 |
|---|---|---|---|
| 任务完成 | 某个会话的一个回合结束 | ✅ | ✅（窗口在前台时跳过） |
| 任务出错 | 会话报错 | ✅ | ✅（窗口在前台时跳过） |
| 需要你回答 | agent 调用提问工具、计划复核 | ✅ | — |
| 需要授权 | 工具调用等待批准 | ✅ | — |

### 关于 `/goal` 目标模式

`/goal` 是「一个目标 + 多轮续跑」，每推进一步都会结束一个回合。插件只看**目标本身**的状态：

- 目标还在跑 → 不提醒（避免每推进一小步就弹一次）；
- 目标完成 → 提醒一次「目标已完成」；
- 目标受阻 → 提醒一次「目标受阻」并带上原因；
- 普通会话（没有目标）→ 就是上面的「任务完成」提醒。

提问、授权、报错不受这条规则影响，仍然即时提醒。

## 点击通知会发生什么

- **系统通知**：点通知正文或其中「回到会话」按钮，都会把 DSH 主窗口还原到前台，并切到发起这条通知的会话。
- **应用内卡片**：点卡片同样会跳转，卡片右上角 `×` 只关闭卡片。
- **测试通知**（`dshNotify.test()`，没有绑定会话）：只会把窗口提到前台，不切会话。

## 配置

所有开关保存在浏览器 `localStorage`（键名 `dsh-notify:config`），按浏览器配置档生效。在 DevTools 控制台执行即可：

```js
dshNotify.config({ onlyWhenUnfocused: false }); // 窗口在前台也弹系统通知
dshNotify.config({ sound: true });              // 系统通知带提示音
dshNotify.config({ showToast: false });         // 关掉应用内卡片，只留系统通知
dshNotify.config({ onQuestion: false });        // 关闭提问 / 授权提醒
dshNotify.config({ onComplete: false });        // 关闭任务完成提醒
dshNotify.config({ enabled: false });           // 全部关闭
dshNotify.config;                               // 查看当前配置
```

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `onComplete` | `true` | 任务完成提醒 |
| `onError` | `true` | 任务出错提醒 |
| `onQuestion` | `true` | 提问 / 授权提醒 |
| `showToast` | `true` | 应用内卡片 |
| `sound` | `false` | 系统通知是否带声音 |
| `onlyWhenUnfocused` | `true` | 只在窗口失焦时弹系统通知 |
| `toastMs` | `15000` | 普通卡片停留时长（毫秒） |

系统通知的文案可以用环境变量覆盖（改完重启 DSH 生效）：

| 变量 | 作用 |
|---|---|
| `DSH_NOTIFY_TOAST_TITLE` | 覆盖通知标题（默认用会话标题） |
| `DSH_NOTIFY_TOAST_BODY` | 覆盖通知正文 |
| `DSH_NOTIFY_TOAST_SOUND=1` | 通知带提示音 |
| `DSH_NOTIFY_DRY=1` | 只记录不真发通知（调试用） |

## 自检与诊断

插件不在界面上放任何按钮，一切自检都在 DevTools 控制台：

```js
dshNotify.test();          // 按当前焦点规则投递一条测试通知
dshNotify.test({ force: true }); // 强制两条通道一起发
dshNotify.diag();          // 事件计数、跳转服务、最近一次交付、目标抑制统计
dshNotify.endpoint();      // 后台侧状态：链接协议、待处理跳转、上次通知
```

## 常见问题

**应用内卡片有，但系统通知不出现**
DSH 窗口在前台时本来就不弹系统通知（`onlyWhenUnfocused`）；先切走窗口或执行 `dshNotify.test({ force: true })` 验证。仍然没有的话，检查 Windows「设置 → 系统 → 通知」里 DeepSeek Harness 的通知开关是否打开，以及是否开了「专注助手」。

**点了系统通知没反应**
通常是没有重启 DSH（协议在启动时登记），或协议被清理掉了。重启 DSH 或重新跑一次 `install.ps1` 即可；`dshNotify.endpoint()` 里的 `protocol` 应为 `registered`。

**`/goal` 仍然每轮都提醒**
确认插件版本是 0.3.1 或更新：`dshNotify.diag()` 之外可以看插件页显示的版本号。旧版本没有目标模式判断。

**通知标题显示成「会话 xxxxxxxx」**
这个会话还没有生成标题（通常是刚建立、还没聊几句），直接用会话的短 id 代替。

**卸载后搜索/按钮还在**
客户端插件要刷新页面或重启 DSH 才会从页面卸载。

## 卸载

1. 从 profile 的 `package.json` 里删掉 `dsh-notify`（`dependencies` 与 `dsh.profile.bundles` 两处），再执行 `pnpm install`；
2. 移除链接协议：

```powershell
pwsh -File install.ps1 -UnregisterProtocol
```

## 许可

MIT
