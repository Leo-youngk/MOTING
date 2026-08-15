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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
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
        {/* 初始值对应默认书架「霜白」，之后由客户端按当前主题改写。 */}
        <meta name="theme-color" content="#f3f4f7" />
      </head>
      <body>{children}</body>
    </html>
  );
}
