import type { Metadata, Viewport } from "next";
import "./globals.css";

/**
 * 框架会给每个页面补一条默认 viewport（width=device-width, initial-scale=1）。
 * 不导出这个常量，线上 <head> 里就会同时存在两条 viewport：先出现的默认那条
 * 既没有 viewport-fit=cover 也没有禁用缩放，iOS 按它算的话，整个安全区
 * （env(safe-area-inset-*)）会归零，刘海和 Home 条那块就没人管了。
 * 导出之后默认那条被顶掉，下面的手写标记再补上 vinext 会丢的 viewportFit。
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "墨听阅读器",
  description: "导入一本书，既可以阅读，也可以继续听。",
  applicationName: "墨听",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon-512.png",
    shortcut: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
};

/**
 * 平台会照 layout 导出的 viewport 常量自己发一条 <meta name="viewport">，它排在
 * 手写的那条之前，而 vinext 会把 `viewportFit` 整个丢掉。多条 viewport 时按哪条算
 * 取决于浏览器和先后顺序，只要错拿到前一条，安全区就归零、导航栏那块又黑回去。
 * 最稳的做法不是赌顺序，而是开机时把所有 viewport 都改写成同一条；两条一样就无所谓谁赢。
 * 字符串只此一份，跟下面的手写标记共用同一个值。
 */
const VIEWPORT_CONTENT =
  "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover";

/**
 * 开机脚本：第一帧之前按上次的配色给 <html> 套上书架主题、阅读主题和状态栏颜色。
 *
 * 配色存在本地库里，要等 JS 起来、库读完才知道；那时第一帧早按默认的冷灰画出去了，
 * 每次打开都先闪一下默认色再翻成用户的颜色。MotingApp 每次改配色都会把
 * { shell, reader, paper, readerBackground } 记进 localStorage 的 moting:theme，这里只读它。
 * 上次停在阅读器里的话，底色直接用书页的颜色（html[data-in-reader]）。
 */
/**
 * 开机脚本：第一帧之前把 setuo 该做的三件事都做了。
 *
 * 1. 宋体子集（/fonts.css，200 条 @font-face、62KB gz）晚一步加载。外壳界面一律黑体，
 *    用不到它，放在首屏样式里只会让每次冷启动多等一截。这里是普通 <script>，
 *    服务端组件传不了 onLoad，media="print" 换 all 那招用不了。
 * 2. 把每一条 viewport 改成同一条：平台按 viewport 常量又发了一条，vinext 把 viewportFit
 *    丢了，两条不一样时抢到哪条就看浏览器脸色，抢错安全区就归零。
 * 3. 按上次的配色给 <html> 套主题（配色存在本地库里，等 JS 起来才知道，
 *    那时第一帧早按默认冷灰画出去了）。
 */
const THEME_BOOT = `(function(){try{
var d=document.documentElement;
var fl=document.createElement("link");fl.rel="stylesheet";fl.href="/fonts.css";document.head.appendChild(fl);
var vp=document.querySelectorAll('meta[name="viewport"]');
for(var i=0;i<vp.length;i++)vp[i].setAttribute("content",${JSON.stringify(VIEWPORT_CONTENT)});
var t=JSON.parse(localStorage.getItem("moting:theme")||"null")||{};
var v=JSON.parse(localStorage.getItem("moting:last-view")||"null");
var inReader=!!(v&&v.name==="reader");
if(t.shell)d.setAttribute("data-shell",t.shell);
d.setAttribute("data-reader-theme",t.reader||"original");
if(inReader)d.setAttribute("data-in-reader","");
var c=inReader?t.readerBackground:t.paper;
var m=document.querySelector('meta[name="theme-color"]');
if(m&&c)m.setAttribute("content",c);
}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // 开机脚本会在 React 接手之前往 <html> 上写配色属性，水合时别把它当成不一致。
    <html lang="zh-CN" suppressHydrationWarning>
      {/* 这几个标签必须手写。vinext 的 Metadata/Viewport API 是残缺实现：
          `viewportFit: "cover"` 会被整个丢掉，`appleWebApp.capable` 会被错译成
          第二个 mobile-web-app-capable。少了 viewport-fit=cover，视口就不会铺进
          安全区，env(safe-area-inset-top) 恒等于 0，iOS 自己保留状态栏那条并涂成
          系统色——全站的刘海黑条就是这么来的。 */}
      <head>
        <meta
          name="viewport"
          content={VIEWPORT_CONTENT}
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="墨听" />
        {/* 初始值对应默认书架「软白」，开机脚本按上次的配色改写。 */}
        <meta name="theme-color" content="#fafbfd" />
        {/* 宋体子集由开机脚本注入（/fonts.css），不进首屏样式：外壳一律黑体，用不到它。
            JS 关掉时退回阻塞加载，字形和应用功能都还在。 */}
        <noscript>
          {/* eslint-disable-next-line @next/next/no-css-tags */}
          <link rel="stylesheet" href="/fonts.css" />
        </noscript>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
