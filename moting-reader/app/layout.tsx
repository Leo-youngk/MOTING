import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "墨听阅读器",
  description: "导入一本书，既可以阅读，也可以继续听。",
  applicationName: "墨听",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "墨听",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
  icons: {
    icon: "/icon-512.png",
    shortcut: "/icon-192.png",
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // 初始值对应默认书架「霜白」。iOS 用它给状态栏那条填色，
  // 换书架或翻开书后由客户端改写，状态栏才不会跟页面裂成两块。
  themeColor: "#f3f4f7",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
