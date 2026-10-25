# iPhone Pro Max 界面适配

基于主分支 `226754418cca6a05efe862b83399f291ee678477`。

## 布局原则

使用浏览器报告的实际视口与四边安全区适配 iPhone 18 Pro Max，同时兼容显示缩放和其它屏幕。竖屏书架保持三列，阅读字号和版心继续由阅读设置控制。

| 区域 | 调整 |
| --- | --- |
| 底栏、迷你播放器 | 完整避开 Home 指示条；共用底边距离，页面末尾同步预留空间。 |
| 阅读器、设置、在线找书 | 加入横屏左右安全区。目录去掉重复的顶部安全区，底部列表避开 Home 指示条。 |
| 播放器 | 根据可用高度调整封面。短横屏将封面和操作并排，横放手机使用触屏布局。 |
| 小按钮、滑杆 | 书籍更多、播放、迷你播放器、阅读菜单、AI 发送和滑杆等使用至少 44 CSS px 的触控区域。 |
| AI 对话与表单 | 软键盘打开时同时适配视觉视口的高度与顶部偏移，输入框避开键盘；地址栏缩放和捏合缩放不会触发键盘布局。 |

安全区统一定义在 `app/globals.css` 的 `--safe-*`，浮条定位的 `useSafeInsets` 也从同一组变量读取。保留现有 PWA 视口补偿，以处理 standalone 布局视口偶发的底部缺口。

## 验证

- `npm run typecheck`、`npm run lint`。
- `npm test`：生产构建、产物校验和 362 项现有测试。
- `npx wrangler deploy --dry-run --config dist/server/wrangler.json`：上传包预检。
- `tests/mobile-layout-browser.mjs`：真实页面与 IndexedDB，375/390/430/440 宽竖屏、796 高浏览器视口、左右旋转、956/980/844 宽短横屏和 1024×768 桌面布局。
- 对话覆盖长输入、视觉视口平移、底部遮挡为零但键盘仍打开、收键盘动画、地址栏和捏合缩放；表单覆盖账号弹层；迷你播放器覆盖底栏间距、按钮尺寸及键盘时隐藏。
- `tests/navigation-browser.mjs`：375/390/430/900 宽的切页、返回位置和弹层回收；`tests/reader-scroll-browser.py`：目录跳转、向上和向下惯性滚动；`tests/reader-selection-browser.py`：375/390/430 宽的长按、跨段选择、划线及旋转。以上均通过，划词脚本仅在运行时将 Edge 启动参数换为本机 Chromium 路径。

自动化用例用 62/34/21 CSS px 等数值模拟安全区。这些是验证夹具，界面不会把它们当成机型参数。Linux 截图可通过 `TEST_FONT_DIR` 提供本地 Noto Sans SC，iPhone 上仍使用设备系统字体。

运行新增浏览器检查：

```bash
BROWSER_PATH=/path/to/chromium node tests/mobile-layout-browser.mjs http://127.0.0.1:5173
```

浏览器检查使用隔离的本地实例和模拟上游。Chromium 的尺寸与键盘模拟不能替代 iPhone 18 Pro Max 真机验收：发布后仍需在 Safari 与主屏幕 PWA 中确认键盘收起、双向旋转、安全区及系统显示缩放。

参考：[WebKit 安全区说明](https://webkit.org/blog/7929/designing-websites-for-iphone-x/)、[动态视口单位](https://webkit.org/blog/12445/new-webkit-features-in-safari-15-4/)。
