import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EM Battery Monitor",
  description: "Live battery pack telemetry - Exergi Murphy Power Solutions",
  icons: { icon: "/em-logo.png" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
