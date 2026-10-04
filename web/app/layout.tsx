import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "DriveProof | Dashcam Assurance",
  description: "Capture and verify dashcam evidence with SHA-256 frame fingerprints.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
