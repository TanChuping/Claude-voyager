# Claude-Voyager 安装与测试

## ⚠️ 重要：换新 ID 重装

之前的 extension ID `caabjphkficjcaaoalmjbonmbpjgbkkl` 被你浏览器里的隐私/广告
扩展拦截（所有 `chrome-extension://caabjphk.../*` 都返回 `ERR_BLOCKED_BY_CLIENT`，
GPT-Voyager 不被拦只是因为它的 ID 不在那条规则里）。

已经在 `manifest.json` 加了 `key` 字段固定为新 ID
`nbdckmogmgoagkhifnocphffpjjpmpbg`，版本升到 0.1.1。请按下面步骤重装。

## 重新安装步骤

1. 进入 `chrome://extensions/`
2. 找到 Claude-Voyager 0.1.0 那张卡片，点 **「移除」**
3. 点左上 **「加载已解压的扩展程序」**
4. 选 `D:\coding\claude voyager\dist_chrome`
5. 应该看到 Claude-Voyager **0.1.1**，ID = `nbdckmogmgoagkhifnocphffpjjpmpbg`

如果新 ID 仍然被拦截，那是隐私扩展的拦截规则太宽（很可能匹配所有未列入白名单的扩展），
请临时停用那个隐私扩展再试，或把上面这个新 ID 加进它的白名单。

## 验证

打开 https://claude.ai/chat/996ab734-4e24-451a-aaad-636b40c2593c，应看到：

- 右下角浮球（橘色花瓣图标），可拖
- 右侧 timeline 米色竖条 + 浅橘 dot + 选中深橘 dot
- 点击 dot 平滑滚到对应消息
- toolbar 注入 export 按钮

## 排错

- **「Service Worker：无效」** = 正常的待机状态（GPT-Voyager 也显示这个），SW 在没事干的时候会休眠
- 右下浮球不出现 → 看 chrome://extensions 上 Claude-Voyager 卡片的 **「错误」** 按钮（如果有）
- 内容仍然不注入 → 在 Claude 页面 F12 开 DevTools 看 Console 里有没有 `Claude-Voyager` / extension context 相关错误

## 开发循环

```bash
cd "D:\coding\claude voyager"
bun run build:chrome      # 重建 → dist_chrome/
# 然后 chrome://extensions 上点 Claude-Voyager 卡片的 ↻ 刷新按钮
```
