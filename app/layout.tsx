import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "F.E.A.R. Console",
  description: "Desktop AI assistant command console for F.E.A.R.",
};

// Resolve the theme before first paint: a manually saved choice wins; otherwise
// follow the OS preference; otherwise fall back to dark (F.E.A.R.'s canonical
// look). Runs in <head> via beforeInteractive so there's no wrong-theme flash.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('fear-theme');if(t!=='light'&&t!=='dark'){t=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}var e=document.documentElement;e.classList.remove('light','dark');e.classList.add(t);}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // No theme class in the JSX: the script owns it (React would otherwise revert
  // it on hydration). :root defaults to dark, so JS-off falls back to dark.
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <body>
        <Script id="fear-theme-init" strategy="beforeInteractive">
          {THEME_INIT}
        </Script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
