import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "墨听阅读器",
  description: "导入一本书，既可以阅读，也可以继续听。",
  applicationName: "墨听",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon-512.png",
    shortcut: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

/**
 * 开机脚本：第一帧之前按上次的配色给 <html> 套上书架主题、阅读主题和状态栏颜色。
 *
 * 配色存在本地库里，要等 JS 起来、库读完才知道；那时第一帧早按默认的冷灰画出去了，
 * 每次打开都先闪一下默认色再翻成用户的颜色。MotingApp 每次改配色都会把
 * { shell, reader, paper, readerBackground } 记进 localStorage 的 moting:theme，这里只读它。
 * 上次停在阅读器里的话，底色直接用书页的颜色（html[data-in-reader]）。
 */
const THEME_BOOT = `(function(){try{
var d=document.documentElement;
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
          content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="墨听" />
        {/* 初始值对应默认书架「霜白」，开机脚本按上次的配色改写。 */}
        <meta name="theme-color" content="#f3f4f7" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
