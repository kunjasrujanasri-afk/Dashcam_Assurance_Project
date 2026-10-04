import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CloudDash | Secure Dashcam Evidence",
  description: "Capture, sign, transmit, and verify dashcam evidence with a traceable chain of custody.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
