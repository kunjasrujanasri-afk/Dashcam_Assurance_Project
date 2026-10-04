import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dashcam Assurance | Digital Evidence Integrity Platform",
  description: "Capture, sign, transmit, and verify dashcam evidence with a traceable chain of custody.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
