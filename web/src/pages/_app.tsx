import "@/styles/globals.css";
import type { AppProps } from "next/app";
import { AccountGate } from "@/components/account-gate";

export default function App({ Component, pageProps }: AppProps) {
  return <div className="assurance-ui"><AccountGate><Component {...pageProps} /></AccountGate></div>;
}
