import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "F.E.A.R. Console",
  description: "Desktop AI assistant command console for F.E.A.R.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" className="dark">
      <body>{children}</body>
    </html>
  );
}
